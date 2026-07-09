const { Compra, CompraDetalle, Producto, Proveedor, Caja, MovimientoCaja } = require("../models/index");
const { success, error, paginated } = require("../utils/response");
const { todayArgentina } = require("../utils/date");
const sequelize = require("../config/database");

const getAll = async (req, res) => {
  try {
    const { page = 1, limit = 20, estado } = req.query;
    const offset = (parseInt(page) - 1) * limit;
    const where = { ...req.filterCondition };

    if (estado) where.estado = estado;

    const { rows, count } = await Compra.findAndCountAll({
      where,
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [["fecha", "DESC"]],
      include: [
        { model: Proveedor, as: "proveedor", attributes: ["id", "nombre", "ruc"] },
      ],
    });

    return paginated(res, rows, count, parseInt(page), parseInt(limit));
  } catch (err) {
    console.error("Error en compra.getAll:", err);
    return error(res, "Error al obtener compras", 500);
  }
};

const getById = async (req, res) => {
  try {
    const compra = await Compra.findOne({
      where: { id: req.params.id, ...req.filterCondition },
      include: [
        { model: Proveedor, as: "proveedor" },
        {
          model: CompraDetalle,
          as: "detalles",
          include: [{ model: Producto, as: "producto", attributes: ["id", "nombre", "codigo"] }],
        },
      ],
    });
    if (!compra) return error(res, "Compra no encontrada", 404);
    return success(res, compra);
  } catch (err) {
    console.error("Error en compra.getById:", err);
    return error(res, "Error al obtener compra", 500);
  }
};

const create = async (req, res) => {
  let t;
  try {
    const { folio, items, proveedorId, observaciones, retirarDeCaja } = req.body;

    if (!items || !items.length) {
      return error(res, "Debe incluir al menos un producto", 400);
    }

    let subtotal = 0;
    for (const item of items) {
      const producto = await Producto.findByPk(item.productoId);
      if (!producto) {
        return error(res, `Producto ID ${item.productoId} no encontrado`, 404);
      }
      subtotal += item.cantidad * item.precioUnitario;
    }

    const total = subtotal;

    t = await sequelize.transaction();

    const compra = await Compra.create({
      folio: folio || `CMP-${Date.now()}`,
      fecha: todayArgentina(),
      subtotal,
      iva: 0,
      descuento: 0,
      total,
      estado: "completada",
      observaciones,
      proveedorId: proveedorId || null,
      userId: req.userId,
      negocioId: req.businessId || req.user?.negocioId,
    }, { transaction: t });

    for (const item of items) {
      await CompraDetalle.create({
        cantidad: item.cantidad,
        precioUnitario: item.precioUnitario,
        subtotal: item.cantidad * item.precioUnitario,
        compraId: compra.id,
        productoId: item.productoId,
      }, { transaction: t });

      await Producto.increment("stock", {
        by: item.cantidad,
        where: { id: item.productoId },
        transaction: t,
      });
    }

    // Si el usuario eligió retirar de caja, registrar el egreso
    if (retirarDeCaja) {
      const caja = await Caja.findOne({
        where: {
          negocioId: req.businessId || req.user?.negocioId,
          estado: "abierta",
        },
        transaction: t,
      });

      if (!caja) {
        await t.rollback();
        return error(res, "No hay una caja abierta. Abrí una caja antes de retirar fondos", 400);
      }

      const saldoActual =
        parseFloat(caja.saldoInicial) +
        parseFloat(caja.totalIngresos) -
        parseFloat(caja.totalEgresos);

      await MovimientoCaja.create({
        tipo: "egreso",
        concepto: `COMPRA #${compra.folio}`,
        monto: parseFloat(compra.total),
        saldoAnterior: saldoActual,
        saldoNuevo: saldoActual - parseFloat(compra.total),
        referencia: `compra-${compra.id}`,
        negocioId: req.businessId || req.user?.negocioId,
        cajaId: caja.id,
        userId: req.userId,
      }, { transaction: t });

      await caja.increment("totalEgresos", {
        by: parseFloat(compra.total),
        transaction: t,
      });
    }

    const result = await Compra.findByPk(compra.id, {
      include: [
        { model: Proveedor, as: "proveedor" },
        {
          model: CompraDetalle,
          as: "detalles",
          include: [{ model: Producto, as: "producto" }],
        },
      ],
      transaction: t,
    });

    await t.commit();

    return success(res, result, "Compra registrada exitosamente", 201);
  } catch (err) {
    if (t && !t.finished) await t.rollback();
    if (err.name === "SequelizeValidationError") {
      return error(res, err.errors.map((e) => e.message).join(", "), 400);
    }
    console.error("Error en compra.create:", err);
    return error(res, "Error al registrar compra", 500);
  }
};

const update = async (req, res) => {
  try {
    const compra = await Compra.findOne({
      where: { id: req.params.id, ...req.filterCondition },
    });
    if (!compra) return error(res, "Compra no encontrada", 404);
    if (compra.estado === "cancelada") {
      return error(res, "No se puede modificar una compra cancelada", 400);
    }
    await compra.update(req.body);
    return success(res, compra, "Compra actualizada exitosamente");
  } catch (err) {
    if (err.name === "SequelizeValidationError") {
      return error(res, err.errors.map((e) => e.message).join(", "), 400);
    }
    console.error("Error en compra.update:", err);
    return error(res, "Error al actualizar compra", 500);
  }
};

const cancel = async (req, res) => {
  let t;
  try {
    t = await sequelize.transaction();

    const compra = await Compra.findOne({
      where: { id: req.params.id, ...req.filterCondition },
      transaction: t,
    });
    if (!compra) {
      await t.rollback();
      return error(res, "Compra no encontrada", 404);
    }
    if (compra.estado === "cancelada") {
      await t.rollback();
      return error(res, "La compra ya está cancelada", 400);
    }

    const detalles = await CompraDetalle.findAll({ where: { compraId: compra.id }, transaction: t });
    for (const det of detalles) {
      await Producto.increment("stock", {
        by: -det.cantidad,
        where: { id: det.productoId },
        transaction: t,
      });
    }

    await compra.update({ estado: "cancelada" }, { transaction: t });
    await t.commit();
    return success(res, compra, "Compra cancelada exitosamente");
  } catch (err) {
    if (t && !t.finished) await t.rollback();
    console.error("Error en compra.cancel:", err);
    return error(res, "Error al cancelar compra", 500);
  }
};

module.exports = { getAll, getById, create, update, cancel };
