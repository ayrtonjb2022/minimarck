const { Venta, VentaDetalle, Producto, User, MovimientoCaja, Compra } = require("../models/index");
const { success, error } = require("../utils/response");
const { Op, Sequelize } = require("sequelize");
const sequelize = require("../config/database");

/**
 * Crea un filtro de fecha que funciona con DATETIME (hoy, sin migration)
 * Y con DATE (post-migration).
 *
 * Usa [Op.gte]: fecha + [Op.lt]: díaSiguiente en vez de BETWEEN,
 * porque BETWEEN con strings en DATETIME solo agarra medianoche.
 *
 * @param {string} fechaInicio - "YYYY-MM-DD"
 * @param {string} fechaFin   - "YYYY-MM-DD"
 * @returns {{ [Op.gte]: string, [Op.lt]: string }}
 */
function dateFilter(fechaInicio, fechaFin) {
  const fin = new Date(fechaFin + "T12:00:00Z"); // mediodía UTC evita off-by-one por timezone
  fin.setUTCDate(fin.getUTCDate() + 1);
  const nextDay = fin.toISOString().slice(0, 10); // YYYY-MM-DD
  return { [Op.gte]: fechaInicio, [Op.lt]: nextDay };
}

const reporteVentas = async (req, res) => {
  try {
    const { fechaInicio, fechaFin } = req.query;

    if (!fechaInicio || !fechaFin) {
      return error(res, "Debe proporcionar fechaInicio y fechaFin", 400);
    }

    const where = {
      ...req.filterCondition,
      fecha: dateFilter(fechaInicio, fechaFin),
    };

    const ventas = await Venta.findAll({
      where,
      include: [
        {
          model: VentaDetalle,
          as: "detalles",
          include: [
            {
              model: Producto,
              as: "producto",
              attributes: ["id", "nombre", "codigo", "precioCompra"],
            },
          ],
        },
        {
          model: User,
          as: "usuario",
          attributes: ["id", "nombre", "email"],
        },
      ],
      order: [["fecha", "DESC"]],
    });

    const totalVentas = ventas.length;
    const totalIngresos = ventas.reduce(
      (sum, v) => sum + parseFloat(v.total),
      0,
    );

    return success(res, {
      resumen: {
        totalVentas,
        totalIngresos,
        promedioVenta: totalVentas > 0 ? totalIngresos / totalVentas : 0,
        periodo: { fechaInicio, fechaFin },
      },
      detalle: ventas,
    });
  } catch (err) {
    console.error("Error en reporteVentas:", err);
    return error(
      res,
      "Error al generar reporte de ventas: " + err.message,
      500,
    );
  }
};

const reporteProductosMasVendidos = async (req, res) => {
  try {
    const { fechaInicio, fechaFin, limit = 10 } = req.query;

    const where = {};

    if (fechaInicio && fechaFin) {
      where["$venta.fecha$"] = dateFilter(fechaInicio, fechaFin);
    }

    if (req.filterCondition) {
      if (req.filterCondition.userId) {
        where["$venta.user_id$"] = req.filterCondition.userId;
      }
      if (req.filterCondition.negocioId) {
        where["$venta.negocio_id$"] = req.filterCondition.negocioId;
      }
    }

    const productos = await VentaDetalle.findAll({
      attributes: [
        "productoId",
        [
          Sequelize.fn("SUM", Sequelize.col("VentaDetalle.cantidad")),
          "totalVendido",
        ],
        [
          Sequelize.fn("SUM", Sequelize.col("VentaDetalle.subtotal")),
          "totalIngresos",
        ],
      ],
      include: [
        {
          model: Producto,
          as: "producto",
          attributes: ["id", "nombre", "codigo", "precio", "stock"],
        },
        {
          model: Venta,
          as: "venta",
          where: { estado: "completada" },
          attributes: [],
        },
      ],
      where,
      group: ["productoId", "producto.id"],
      order: [
        [Sequelize.fn("SUM", Sequelize.col("VentaDetalle.cantidad")), "DESC"],
      ],
      limit: parseInt(limit),
    });

    return success(res, productos);
  } catch (err) {
    console.error("Error en reporteProductosMasVendidos:", err);
    return error(
      res,
      "Error al generar reporte de productos más vendidos: " + err.message,
      500,
    );
  }
};

const reporteCaja = async (req, res) => {
  try {
    const { cajaId } = req.params;

    const movimientos = await MovimientoCaja.findAll({
      where: { cajaId, ...req.filterCondition },
      include: [
        {
          model: User,
          as: "usuario",
          attributes: ["id", "nombre", "email"],
        },
      ],
      order: [["createdAt", "ASC"]],
    });

    const totalIngresos = movimientos
      .filter((m) => m.tipo === "ingreso")
      .reduce((sum, m) => sum + parseFloat(m.monto), 0);

    const totalEgresos = movimientos
      .filter((m) => m.tipo === "egreso")
      .reduce((sum, m) => sum + parseFloat(m.monto), 0);

    return success(res, {
      movimientos,
      resumen: {
        totalIngresos,
        totalEgresos,
        saldoFinal: totalIngresos - totalEgresos,
      },
    });
  } catch (err) {
    console.error("Error en reporteCaja:", err);
    return error(res, "Error al generar reporte de caja: " + err.message, 500);
  }
};

const reporteEstadoResultados = async (req, res) => {
  try {
    const { fechaInicio, fechaFin } = req.query;
    if (!fechaInicio || !fechaFin) {
      return error(res, "Debe proporcionar fechaInicio y fechaFin", 400);
    }

    const negocioId = req.filterCondition?.negocioId || req.user?.negocioId;

    // Filtro que funciona con DATETIME (hoy) Y con DATE (post-migration)
    const fDate = dateFilter(fechaInicio, fechaFin);

    // Ingresos (ventas completadas)
    const ventas = await Venta.findAll({
      attributes: [
        [Sequelize.fn("DATE", Sequelize.col("fecha")), "dia"],
        [Sequelize.fn("COUNT", Sequelize.col("id")), "cantidad"],
        [Sequelize.fn("SUM", Sequelize.col("total")), "total"],
      ],
      where: { negocioId, fecha: fDate, estado: "completada" },
      group: [Sequelize.fn("DATE", Sequelize.col("fecha"))],
      order: [[Sequelize.fn("DATE", Sequelize.col("fecha")), "ASC"]],
      raw: true,
    });

    // Egresos (compras completadas)
    const compras = await Compra.findAll({
      attributes: [
        [Sequelize.fn("DATE", Sequelize.col("fecha")), "dia"],
        [Sequelize.fn("COUNT", Sequelize.col("id")), "cantidad"],
        [Sequelize.fn("SUM", Sequelize.col("total")), "total"],
      ],
      where: { negocioId, fecha: fDate, estado: "completada" },
      group: [Sequelize.fn("DATE", Sequelize.col("fecha"))],
      order: [[Sequelize.fn("DATE", Sequelize.col("fecha")), "ASC"]],
      raw: true,
    });

    // Egresos (movimientos caja manuales — excluir compras que ya se contaron arriba)
    // createdAt es TIMESTAMP UTC → ajustar group by a UTC-3 (Argentina) con INTERVAL
    const movEgresos = await MovimientoCaja.findAll({
      attributes: [
        [Sequelize.literal("DATE(created_at - INTERVAL 3 HOUR)"), "dia"],
        [Sequelize.fn("SUM", Sequelize.col("monto")), "total"],
      ],
      where: {
        negocioId,
        tipo: "egreso",
        createdAt: {
          [Op.gte]: Sequelize.literal(`'${fechaInicio} 03:00:00'`),
          [Op.lt]: Sequelize.literal(
            `'${fechaFin}' + INTERVAL 1 DAY + INTERVAL 3 HOUR`,
          ),
        },
        referencia: { [Op.notLike]: "compra-%" },
      },
      group: [Sequelize.literal("DATE(created_at - INTERVAL 3 HOUR)")],
      order: [Sequelize.literal("DATE(created_at - INTERVAL 3 HOUR) ASC")],
      raw: true,
    });

    // Merge daily data
    const dailyMap = {};
    const start = new Date(fechaInicio + "T12:00:00Z");
    const end = new Date(fechaFin + "T12:00:00Z");
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      dailyMap[key] = { fecha: key, ingresos: 0, egresos: 0, ganancia: 0 };
    }

    for (const v of ventas) {
      const key = v.dia.slice(0, 10);
      if (dailyMap[key]) dailyMap[key].ingresos = parseFloat(v.total) || 0;
    }
    for (const c of compras) {
      const key = c.dia.slice(0, 10);
      if (dailyMap[key]) dailyMap[key].egresos += parseFloat(c.total) || 0;
    }
    for (const m of movEgresos) {
      const key = m.dia.slice(0, 10);
      if (dailyMap[key]) dailyMap[key].egresos += parseFloat(m.total) || 0;
    }

    const diario = Object.values(dailyMap).map((d) => ({
      ...d,
      ganancia: d.ingresos - d.egresos,
    }));

    const totalIngresos = diario.reduce((s, d) => s + d.ingresos, 0);
    const totalEgresos = diario.reduce((s, d) => s + d.egresos, 0);
    const gananciaNeta = totalIngresos - totalEgresos;

    return success(res, {
      resumen: {
        totalIngresos,
        totalEgresos,
        gananciaNeta,
        margen: totalIngresos > 0 ? (gananciaNeta / totalIngresos) * 100 : 0,
        periodo: { fechaInicio, fechaFin },
      },
      diario,
    });
  } catch (err) {
    console.error("Error en reporteEstadoResultados:", err);
    return error(res, "Error al generar estado de resultados: " + err.message, 500);
  }
};

module.exports = {
  reporteVentas,
  reporteProductosMasVendidos,
  reporteCaja,
  reporteEstadoResultados,
};
