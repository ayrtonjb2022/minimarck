const { ClienteDeudor, PagoDeuda, Venta, User } = require("../models/index");
const { success, error, paginated } = require("../utils/response");
const { Op } = require("sequelize");

/**
 * Obtener todos los clientes deudores
 * GET /api/deudores
 */
const getAll = async (req, res) => {
  try {
    const { page = 1, limit = 20, search, conDeuda } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const where = {
      ...req.filterCondition,
      activo: true,
    };

    if (search) {
      where[Op.or] = [
        { nombre: { [Op.like]: `%${search}%` } },
        { documento: { [Op.like]: `%${search}%` } },
        { email: { [Op.like]: `%${search}%` } },
      ];
    }

    if (conDeuda === "true") {
      where.deudaPendiente = { [Op.gt]: 0 };
    }

    const { count, rows } = await ClienteDeudor.findAndCountAll({
      where,
      limit: parseInt(limit),
      offset: offset,
      order: [["deudaPendiente", "DESC"]],
      attributes: { exclude: ["createdAt", "updatedAt"] }, // Seguridad: no exponer timestamps
    });

    return paginated(res, rows, count, parseInt(page), parseInt(limit));
  } catch (err) {
    console.error("Error en getAll deudores:", err);
    return error(
      res,
      "Error al obtener clientes deudores: " + err.message,
      500,
    );
  }
};

/**
 * Obtener deudor por ID
 * GET /api/deudores/:id
 */
const getById = async (req, res) => {
  try {
    const deudor = await ClienteDeudor.findOne({
      where: { id: req.params.id, ...req.filterCondition },
      include: [
        {
          model: PagoDeuda,
          as: "pagos",
          order: [["fecha", "DESC"]],
          limit: 10,
          include: [
            {
              model: User,
              as: "usuario",
              attributes: ["id", "nombre", "email"], // Solo campos necesarios
            },
          ],
          attributes: { exclude: ["createdAt", "updatedAt"] },
        },
      ],
      attributes: { exclude: ["createdAt", "updatedAt"] },
    });

    if (!deudor) {
      return error(res, "Cliente deudor no encontrado", 404);
    }

    return success(res, deudor, "Cliente deudor obtenido exitosamente");
  } catch (err) {
    console.error("Error en getById deudor:", err);
    return error(res, "Error al obtener cliente deudor: " + err.message, 500);
  }
};

/**
 * Crear cliente deudor
 * POST /api/deudores
 */
const create = async (req, res) => {
  try {
    const {
      nombre,
      documento,
      telefono,
      email,
      direccion,
      limiteCredito,
      notas,
    } = req.body;

    // Validaciones de seguridad
    if (!nombre || nombre.trim().length === 0) {
      return error(res, "El nombre es requerido", 400);
    }

    if (nombre.length > 100) {
      return error(res, "El nombre no puede exceder los 100 caracteres", 400);
    }

    // Validar email si se proporciona
    if (email && !isValidEmail(email)) {
      return error(res, "El email no es válido", 400);
    }

    // Verificar documento único
    if (documento) {
      const existing = await ClienteDeudor.findOne({
        where: {
          documento,
          userId: req.userId,
        },
      });

      if (existing) {
        return error(res, "Ya existe un cliente con este documento", 400);
      }
    }

    // Sanitizar datos
    const deudor = await ClienteDeudor.create({
      nombre: nombre,
      documento: documento || null,
      telefono: telefono || null,
      email: email ? email.toLowerCase() : null,
      direccion: direccion || null,
      limiteCredito: limiteCredito ? parseFloat(limiteCredito) : null,
      notas: notas || null,
      deudaTotal: 0,
      deudaPendiente: 0,
      negocioId: req.businessId || req.user?.negocioId,
      userId: req.userId,
    });

    return success(res, deudor, "Cliente deudor creado exitosamente", 201);
  } catch (err) {
    console.error("Error en create deudor:", err);
    return error(res, "Error al crear cliente deudor: " + err.message, 500);
  }
};

/**
 * Actualizar cliente deudor
 * PUT /api/deudores/:id
 */
const update = async (req, res) => {
  try {
    const deudor = await ClienteDeudor.findOne({
      where: { id: req.params.id, ...req.filterCondition },
    });
    if (!deudor) return error(res, "Cliente deudor no encontrado", 404);
    const {
      nombre,
      documento,
      telefono,
      email,
      direccion,
      limiteCredito,
      notas,
      activo,
    } = req.body;

    // Validar email si se proporciona
    if (email && !isValidEmail(email)) {
      return error(res, "El email no es válido", 400);
    }

    // Verificar documento único (si cambió)
    if (documento && documento !== deudor.documento) {
      const existing = await ClienteDeudor.findOne({
        where: {
          documento,
          userId: req.userId,
          id: { [Op.ne]: deudor.id },
        },
      });

      if (existing) {
        return error(res, "Ya existe otro cliente con este documento", 400);
      }
    }

    // Sanitizar y actualizar
    await deudor.update({
      nombre: nombre || deudor.nombre,
      documento:
        documento !== undefined
          ? (documento || null)
          : deudor.documento,
      telefono:
        telefono !== undefined
          ? (telefono || null)
          : deudor.telefono,
      email:
        email !== undefined
          ? email
            ? email.toLowerCase()
            : null
          : deudor.email,
      direccion:
        direccion !== undefined
          ? (direccion || null)
          : deudor.direccion,
      limiteCredito:
        limiteCredito !== undefined
          ? limiteCredito
            ? parseFloat(limiteCredito)
            : null
          : deudor.limiteCredito,
      notas:
        notas !== undefined
          ? (notas || null)
          : deudor.notas,
      activo: activo !== undefined ? activo : deudor.activo,
    });

    return success(res, deudor, "Cliente deudor actualizado exitosamente");
  } catch (err) {
    console.error("Error en update deudor:", err);
    return error(
      res,
      "Error al actualizar cliente deudor: " + err.message,
      500,
    );
  }
};

/**
 * Eliminar cliente deudor (soft delete)
 * DELETE /api/deudores/:id
 */
const remove = async (req, res) => {
  try {
    const deudor = await ClienteDeudor.findOne({
      where: { id: req.params.id, ...req.filterCondition },
    });
    if (!deudor) return error(res, "Cliente deudor no encontrado", 404);

    // Soft delete
    await deudor.destroy();
    return success(res, null, "Cliente deudor eliminado exitosamente");
  } catch (err) {
    console.error("Error en remove deudor:", err);
    return error(res, "Error al eliminar cliente deudor: " + err.message, 500);
  }
};

/**
 * Registrar pago de deuda
 * POST /api/deudores/:id/pagos
 */
const registrarPago = async (req, res) => {
  try {
    const deudor = await ClienteDeudor.findOne({
      where: { id: req.params.id, ...req.filterCondition },
    });

    if (!deudor) {
      return error(res, "Cliente deudor no encontrado", 404);
    }

    const { monto, metodoPago, referencia, observaciones } = req.body;

    // Validaciones de seguridad
    if (!monto || parseFloat(monto) <= 0) {
      return error(res, "El monto debe ser mayor a 0", 400);
    }

    if (parseFloat(monto) > parseFloat(deudor.deudaPendiente)) {
      return error(
        res,
        `El monto excede la deuda pendiente (${deudor.deudaPendiente})`,
        400,
      );
    }

    // Validar método de pago
    const metodosPermitidos = [
      "efectivo",
      "tarjeta",
      "transferencia",
      "mixto",
    ];
    if (metodoPago && !metodosPermitidos.includes(metodoPago.toLowerCase())) {
      return error(res, "Método de pago no válido", 400);
    }

    // Registrar pago en transacción
    const transaction = await ClienteDeudor.sequelize.transaction();

    try {
      const pago = await PagoDeuda.create(
        {
          monto: parseFloat(monto),
          fecha: new Date(),
          metodoPago: metodoPago ? metodoPago.toLowerCase() : "efectivo",
          referencia: referencia || null,
          observaciones: observaciones || null,
          deudorId: deudor.id,
          negocioId: req.businessId || req.user?.negocioId,
          userId: req.userId,
        },
        { transaction },
      );

      // Actualizar deuda
      const nuevaDeudaPendiente =
        parseFloat(deudor.deudaPendiente) - parseFloat(monto);
      await deudor.update(
        {
          deudaPendiente: nuevaDeudaPendiente,
        },
        { transaction },
      );

      await transaction.commit();

      const pagadoCompleto = nuevaDeudaPendiente <= 0;

      return success(
        res,
        {
          pago,
          deudaPendiente: nuevaDeudaPendiente,
          deudaTotal: deudor.deudaTotal,
          pagadoCompleto,
          nombre: deudor.nombre,
          notas: deudor.notas,
        },
        pagadoCompleto ? "Deuda pagada completamente" : "Pago registrado exitosamente",
        201,
      );
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (err) {
    console.error("Error en registrarPago:", err);
    return error(res, "Error al registrar pago: " + err.message, 500);
  }
};

/**
 * Obtener historial de pagos de un deudor
 * GET /api/deudores/:id/pagos
 */
const getPagos = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { count, rows } = await PagoDeuda.findAndCountAll({
      where: {
        deudorId: req.params.id,
        ...req.filterCondition,
      },
      include: [
        {
          model: User,
          as: "usuario",
          attributes: ["id", "nombre", "email"], // Solo campos necesarios
        },
      ],
      limit: parseInt(limit),
      offset: offset,
      order: [["fecha", "DESC"]],
      attributes: { exclude: ["createdAt", "updatedAt"] },
    });

    return paginated(res, rows, count, parseInt(page), parseInt(limit));
  } catch (err) {
    console.error("Error en getPagos:", err);
    return error(res, "Error al obtener pagos: " + err.message, 500);
  }
};

// ========== FUNCIONES DE SEGURIDAD ==========

/**
 * Validar formato de email
 */
const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};


module.exports = {
  getAll,
  getById,
  create,
  update,
  remove,
  registrarPago,
  getPagos,
};

