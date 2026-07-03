const { MovimientoCaja, Caja, User } = require("../models/index");
const sequelize = require("../config/database");
const { success, error, paginated } = require("../utils/response");
const { Op } = require("sequelize");

/**
 * Registrar un movimiento de caja
 * POST /api/movimientos
 */
const create = async (req, res) => {
  let t;
  try {
    const { tipo, concepto, monto, referencia, cajaId } = req.body;

    if (!tipo || !concepto || !monto || !cajaId) {
      return error(res, "Faltan campos requeridos: tipo, concepto, monto, cajaId", 400);
    }

    if (!["ingreso", "egreso"].includes(tipo)) {
      return error(res, 'Tipo debe ser "ingreso" o "egreso"', 400);
    }

    if (parseFloat(monto) <= 0) {
      return error(res, "El monto debe ser mayor a 0", 400);
    }

    const caja = await Caja.findByPk(cajaId);
    if (!caja) return error(res, "Caja no encontrada", 404);
    if (caja.estado === "cerrada")
      return error(res, "La caja está cerrada. No se pueden registrar movimientos", 400);
    if (caja.userId !== req.userId)
      return error(res, "No tiene permisos para registrar movimientos en esta caja", 403);

    const saldoActual = parseFloat(caja.saldoInicial) + parseFloat(caja.totalIngresos) - parseFloat(caja.totalEgresos);
    const saldoAnterior = saldoActual;
    const saldoNuevo = tipo === "ingreso" ? saldoActual + parseFloat(monto) : saldoActual - parseFloat(monto);

    t = await sequelize.transaction();

    const movimiento = await MovimientoCaja.create({
      tipo,
      concepto,
      monto: parseFloat(monto),
      saldoAnterior,
      saldoNuevo,
      referencia: referencia || null,
      negocioId: req.businessId || req.user?.negocioId,
      cajaId,
      userId: req.userId,
    }, { transaction: t });

    if (tipo === "ingreso") {
      await caja.increment("totalIngresos", { by: parseFloat(monto), transaction: t });
    } else {
      await caja.increment("totalEgresos", { by: parseFloat(monto), transaction: t });
    }

    await t.commit();

    return success(res, movimiento, "Movimiento registrado exitosamente", 201);
  } catch (err) {
    if (t) await t.rollback();
    console.error("Error en create movimiento:", err);
    return error(res, "Error al registrar movimiento: " + err.message, 500);
  }
};

/**
 * Obtener movimientos de una caja
 * GET /api/movimientos/caja/:cajaId
 */
const getByCaja = async (req, res) => {
  try {
    const { page = 1, limit = 20, tipo } = req.query;
    const { cajaId } = req.params;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const where = { cajaId, ...req.filterCondition };
    if (tipo) {
      where.tipo = tipo;
    }

    const { count, rows } = await MovimientoCaja.findAndCountAll({
      where,
      include: [
        {
          model: User,
          as: "usuario",
          attributes: ["id", "nombre", "email"],
        },
      ],
      limit: parseInt(limit),
      offset: offset,
      order: [["createdAt", "DESC"]],
    });

    return paginated(res, rows, count, parseInt(page), parseInt(limit));
  } catch (err) {
    console.error("Error en getByCaja movimientos:", err);
    return error(res, "Error al obtener movimientos: " + err.message, 500);
  }
};

/**
 * Obtener resumen de movimientos
 * GET /api/movimientos/resumen/:cajaId
 */
const getResumen = async (req, res) => {
  try {
    const { cajaId } = req.params;
    const caja = await Caja.findOne({
      where: { id: cajaId, ...req.filterCondition },
    });
    if (!caja) return error(res, "Caja no encontrada", 404);

    const totalIngresos =
      (await MovimientoCaja.sum("monto", {
        where: { cajaId, tipo: "ingreso" },
      })) || 0;

    const totalEgresos =
      (await MovimientoCaja.sum("monto", {
        where: { cajaId, tipo: "egreso" },
      })) || 0;

    const saldoActual =
      parseFloat(caja.saldoInicial) +
      parseFloat(totalIngresos) -
      parseFloat(totalEgresos);

    return success(
      res,
      {
        saldoInicial: parseFloat(caja.saldoInicial),
        totalIngresos: parseFloat(totalIngresos),
        totalEgresos: parseFloat(totalEgresos),
        saldoActual,
      },
      "Resumen obtenido exitosamente",
    );
  } catch (err) {
    console.error("Error en getResumen movimientos:", err);
    return error(res, "Error al obtener resumen: " + err.message, 500);
  }
};

module.exports = {
  create,
  getByCaja,
  getResumen,
};


