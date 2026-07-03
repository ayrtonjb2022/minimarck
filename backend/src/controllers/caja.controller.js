const { Caja, MovimientoCaja, User } = require("../models/index");
const sequelize = require("../config/database");
const { success, error, paginated } = require("../utils/response");
const { Op } = require("sequelize");

/**
 * Abrir una nueva caja
 * POST /api/cajas/apertura
 */
const abrirCaja = async (req, res) => {
  let t;
  try {
    const { saldoInicial, observaciones } = req.body;

    // Verificar si ya hay una caja abierta en el negocio
    const cajaAbierta = await Caja.findOne({
      where: {
        negocioId: req.businessId || req.user?.negocioId,
        estado: "abierta",
      },
    });

    if (cajaAbierta) {
      return error(
        res,
        "Ya existe una caja abierta. Debe cerrarla antes de abrir otra",
        400,
      );
    }

    t = await sequelize.transaction();

    const caja = await Caja.create({
      fechaApertura: new Date(),
      saldoInicial: saldoInicial || 0,
      totalIngresos: 0,
      totalEgresos: 0,
      estado: "abierta",
      observaciones: observaciones || null,
      negocioId: req.businessId || req.user?.negocioId,
      userId: req.userId,
      usuarioApertura: req.userId,
    }, { transaction: t });

    // Registrar movimiento de apertura
    await MovimientoCaja.create({
      tipo: "ingreso",
      concepto: "APERTURA DE CAJA",
      monto: saldoInicial || 0,
      saldoAnterior: 0,
      saldoNuevo: saldoInicial || 0,
      negocioId: req.businessId || req.user?.negocioId,
      cajaId: caja.id,
      userId: req.userId,
    }, { transaction: t });

    await t.commit();

    return success(res, caja, "Caja abierta exitosamente", 201);
  } catch (err) {
    if (t) await t.rollback();
    console.error("Error en abrirCaja:", err);
    return error(res, "Error al abrir caja: " + err.message, 500);
  }
};

/**
 * Cerrar caja
 * PUT /api/cajas/cierre/:id
 */
const cerrarCaja = async (req, res) => {
  try {
    const caja = await Caja.findByPk(req.params.id);

    if (!caja) {
      return error(res, "Caja no encontrada", 404);
    }

    if (caja.estado === "cerrada") {
      return error(res, "Esta caja ya está cerrada", 400);
    }

    if (caja.userId !== req.userId) {
      return error(res, "Solo quien abrió la caja puede cerrarla", 403);
    }

    const saldoActual =
      parseFloat(caja.saldoInicial) +
      parseFloat(caja.totalIngresos) -
      parseFloat(caja.totalEgresos);

    await caja.update({
      fechaCierre: new Date(),
      saldoFinal: saldoActual,
      estado: "cerrada",
      usuarioCierre: req.userId,
    });

    return success(res, caja, "Caja cerrada exitosamente");
  } catch (err) {
    console.error("Error en cerrarCaja:", err);
    return error(res, "Error al cerrar caja: " + err.message, 500);
  }
};

/**
 * Obtener caja activa del usuario
 * GET /api/cajas/activa
 */
const getCajaActiva = async (req, res) => {
  try {
    const caja = await Caja.findOne({
      where: {
        negocioId: req.businessId || req.user?.negocioId,
        estado: "abierta",
      },
      include: [
        {
          model: MovimientoCaja,
          as: "movimientos",
          limit: 10,
          order: [["createdAt", "DESC"]],
        },
      ],
    });

    if (!caja) {
      return success(res, null, "No hay caja abierta");
    }

    return success(res, caja, "Caja activa obtenida exitosamente");
  } catch (err) {
    console.error("Error en getCajaActiva:", err);
    return error(res, "Error al obtener caja activa: " + err.message, 500);
  }
};

/**
 * Obtener todas las cajas del usuario
 * GET /api/cajas
 */
const getAll = async (req, res) => {
  try {
    const { page = 1, limit = 20, estado, fechaInicio, fechaFin } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const where = {
      ...req.filterCondition,
    };

    if (estado) {
      where.estado = estado;
    }

    if (fechaInicio && fechaFin) {
      where.fechaApertura = {
        [Op.between]: [new Date(fechaInicio), new Date(fechaFin)],
      };
    }

    const { count, rows } = await Caja.findAndCountAll({
      where,
      include: [
        {
          model: User,
          as: "usuarioQueAbre",
          attributes: ["id", "nombre", "email"],
        },
        {
          model: User,
          as: "usuarioQueCierra",
          attributes: ["id", "nombre", "email"],
        },
      ],
      limit: parseInt(limit),
      offset: offset,
      order: [["fechaApertura", "DESC"]],
    });

    return paginated(res, rows, count, parseInt(page), parseInt(limit));
  } catch (err) {
    console.error("Error en getAll cajas:", err);
    return error(res, "Error al obtener cajas: " + err.message, 500);
  }
};

/**
 * Obtener caja por ID
 * GET /api/cajas/:id
 */
const getById = async (req, res) => {
  try {
    const caja = await Caja.findOne({
      where: { id: req.params.id, ...req.filterCondition },
      include: [
        {
          model: MovimientoCaja,
          as: "movimientos",
          order: [["createdAt", "DESC"]],
          include: [
            {
              model: User,
              as: "usuario",
              attributes: ["id", "nombre", "email"],
            },
          ],
        },
        {
          model: User,
          as: "usuarioQueAbre",
          attributes: ["id", "nombre", "email"],
        },
        {
          model: User,
          as: "usuarioQueCierra",
          attributes: ["id", "nombre", "email"],
        },
      ],
    });

    if (!caja) {
      return error(res, "Caja no encontrada", 404);
    }

    return success(res, caja, "Caja obtenida exitosamente");
  } catch (err) {
    console.error("Error en getById caja:", err);
    return error(res, "Error al obtener caja: " + err.message, 500);
  }
};

/**
 * Obtener saldo general (cajas cerradas + caja actual)
 * GET /api/cajas/saldo-general
 */
const getSaldoGeneral = async (req, res) => {
  try {
    const negocioId = req.businessId || req.user?.negocioId;
    const saldo = await calcularSaldoGeneral(negocioId);
    return success(res, saldo, "Saldo general obtenido");
  } catch (err) {
    console.error("Error en getSaldoGeneral:", err);
    return error(res, "Error al obtener saldo general", 500);
  }
};

/**
 * Helper: calcula saldo general para un negocio
 */
const calcularSaldoGeneral = async (negocioId) => {
  const cerradas = await Caja.findAll({ where: { negocioId, estado: "cerrada" } });
  let saldoCerradas = 0;
  for (const c of cerradas) {
    saldoCerradas += parseFloat(c.saldoFinal || 0);
  }

  const abierta = await Caja.findOne({ where: { negocioId, estado: "abierta" } });
  let saldoAbierta = 0;
  if (abierta) {
    saldoAbierta = parseFloat(abierta.saldoInicial) + parseFloat(abierta.totalIngresos) - parseFloat(abierta.totalEgresos);
  }

  return {
    saldoGeneral: saldoCerradas + saldoAbierta,
    saldoCerradas,
    saldoAbierta,
    tieneCajaAbierta: !!abierta,
  };
};

module.exports = {
  abrirCaja,
  cerrarCaja,
  getCajaActiva,
  getAll,
  getById,
  getSaldoGeneral,
  calcularSaldoGeneral,
};

