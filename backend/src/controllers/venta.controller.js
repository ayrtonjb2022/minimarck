const {
  Venta,
  VentaDetalle,
  Producto,
  Caja,
  MovimientoCaja,
  User,
  ClienteDeudor, // ✅ Agregado
} = require("../models/index");
const { success, error, paginated } = require("../utils/response");
const { todayArgentina } = require("../utils/date");
const { Op } = require("sequelize");
const sequelize = require("../config/database");
const crypto = require("crypto");

/**
 * Detecta si un error de Sequelize corresponde a una violación del índice
 * único de idempotencia (negocio_id + idempotency_key).
 */
const esDuplicadoIdempotencia = (err) => {
  if (err.name === "SequelizeUniqueConstraintError") {
    const fields = err.fields || {};
    if ("idempotency_key" in fields || "idempotencyKey" in fields) return true;
  }
  if (err.parent && err.parent.code === "ER_DUP_ENTRY") {
    // El nombre del índice único difiere según el origen: la migración lo llama
    // `uq_ventas_negocio_idempotency` y un sync() fresco `ventas_negocio_id_idempotency_key`.
    // Detectar por subcadenas que matcheen AMBOS nombres, no solo /idempotency_key/.
    const sqlMessage = String(err.sqlMessage || err.parent.sqlMessage || "");
    const fieldsJson = JSON.stringify(err.fields || err.parent.fields || {});
    const sql = String(err.sql || err.parent.sql || "");
    return (
      /idempotency/i.test(sqlMessage) ||
      /idempotency/i.test(fieldsJson) ||
      /idempotency/i.test(sql)
    );
  }
  return false;
};

/**
 * Registrar una nueva venta
 * POST /api/ventas
 */
const create = async (req, res) => {
  const transaction = await sequelize.transaction();

  try {
    const {
      items,
      metodoPago,
      clienteNombre,
      clienteDocumento,
      clienteDeudorId, // ✅ Agregado
      observaciones,
      idempotencyKey,
    } = req.body;

    // Validaciones
    if (!items || !Array.isArray(items) || items.length === 0) {
      await transaction.rollback();
      return error(res, "La venta debe tener al menos un producto", 400);
    }

    // "Mixto" requiere un desglose efectivo/crédito que el POS aún no recolecta
    if (metodoPago === "mixto") {
      await transaction.rollback();
      return error(
        res,
        "Método mixto requiere desglose efectivo/crédito, aún no soportado",
        400,
      );
    }

    // Crédito sin deudor: rechazar en vez de registrar una venta huérfana
    // (sin deuda asociada ni movimiento de caja, agujero de ingresos)
    if (metodoPago === "credito" && !clienteDeudorId) {
      await transaction.rollback();
      return error(res, "Venta a crédito requiere deudor", 400);
    }

    // El descuento no se aplica en ninguna parte del flujo: rechazarlo en vez
    // de guardarlo sin aplicar (cobraría de más al cliente)
    if (req.body.descuento != null && parseFloat(req.body.descuento) !== 0) {
      await transaction.rollback();
      return error(res, "Descuento aún no soportado", 400);
    }

    // Validación de items ANTES de tocar la base
    for (const item of items) {
      if (item.descuento != null && parseFloat(item.descuento) !== 0) {
        await transaction.rollback();
        return error(res, "Descuento aún no soportado", 400);
      }
      const cant = Number(item.cantidad);
      if (!Number.isFinite(cant) || !Number.isInteger(cant) || cant < 1) {
        await transaction.rollback();
        return error(res, "Cantidad inválida", 400);
      }
    }

    // Idempotencia: si esta composición de ticket ya se registró (reintento
    // tras error de red), devolver la venta existente sin crear nada
    if (idempotencyKey) {
      const existente = await Venta.findOne({
        where: {
          negocioId: req.businessId || req.user?.negocioId,
          idempotencyKey,
        },
        transaction,
      });
      if (existente) {
        await transaction.rollback();
        return success(res, { venta: existente, duplicado: true });
      }
    }

    // Verificar stock y calcular totales
    let subtotal = 0;
    const detalles = [];

    for (const item of items) {
      const cantidad = Number(item.cantidad);
      const precioUnitario = item.precioUnitario
        ? parseFloat(item.precioUnitario)
        : 0;

      let producto = null;
      if (item.productoId) {
        producto = await Producto.findOne({
          where: {
            id: item.productoId,
            negocioId: req.businessId || req.user?.negocioId,
          },
          transaction,
        });
        if (!producto) {
          await transaction.rollback();
          return error(
            res,
            `Producto con ID ${item.productoId} no encontrado`,
            400,
          );
        }
      }

      const precioFinal = item.precioUnitario
        ? parseFloat(item.precioUnitario)
        : producto
          ? parseFloat(producto.precio)
          : 0;
      const nombreItem = item.nombre || producto?.nombre || "Producto sin nombre";
      const subtotalItem = precioFinal * cantidad;
      subtotal += subtotalItem;

      detalles.push({
        productoId: producto ? producto.id : null,
        nombreProducto: nombreItem,
        cantidad,
        precioUnitario: precioFinal,
        // Costo real de la línea: ventas libres/enviadas desde el POS llevan
        // costoUnitario propio; si no viene, se toma el costo del producto
        costoUnitario:
          item.costoUnitario != null
            ? parseFloat(item.costoUnitario)
            : producto
              ? parseFloat(producto.precioCompra || 0)
              : 0,
        descuento: 0,
        subtotal: subtotalItem,
        ivaPorcentaje: producto ? parseFloat(producto.ivaPorcentaje) || 0 : 0,
      });
    }

    // IVA EXTRAÍDO del precio final: el cliente paga exactamente lo mostrado
    // (subtotal), nunca se suma IVA encima. imp = base - base/(1 + pct/100)
    // con base = precioUnitario × cantidad; pct <= 0 no aporta IVA.
    const ivaBruto = detalles.reduce((sum, det) => {
      const base = det.precioUnitario * det.cantidad;
      const pct = parseFloat(det.ivaPorcentaje) || 0;
      if (pct <= 0) return sum;
      return sum + (base - base / (1 + pct / 100));
    }, 0);
    const iva = Math.round((ivaBruto + Number.EPSILON) * 100) / 100;
    const total = subtotal; // Monto cobrado = subtotal (el IVA es informativo)
    const folio = `V-${crypto.randomUUID()}`;

    // Crear venta
    let venta;
    try {
      venta = await Venta.create(
        {
          folio,
          fecha: todayArgentina(),
          subtotal,
          iva,
          descuento: 0,
          total,
          metodoPago: metodoPago || "efectivo",
          clienteNombre: clienteNombre || null,
          clienteDocumento: clienteDocumento || null,
          observaciones: observaciones || null,
          estado: "completada",
          negocioId: req.businessId || req.user?.negocioId,
          userId: req.userId,
          // ✅ Guardar deudorId si es crédito
          deudorId:
            metodoPago === "credito" && clienteDeudorId ? clienteDeudorId : null,
          // Clave de idempotencia: el índice único (negocio_id, idempotency_key)
          // es el backstop si dos solicitudes concurrentes usan la misma clave
          idempotencyKey: idempotencyKey || null,
        },
        { transaction },
      );
    } catch (err) {
      // Violación del índice único de idempotencia: otra solicitud con la misma
      // clave ganó la carrera → devolver la venta existente en vez de un 500
      if (esDuplicadoIdempotencia(err)) {
        try { await transaction.rollback(); } catch (_) {}
        const existente = await Venta.findOne({
          where: {
            negocioId: req.businessId || req.user?.negocioId,
            idempotencyKey,
          },
        });
        if (existente) {
          return success(res, { venta: existente, duplicado: true });
        }
      }
      throw err;
    }

    // Crear detalles y descontar stock
    for (const detalle of detalles) {
      await VentaDetalle.create(
        {
          ...detalle,
          ventaId: venta.id,
        },
        { transaction },
      );

      if (detalle.productoId) {
        const [affected] = await Producto.update(
          { stock: sequelize.literal(`stock - ${detalle.cantidad}`) },
          {
            where: {
              id: detalle.productoId,
              negocioId: req.businessId || req.user?.negocioId,
              stock: { [Op.gte]: detalle.cantidad },
            },
            transaction,
          }
        );
        if (affected === 0) {
          // El producto SÍ se encontró antes (lookup previo); si el update con
          // guarda `stock >= cantidad` afectó 0 filas la causa real es stock
          // insuficiente (stale cache o venta concurrente), no un 404.
          await transaction.rollback();
          return error(
            res,
            `Stock insuficiente para ${detalle.nombreProducto || `ID ${detalle.productoId}`}`,
            400,
          );
        }
      }
    }

    // Si es venta a crédito, actualizar la deuda y notas del deudor
    if (metodoPago === "credito" && clienteDeudorId) {
      const deudor = await ClienteDeudor.findOne({
        where: { id: clienteDeudorId, negocioId: req.businessId || req.user?.negocioId },
        // Lock de fila: dos ventas a crédito concurrentes al MISMO deudor
        // leerían la misma deudaPendiente y la segunda pisaría a la primera
        // (lost update). Con el lock el read→update queda serializado.
        lock: transaction.LOCK.UPDATE,
        transaction,
      });

      // Crédito contra un deudor inexistente: rechazar en vez de registrar
      // la venta sin registrar la deuda
      if (!deudor) {
        await transaction.rollback();
        return error(res, "Deudor no encontrado", 400);
      }

      const totalVenta = total;
      const nuevaDeuda = parseFloat(deudor.deudaPendiente) + totalVenta;
      const advertenciaLimite =
        deudor.limiteCredito && nuevaDeuda > parseFloat(deudor.limiteCredito)
          ? `Atención: esta venta supera el límite de crédito ($${parseFloat(deudor.limiteCredito).toFixed(2)}). Deuda total: $${nuevaDeuda.toFixed(2)}`
          : null;

      // Construir detalle de productos para la nota
      const lineas = detalles.map(
        (d) =>
          `${d.cantidad}x ${d.nombreProducto} ($${parseFloat(d.precioUnitario).toFixed(2)} c/u) = $${d.subtotal.toFixed(2)}`,
      );
      const detalleTexto = [`[${new Date().toLocaleDateString("es-AR")}] Venta ${folio} - Total: $${totalVenta.toFixed(2)}`, ...lineas].join("\n");
      const notasPrevias = deudor.notas ? deudor.notas + "\n\n" : "";

      await deudor.update(
        {
          deudaTotal: parseFloat(deudor.deudaTotal) + totalVenta,
          deudaPendiente: nuevaDeuda,
          notas: notasPrevias + detalleTexto,
        },
        { transaction },
      );

      // Adjuntar advertencia a la respuesta
      if (advertenciaLimite) {
        venta.dataValues.advertenciaLimite = advertenciaLimite;
      }
    }

    // Registrar en caja si está abierta (solo para pagos NO crédito)
    let ventaCajaId = null;
    if (metodoPago !== "credito") {
      // Lock de fila sobre la caja abierta: un cierre de caja concurrente no
      // puede completarse mientras esta venta incrementa totalIngresos (un
      // SELECT sin lock en REPEATABLE READ vería la caja "abierta" y escribiría
      // sobre una caja cerrada cuyo saldoFinal no la incluye). Tras el lock,
      // re-chequear estado: si la caja se cerró, tratarla como "sin caja".
      const cajaAbierta = await Caja.findOne({
        where: {
          negocioId: req.businessId || req.user?.negocioId,
          estado: "abierta",
        },
        lock: transaction.LOCK.UPDATE,
        transaction,
      });

      if (cajaAbierta && cajaAbierta.estado === "abierta") {
        ventaCajaId = cajaAbierta.id;
        const saldoActual =
          parseFloat(cajaAbierta.saldoInicial) +
          parseFloat(cajaAbierta.totalIngresos) -
          parseFloat(cajaAbierta.totalEgresos);

        await MovimientoCaja.create(
          {
            tipo: "ingreso",
            concepto: `Venta ${folio}`,
            monto: total,
            saldoAnterior: saldoActual,
            saldoNuevo: saldoActual + parseFloat(total),
            referencia: folio,
            negocioId: req.businessId || req.user?.negocioId,
            cajaId: cajaAbierta.id,
            userId: req.userId,
            ventaId: venta.id,
          },
          { transaction },
        );

        await cajaAbierta.increment("totalIngresos", {
          by: total,
          transaction,
        });
      }
    }

    // Asociar cajaId a la venta
    if (ventaCajaId) {
      await venta.update({ cajaId: ventaCajaId }, { transaction });
    }

    await transaction.commit();

    const ventaCompleta = await Venta.findByPk(venta.id, {
      include: [
        {
          model: VentaDetalle,
          as: "detalles",
          include: [
            {
              model: Producto,
              as: "producto",
              attributes: ["id", "nombre", "codigo"],
            },
          ],
        },
        {
          model: User,
          as: "usuario",
          attributes: ["id", "nombre", "email"],
        },
        {
          model: ClienteDeudor, // ✅ Incluir deudor en la respuesta
          as: "deudor",
          attributes: ["id", "nombre", "deudaTotal", "deudaPendiente"],
        },
      ],
    });

    // La advertencia de límite de crédito se adjuntó a la instancia previa al
    // refetch; la respuesta final es `ventaCompleta`, así que re-adjuntarla
    // antes de devolverla (si no, el frontend siempre la ve undefined).
    if (venta.dataValues.advertenciaLimite) {
      ventaCompleta.dataValues.advertenciaLimite = venta.dataValues.advertenciaLimite;
    }

    return success(res, ventaCompleta, "Venta registrada exitosamente", 201);
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    console.error("Error en create venta:", err);
    return error(res, "Error al registrar la venta: " + err.message, 500);
  }
};

/**
 * Obtener todas las ventas
 * GET /api/ventas
 */
const getAll = async (req, res) => {
  try {
    const { page = 1, limit = 20, fechaInicio, fechaFin, estado } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const where = {
      ...req.filterCondition,
    };

    if (fechaInicio && fechaFin) {
      const fin = new Date(fechaFin + "T12:00:00Z");
      fin.setUTCDate(fin.getUTCDate() + 1);
      where.fecha = {
        [Op.gte]: fechaInicio,
        [Op.lt]: fin.toISOString().slice(0, 10),
      };
    }

    if (estado) {
      where.estado = estado;
    }

    const { count, rows } = await Venta.findAndCountAll({
      where,
      include: [
        {
          model: VentaDetalle,
          as: "detalles",
          include: [
            {
              model: Producto,
              as: "producto",
              attributes: ["id", "nombre", "codigo"],
            },
          ],
        },
        {
          model: User,
          as: "usuario",
          attributes: ["id", "nombre", "email"],
        },
        {
          model: ClienteDeudor, // ✅ Incluir deudor
          as: "deudor",
          attributes: ["id", "nombre", "deudaTotal", "deudaPendiente"],
        },
      ],
      limit: parseInt(limit),
      offset: offset,
      order: [["fecha", "DESC"]],
    });

    return paginated(res, rows, count, parseInt(page), parseInt(limit));
  } catch (err) {
    console.error("Error en getAll ventas:", err);
    return error(res, "Error al obtener ventas: " + err.message, 500);
  }
};

/**
 * Obtener venta por ID
 * GET /api/ventas/:id
 */
const getById = async (req, res) => {
  try {
    const venta = await Venta.findOne({
      where: { id: req.params.id, ...req.filterCondition },

      include: [
        {
          model: VentaDetalle,
          as: "detalles",
          include: [
            {
              model: Producto,
              as: "producto",
              attributes: ["id", "nombre", "codigo", "precio"],
            },
          ],
        },
        {
          model: User,
          as: "usuario",
          attributes: ["id", "nombre", "email"],
        },
        {
          model: ClienteDeudor, // ✅ Incluir deudor
          as: "deudor",
          attributes: ["id", "nombre", "deudaTotal", "deudaPendiente"],
        },
      ],
    });

    if (!venta) {
      return error(res, "Venta no encontrada", 404);
    }

    return success(res, venta, "Venta obtenida exitosamente");
  } catch (err) {
    console.error("Error en getById venta:", err);
    return error(res, "Error al obtener venta: " + err.message, 500);
  }
};

module.exports = {
  create,
  getAll,
  getById,
};



