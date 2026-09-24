const {
  CuentaContable,
  AsientoContable,
  DetalleAsiento,
  CuentaCorrienteDeuda,
  PagoDeudaContabilidad,
} = require("../models/index");
const { success, error, paginated } = require("../utils/response");
const { todayArgentina } = require("../utils/date");
const { Op } = require("sequelize");
const sequelize = require("../config/database");

// ========== CUENTAS CONTABLES ==========

const listarCuentas = async (req, res) => {
  try {
    const where = { ...req.filterCondition, activo: true };
    const cuentas = await CuentaContable.findAll({
      where,
      order: [["tipo", "ASC"], ["codigo", "ASC"]],
      attributes: ["id", "codigo", "nombre", "tipo", "descripcion", "parentId", "activo"],
    });

    // Group by tipo
    const agrupadas = {};
    for (const c of cuentas) {
      if (!agrupadas[c.tipo]) agrupadas[c.tipo] = [];
      agrupadas[c.tipo].push(c);
    }

    return success(res, agrupadas);
  } catch (err) {
    console.error("Error en contabilidad.listarCuentas:", err);
    return error(res, "Error al obtener cuentas contables", 500);
  }
};

const crearCuenta = async (req, res) => {
  try {
    const { codigo, nombre, tipo, descripcion, parentId } = req.body;

    if (!codigo || !nombre || !tipo) {
      return error(res, "Código, nombre y tipo son obligatorios", 400);
    }

    // Validate unique codigo per negocio
    const existente = await CuentaContable.findOne({
      where: { codigo, negocioId: req.businessId || req.user?.negocioId },
    });
    if (existente) {
      return error(res, "Ya existe una cuenta con ese código en tu negocio", 400);
    }

    const cuenta = await CuentaContable.create({
      codigo,
      nombre,
      tipo,
      descripcion: descripcion || null,
      parentId: parentId || null,
      activo: true,
      negocioId: req.businessId || req.user?.negocioId,
      userId: req.userId,
    });

    return success(res, cuenta, "Cuenta contable creada exitosamente", 201);
  } catch (err) {
    if (err.name === "SequelizeUniqueConstraintError") {
      return error(res, "Ya existe una cuenta con ese código", 400);
    }
    if (err.name === "SequelizeValidationError") {
      return error(res, err.errors.map((e) => e.message).join(", "), 400);
    }
    console.error("Error en contabilidad.crearCuenta:", err);
    return error(res, "Error al crear cuenta contable", 500);
  }
};

const actualizarCuenta = async (req, res) => {
  try {
    const cuenta = await CuentaContable.findOne({
      where: { id: req.params.id, ...req.filterCondition },
    });
    if (!cuenta) return error(res, "Cuenta contable no encontrada", 404);

    // If changing codigo, validate uniqueness
    if (req.body.codigo && req.body.codigo !== cuenta.codigo) {
      const existente = await CuentaContable.findOne({
        where: { codigo: req.body.codigo, negocioId: req.businessId || req.user?.negocioId },
      });
      if (existente) {
        return error(res, "Ya existe otra cuenta con ese código", 400);
      }
    }

    await cuenta.update(req.body);
    return success(res, cuenta, "Cuenta contable actualizada exitosamente");
  } catch (err) {
    if (err.name === "SequelizeValidationError") {
      return error(res, err.errors.map((e) => e.message).join(", "), 400);
    }
    console.error("Error en contabilidad.actualizarCuenta:", err);
    return error(res, "Error al actualizar cuenta contable", 500);
  }
};

const eliminarCuenta = async (req, res) => {
  try {
    const cuenta = await CuentaContable.findOne({
      where: { id: req.params.id, ...req.filterCondition },
    });
    if (!cuenta) return error(res, "Cuenta contable no encontrada", 404);

    await cuenta.update({ activo: false });
    return success(res, null, "Cuenta contable desactivada exitosamente");
  } catch (err) {
    console.error("Error en contabilidad.eliminarCuenta:", err);
    return error(res, "Error al eliminar cuenta contable", 500);
  }
};

// ========== ASIENTOS CONTABLES ==========

const listarAsientos = async (req, res) => {
  try {
    const { page = 1, limit = 20, fechaInicio, fechaFin, tipo } = req.query;
    const offset = (parseInt(page) - 1) * limit;
    const where = { ...req.filterCondition };

    if (tipo) where.tipo = tipo;
    if (fechaInicio || fechaFin) {
      where.fecha = {};
      if (fechaInicio) where.fecha[Op.gte] = new Date(fechaInicio);
      if (fechaFin) {
        const fin = new Date(fechaFin);
        fin.setHours(23, 59, 59, 999);
        where.fecha[Op.lte] = fin;
      }
    }

    const { rows, count } = await AsientoContable.findAndCountAll({
      where,
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [["fecha", "DESC"], ["createdAt", "DESC"]],
      include: [
        { model: require("../models/index").User, as: "usuario", attributes: ["id", "nombre"] },
      ],
    });

    return paginated(res, rows, count, parseInt(page), parseInt(limit));
  } catch (err) {
    console.error("Error en contabilidad.listarAsientos:", err);
    return error(res, "Error al obtener asientos contables", 500);
  }
};

const crearAsiento = async (req, res) => {
  let t;
  try {
    const { fecha, descripcion, tipo, referencia, detalles } = req.body;

    if (!fecha || !descripcion || !tipo || !detalles || !Array.isArray(detalles)) {
      return error(res, "Fecha, descripción, tipo y detalles son obligatorios", 400);
    }

    if (detalles.length < 2) {
      return error(res, "Un asiento debe tener al menos 2 líneas de detalle", 400);
    }

    // Validate: sum(debe) must equal sum(haber)
    const totalDebe = detalles.reduce((sum, d) => sum + parseFloat(d.debe || 0), 0);
    const totalHaber = detalles.reduce((sum, d) => sum + parseFloat(d.haber || 0), 0);

    if (Math.abs(totalDebe - totalHaber) > 0.01) {
      return error(res, `El total de debe ($${totalDebe.toFixed(2)}) no coincide con el total de haber ($${totalHaber.toFixed(2)})`, 400);
    }

    if (totalDebe === 0 && totalHaber === 0) {
      return error(res, "El monto total del asiento no puede ser cero", 400);
    }

    // Validate each line: each must have a valid cuentaContableId and either debe or haber > 0
    for (const det of detalles) {
      if (!det.cuentaContableId) {
        return error(res, "Cada línea debe tener una cuenta contable asignada", 400);
      }
      const de = parseFloat(det.debe || 0);
      const ha = parseFloat(det.haber || 0);
      if (de < 0 || ha < 0) {
        return error(res, "Los montos de debe y haber no pueden ser negativos", 400);
      }
      if (de > 0 && ha > 0) {
        return error(res, "Una línea no puede tener monto en debe y haber al mismo tiempo", 400);
      }
    }

    t = await sequelize.transaction();

    const asiento = await AsientoContable.create(
      {
        fecha,
        descripcion,
        tipo,
        referencia: referencia || null,
        montoTotal: totalDebe,
        negocioId: req.businessId || req.user?.negocioId,
        userId: req.userId,
      },
      { transaction: t },
    );

    for (const det of detalles) {
      await DetalleAsiento.create(
        {
          asientoContableId: asiento.id,
          cuentaContableId: det.cuentaContableId,
          debe: parseFloat(det.debe || 0),
          haber: parseFloat(det.haber || 0),
          descripcion: det.descripcion || null,
          negocioId: req.businessId || req.user?.negocioId,
        },
        { transaction: t },
      );
    }

    await t.commit();

    const result = await AsientoContable.findByPk(asiento.id, {
      include: [
        {
          model: DetalleAsiento,
          as: "detalles",
          include: [{ model: CuentaContable, as: "cuenta", attributes: ["id", "codigo", "nombre"] }],
        },
      ],
    });

    return success(res, result, "Asiento contable creado exitosamente", 201);
  } catch (err) {
    if (t && !t.finished) await t.rollback();
    if (err.name === "SequelizeValidationError") {
      return error(res, err.errors.map((e) => e.message).join(", "), 400);
    }
    console.error("Error en contabilidad.crearAsiento:", err);
    return error(res, "Error al crear asiento contable", 500);
  }
};

const obtenerAsiento = async (req, res) => {
  try {
    const asiento = await AsientoContable.findOne({
      where: { id: req.params.id, ...req.filterCondition },
      include: [
        {
          model: DetalleAsiento,
          as: "detalles",
          include: [{ model: CuentaContable, as: "cuenta", attributes: ["id", "codigo", "nombre", "tipo"] }],
        },
        { model: require("../models/index").User, as: "usuario", attributes: ["id", "nombre"] },
      ],
    });
    if (!asiento) return error(res, "Asiento contable no encontrado", 404);
    return success(res, asiento);
  } catch (err) {
    console.error("Error en contabilidad.obtenerAsiento:", err);
    return error(res, "Error al obtener asiento contable", 500);
  }
};

const eliminarAsiento = async (req, res) => {
  try {
    const asiento = await AsientoContable.findOne({
      where: { id: req.params.id, ...req.filterCondition },
    });
    if (!asiento) return error(res, "Asiento contable no encontrado", 404);

    // Detalles are cascade deleted
    await asiento.destroy();
    return success(res, null, "Asiento contable eliminado exitosamente");
  } catch (err) {
    console.error("Error en contabilidad.eliminarAsiento:", err);
    return error(res, "Error al eliminar asiento contable", 500);
  }
};

// ========== CUENTAS CORRIENTES DE DEUDAS ==========

const listarDeudas = async (req, res) => {
  try {
    const { tipo, estado } = req.query;
    const where = { ...req.filterCondition };
    if (tipo) where.tipo = tipo;
    if (estado) where.estado = estado;

    const deudas = await CuentaCorrienteDeuda.findAll({
      where,
      order: [["fechaInicio", "DESC"]],
      include: [
        { model: require("../models/index").User, as: "usuario", attributes: ["id", "nombre"] },
      ],
    });

    return success(res, deudas);
  } catch (err) {
    console.error("Error en contabilidad.listarDeudas:", err);
    return error(res, "Error al obtener deudas", 500);
  }
};

const crearDeuda = async (req, res) => {
  try {
    const {
      nombre, tipo, montoOriginal, tasaInteres, cuotasTotales,
      montoCuota, fechaInicio, fechaVencimiento, contactoNombre,
      contactoTelefono, proveedorId, notas,
    } = req.body;

    if (!nombre || !tipo || !montoOriginal || !fechaInicio) {
      return error(res, "Nombre, tipo, monto original y fecha de inicio son obligatorios", 400);
    }

    const deuda = await CuentaCorrienteDeuda.create({
      nombre,
      tipo,
      montoOriginal,
      saldoPendiente: montoOriginal,
      tasaInteres: tasaInteres || null,
      cuotasTotales: cuotasTotales || null,
      cuotasPagadas: 0,
      montoCuota: montoCuota || null,
      fechaInicio,
      fechaVencimiento: fechaVencimiento || null,
      estado: "activo",
      contactoNombre: contactoNombre || null,
      contactoTelefono: contactoTelefono || null,
      proveedorId: proveedorId || null,
      notas: notas || null,
      negocioId: req.businessId || req.user?.negocioId,
      userId: req.userId,
    });

    return success(res, deuda, "Deuda registrada exitosamente", 201);
  } catch (err) {
    if (err.name === "SequelizeValidationError") {
      return error(res, err.errors.map((e) => e.message).join(", "), 400);
    }
    console.error("Error en contabilidad.crearDeuda:", err);
    return error(res, "Error al registrar deuda", 500);
  }
};

const actualizarDeuda = async (req, res) => {
  try {
    const deuda = await CuentaCorrienteDeuda.findOne({
      where: { id: req.params.id, ...req.filterCondition },
    });
    if (!deuda) return error(res, "Deuda no encontrada", 404);

    // Prevent changing saldoPendiente directly
    const { saldoPendiente, ...safeUpdates } = req.body;

    await deuda.update(safeUpdates);
    return success(res, deuda, "Deuda actualizada exitosamente");
  } catch (err) {
    if (err.name === "SequelizeValidationError") {
      return error(res, err.errors.map((e) => e.message).join(", "), 400);
    }
    console.error("Error en contabilidad.actualizarDeuda:", err);
    return error(res, "Error al actualizar deuda", 500);
  }
};

const registrarPagoDeuda = async (req, res) => {
  let t;
  try {
    const { monto, fecha, metodoPago, numeroCuota, observaciones } = req.body;

    if (!monto || !fecha || !metodoPago) {
      return error(res, "Monto, fecha y método de pago son obligatorios", 400);
    }

    const deuda = await CuentaCorrienteDeuda.findOne({
      where: { id: req.params.id, ...req.filterCondition },
    });
    if (!deuda) return error(res, "Deuda no encontrada", 404);
    if (deuda.estado === "pagado") return error(res, "Esta deuda ya está pagada", 400);

    const montoPago = parseFloat(monto);
    const saldoActual = parseFloat(deuda.saldoPendiente);

    if (montoPago <= 0) return error(res, "El monto del pago debe ser mayor a cero", 400);
    if (montoPago > saldoActual) return error(res, "El monto del pago excede el saldo pendiente", 400);

    t = await sequelize.transaction();

    const nuevoSaldo = saldoActual - montoPago;
    const nuevasCuotasPagadas = numeroCuota ? deuda.cuotasPagadas + 1 : deuda.cuotasPagadas;
    const nuevoEstado = nuevoSaldo <= 0.01 ? "pagado" : deuda.estado;

    await deuda.update(
      {
        saldoPendiente: Math.max(0, nuevoSaldo),
        cuotasPagadas: nuevasCuotasPagadas,
        estado: nuevoEstado,
      },
      { transaction: t },
    );

    const pago = await PagoDeudaContabilidad.create(
      {
        cuentaCorrienteDeudaId: deuda.id,
        monto: montoPago,
        fecha,
        metodoPago,
        numeroCuota: numeroCuota || null,
        observaciones: observaciones || null,
        negocioId: req.businessId || req.user?.negocioId,
        userId: req.userId,
      },
      { transaction: t },
    );

    await t.commit();

    return success(res, { pago, deudaActualizada: deuda }, "Pago registrado exitosamente", 201);
  } catch (err) {
    if (t && !t.finished) await t.rollback();
    console.error("Error en contabilidad.registrarPagoDeuda:", err);
    return error(res, "Error al registrar pago", 500);
  }
};

const listarPagosDeuda = async (req, res) => {
  try {
    const deuda = await CuentaCorrienteDeuda.findOne({
      where: { id: req.params.id, ...req.filterCondition },
    });
    if (!deuda) return error(res, "Deuda no encontrada", 404);

    const pagos = await PagoDeudaContabilidad.findAll({
      where: { cuentaCorrienteDeudaId: deuda.id },
      order: [["fecha", "DESC"]],
      include: [
        { model: require("../models/index").User, as: "usuario", attributes: ["id", "nombre"] },
      ],
    });

    return success(res, pagos);
  } catch (err) {
    console.error("Error en contabilidad.listarPagosDeuda:", err);
    return error(res, "Error al obtener pagos", 500);
  }
};

// ========== BALANCE GENERAL ==========

const obtenerBalance = async (req, res) => {
  try {
    const { fecha } = req.query;
    const where = { ...req.filterCondition };

    // Get all active accounts with their detalles
    const cuentas = await CuentaContable.findAll({
      where: { ...where, activo: true },
    });

    const detalles = await DetalleAsiento.findAll({
      where: { negocioId: where.negocioId },
      include: [
        {
          model: AsientoContable,
          as: "asiento",
          where: fecha ? { fecha: { [Op.lte]: new Date(fecha) } } : {},
          attributes: [],
        },
      ],
    });

    // Calculate balance per account
    // For activo: debe - haber (positive = asset)
    // For pasivo: haber - debe (positive = liability)
    // For capital: haber - debe (positive = equity)
    // For ingreso: haber (income)
    // For gasto: debe (expense)
    const balancePorCuenta = {};
    for (const det of detalles) {
      const cid = det.cuentaContableId;
      if (!balancePorCuenta[cid]) balancePorCuenta[cid] = { debe: 0, haber: 0 };
      balancePorCuenta[cid].debe += parseFloat(det.debe);
      balancePorCuenta[cid].haber += parseFloat(det.haber);
    }

    let activos = 0;
    let pasivos = 0;
    let capital = 0;
    let ingresos = 0;
    let gastos = 0;

    const cuentasConBalance = cuentas.map((c) => {
      const b = balancePorCuenta[c.id] || { debe: 0, haber: 0 };
      let balance = 0;
      if (c.tipo === "activo") {
        balance = b.debe - b.haber;
        activos += balance;
      } else if (c.tipo === "pasivo") {
        balance = b.haber - b.debe;
        pasivos += balance;
      } else if (c.tipo === "capital") {
        balance = b.haber - b.debe;
        capital += balance;
      } else if (c.tipo === "ingreso") {
        balance = b.haber;
        ingresos += balance;
      } else if (c.tipo === "gasto") {
        balance = b.debe;
        gastos += balance;
      }
      return {
        id: c.id,
        codigo: c.codigo,
        nombre: c.nombre,
        tipo: c.tipo,
        debe: b.debe,
        haber: b.haber,
        balance,
      };
    });

    const resultado = ingresos - gastos; // ganancia o pérdida

    return success(res, {
      fecha: fecha || "actual",
      activos,
      pasivos,
      capital,
      ingresos,
      gastos,
      resultado,
      cuentas: cuentasConBalance,
    });
  } catch (err) {
    console.error("Error en contabilidad.obtenerBalance:", err);
    return error(res, "Error al generar balance", 500);
  }
};

// ========== DASHBOARD ==========

const dashboard = async (req, res) => {
  try {
    const negocioId = req.businessId || req.user?.negocioId;

    // Total deudas activas
    const deudasActivas = await CuentaCorrienteDeuda.findAll({
      where: { negocioId, estado: "activo" },
      attributes: [
        "id", "nombre", "tipo", "saldoPendiente", "cuotasPagadas", "cuotasTotales",
        "montoCuota", "fechaVencimiento", "estado",
      ],
    });

    const totalDeudasActivas = deudasActivas.reduce(
      (sum, d) => sum + parseFloat(d.saldoPendiente || 0), 0,
    );

    // Deudas por tipo
    const deudasPorTipo = {};
    for (const d of deudasActivas) {
      if (!deudasPorTipo[d.tipo]) deudasPorTipo[d.tipo] = 0;
      deudasPorTipo[d.tipo] += parseFloat(d.saldoPendiente || 0);
    }

    // Próximo pago a vencer
    const hoy = new Date();
    const proximoPago = deudasActivas
      .filter((d) => d.fechaVencimiento && d.montoCuota)
      .sort((a, b) => new Date(a.fechaVencimiento) - new Date(b.fechaVencimiento))
      .find((d) => new Date(d.fechaVencimiento) >= hoy);

    // Balance resumido from asientos
    const detalles = await DetalleAsiento.findAll({
      where: { negocioId },
      include: [{ model: CuentaContable, as: "cuenta", attributes: ["tipo"] }],
    });

    let activos = 0;
    let pasivos = 0;
    let capital = 0;
    let ingresos = 0;
    let gastos = 0;

    for (const det of detalles) {
      const debe = parseFloat(det.debe);
      const haber = parseFloat(det.haber);
      const tipo = det.cuenta?.tipo;

      if (tipo === "activo") activos += debe - haber;
      else if (tipo === "pasivo") pasivos += haber - debe;
      else if (tipo === "capital") capital += haber - debe;
      else if (tipo === "ingreso") ingresos += haber;
      else if (tipo === "gasto") gastos += debe;
    }

    return success(res, {
      totalDeudasActivas,
      deudasPorTipo,
      proximoPago: proximoPago
        ? {
            id: proximoPago.id,
            nombre: proximoPago.nombre,
            montoCuota: proximoPago.montoCuota,
            fechaVencimiento: proximoPago.fechaVencimiento,
          }
        : null,
      balance: {
        activos,
        pasivos,
        capital,
        ingresos,
        gastos,
        resultado: ingresos - gastos,
      },
    });
  } catch (err) {
    console.error("Error en contabilidad.dashboard:", err);
    return error(res, "Error al obtener dashboard de contabilidad", 500);
  }
};

module.exports = {
  listarCuentas,
  crearCuenta,
  actualizarCuenta,
  eliminarCuenta,
  listarAsientos,
  crearAsiento,
  obtenerAsiento,
  eliminarAsiento,
  listarDeudas,
  crearDeuda,
  actualizarDeuda,
  registrarPagoDeuda,
  listarPagosDeuda,
  obtenerBalance,
  dashboard,
};
