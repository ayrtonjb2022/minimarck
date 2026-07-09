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
    } = req.body;

    // Validaciones
    if (!items || !Array.isArray(items) || items.length === 0) {
      await transaction.rollback();
      return error(res, "La venta debe tener al menos un producto", 400);
    }

    // Verificar stock y calcular totales
    let subtotal = 0;
    const detalles = [];

    for (const item of items) {
      const cantidad = parseInt(item.cantidad);
      const precioUnitario = item.precioUnitario
        ? parseFloat(item.precioUnitario)
        : 0;

      let producto = null;
      if (item.productoId) {
        producto = await Producto.findByPk(item.productoId, { transaction });
        if (!producto) {
          await transaction.rollback();
          return error(res, `Producto con ID ${item.productoId} no encontrado`, 404);
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
        descuento: item.descuento ? parseFloat(item.descuento) : 0,
        subtotal: subtotalItem,
        ivaPorcentaje: producto ? parseFloat(producto.ivaPorcentaje) || 0 : 0,
      });
    }

    const iva = detalles.reduce((sum, det) => {
      return sum + (det.precioUnitario * det.cantidad * (det.ivaPorcentaje || 0)) / 100;
    }, 0);
    const total = subtotal + iva;
    const folio = `V-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    // Crear venta
    const venta = await Venta.create(
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
      },
      { transaction },
    );

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
          { where: { id: detalle.productoId, stock: { [Op.gte]: detalle.cantidad } }, transaction }
        );
        if (affected === 0) {
          await transaction.rollback();
          return error(res, `Stock insuficiente para "${detalle.nombreProducto}"`, 400);
        }
      }
    }

    // Si es venta a crédito, actualizar la deuda y notas del deudor
    if (metodoPago === "credito" && clienteDeudorId) {
      const deudor = await ClienteDeudor.findOne({
        where: { id: clienteDeudorId, negocioId: req.businessId || req.user?.negocioId },
        transaction,
      });

      if (deudor) {
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
    }

    // Registrar en caja si está abierta (solo para pagos NO crédito)
    if (metodoPago !== "credito") {
      const cajaAbierta = await Caja.findOne({
        where: {
          negocioId: req.businessId || req.user?.negocioId,
          estado: "abierta",
        },
        transaction,
      });

      if (cajaAbierta) {
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



