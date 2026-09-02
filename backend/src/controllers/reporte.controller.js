const {
  Venta,
  VentaDetalle,
  Producto,
  User,
  MovimientoCaja,
  Compra,
  PagoDeuda,
  ClienteDeudor,
  Proveedor,
} = require("../models/index");
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
        [Op.or]: [
          { referencia: { [Op.notLike]: "compra-%" } },
          { referencia: null },
        ],
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

/**
 * Resumen gerencial: compara el período consultado contra el período anterior
 * de igual cantidad de días calendario.
 * GET /api/reportes/gerencial?fechaInicio=YYYY-MM-DD&fechaFin=YYYY-MM-DD
 */
const reporteGerencial = async (req, res) => {
  try {
    const { fechaInicio, fechaFin } = req.query;

    if (!fechaInicio || !fechaFin) {
      return error(res, "Debe proporcionar fechaInicio y fechaFin", 400);
    }

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(fechaInicio) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(fechaFin)
    ) {
      return error(res, "Debe proporcionar fechas válidas (YYYY-MM-DD)", 400);
    }

    // Comparación de strings válida porque el formato es YYYY-MM-DD
    if (fechaFin < fechaInicio) {
      return error(res, "La fecha fin debe ser mayor o igual a la fecha inicio", 400);
    }

    const negocioId = req.filterCondition?.negocioId || req.user?.negocioId;

    // Período anterior: misma cantidad de días calendario, inmediatamente antes
    const diffDays = Math.round(
      (new Date(fechaFin + "T12:00:00Z") -
        new Date(fechaInicio + "T12:00:00Z")) /
        86400000,
    );
    const inicioAnterior = new Date(fechaInicio + "T12:00:00Z");
    inicioAnterior.setUTCDate(inicioAnterior.getUTCDate() - (diffDays + 1));
    const finAnterior = new Date(fechaInicio + "T12:00:00Z");
    finAnterior.setUTCDate(finAnterior.getUTCDate() - 1);
    const toDate = (d) => d.toISOString().slice(0, 10);

    const periodoActual = { fechaInicio, fechaFin };
    const periodoAnterior = {
      fechaInicio: toDate(inicioAnterior),
      fechaFin: toDate(finAnterior),
    };

    /**
     * Calcula el resumen de un período. Todas las métricas en 0 si no hay datos.
     * @param {{fechaInicio:string, fechaFin:string}} periodo
     * @param {boolean} conIndicadores - suma día mayor/menor y top productos (solo período actual)
     */
    const calcularPeriodo = async (periodo, conIndicadores) => {
      const { fechaInicio: inicio, fechaFin: fin } = periodo;
      const fVentas = dateFilter(inicio, fin);

      // ---- Ventas completadas con detalles (unidades y costo de mercadería) ----
      const ventas = await Venta.findAll({
        where: { negocioId, fecha: fVentas, estado: "completada" },
        include: [
          {
            model: VentaDetalle,
            as: "detalles",
            include: [
              {
                model: Producto,
                as: "producto",
                attributes: ["id", "nombre", "precioCompra"],
              },
            ],
          },
        ],
      });

      let ventasTotales = 0;
      let unidadesVendidas = 0;
      // Costo al PRECIO DE COMPRA ACTUAL del producto: el sistema no guarda el
      // histórico de precios, así que se valora con el precio vigente (mismo
      // criterio que la pestaña Ganancias).
      let costoMercaderia = 0;
      for (const v of ventas) {
        ventasTotales += parseFloat(v.total) || 0;
        for (const d of v.detalles || []) {
          unidadesVendidas += d.cantidad || 0;
          costoMercaderia +=
            (d.cantidad || 0) * (parseFloat(d.producto?.precioCompra) || 0);
        }
      }

      const cantidadVentas = ventas.length;
      const ticketPromedio = cantidadVentas > 0 ? ventasTotales / cantidadVentas : 0;
      const gananciaBruta = ventasTotales - costoMercaderia;
      const margenBrutoPct = ventasTotales > 0 ? (gananciaBruta / ventasTotales) * 100 : 0;

      // ---- Compras completadas (solo referencia) ----
      // parseFloat: SUM de mysql2 puede venir como string
      const totalCompras =
        parseFloat(
          (await Compra.sum("total", {
            where: { negocioId, fecha: fVentas, estado: "completada" },
          })) || 0,
        ) || 0;

      // ---- Gastos operativos: misma definición que reporteEstadoResultados ----
      // createdAt es TIMESTAMP UTC → ajustar a UTC-3 (Argentina) con INTERVAL
      const gastosOperativos =
        parseFloat(
          (await MovimientoCaja.sum("monto", {
            where: {
              negocioId,
              tipo: "egreso",
              createdAt: {
                [Op.gte]: Sequelize.literal(`'${inicio} 03:00:00'`),
                [Op.lt]: Sequelize.literal(
                  `'${fin}' + INTERVAL 1 DAY + INTERVAL 3 HOUR`,
                ),
              },
              [Op.or]: [
                { referencia: { [Op.notLike]: "compra-%" } },
                { referencia: null },
              ],
            },
          })) || 0,
        ) || 0;

      // ---- Cobrado a deudores (pagos recibidos en el período) ----
      const totalCobradoDeudores =
        parseFloat(
          (await PagoDeuda.sum("monto", {
            where: { negocioId, fecha: fVentas },
          })) || 0,
        ) || 0;

      // ---- Retiros: no existe convención "retiro-%" en el código ----
      // Se devuelve 0 y un flag en la respuesta (retiroDefinido: false).
      const totalRetirado = 0;

      const gananciaNeta = gananciaBruta - gastosOperativos;
      const margenNetoPct = ventasTotales > 0 ? (gananciaNeta / ventasTotales) * 100 : 0;

      const resumen = {
        ventasTotales,
        cantidadVentas,
        ticketPromedio,
        costoMercaderia,
        gananciaBruta,
        margenBrutoPct,
        gastosOperativos,
        gananciaNeta,
        margenNetoPct,
        unidadesVendidas,
        totalComprometidoCompras: totalCompras,
        totalCobradoDeudores,
        totalRetirado,
      };

      if (!conIndicadores) return resumen;

      // ---- Días extremos de venta (por día, mismo criterio que estado de resultados) ----
      const porDia = await Venta.findAll({
        attributes: [
          [Sequelize.fn("DATE", Sequelize.col("fecha")), "dia"],
          [Sequelize.fn("SUM", Sequelize.col("total")), "total"],
        ],
        where: { negocioId, fecha: fVentas, estado: "completada" },
        group: [Sequelize.fn("DATE", Sequelize.col("fecha"))],
        order: [[Sequelize.fn("DATE", Sequelize.col("fecha")), "ASC"]],
        raw: true,
      });

      let diaMayorVenta = null;
      let diaMenorVenta = null;
      if (porDia.length > 0) {
        const dias = porDia
          .map((d) => ({ fecha: d.dia.slice(0, 10), total: parseFloat(d.total) || 0 }))
          .sort((a, b) => b.total - a.total);
        diaMayorVenta = dias[0];
        diaMenorVenta = dias[dias.length - 1];
      }

      // ---- Top productos: más unidades y más ingresos ----
      const topProductos = await VentaDetalle.findAll({
        attributes: [
          "productoId",
          [Sequelize.fn("SUM", Sequelize.col("VentaDetalle.cantidad")), "cantidad"],
          [Sequelize.fn("SUM", Sequelize.col("VentaDetalle.subtotal")), "ingresos"],
        ],
        include: [
          { model: Producto, as: "producto", attributes: ["id", "nombre"] },
          {
            model: Venta,
            as: "venta",
            where: { estado: "completada", fecha: fVentas },
            attributes: [],
          },
        ],
        where: { "$venta.negocio_id$": negocioId },
        group: ["productoId", "producto.id"],
      });

      const rankeados = topProductos.map((p) => ({
        producto: p.producto?.nombre || p.nombreProducto || "Producto",
        cantidad: parseFloat(p.getDataValue("cantidad")) || 0,
        ingresos: parseFloat(p.getDataValue("ingresos")) || 0,
      }));

      const porCantidad = [...rankeados].sort((a, b) => b.cantidad - a.cantidad);
      const porIngresos = [...rankeados].sort((a, b) => b.ingresos - a.ingresos);

      return {
        resumen,
        indicadores: {
          diaMayorVenta, // { fecha, total } — null si no hay ventas
          diaMenorVenta, // { fecha, total } — null si no hay ventas
          topProductoCantidad: porCantidad[0]
            ? { producto: porCantidad[0].producto, cantidad: porCantidad[0].cantidad }
            : null,
          topProductoIngresos: porIngresos[0]
            ? { producto: porIngresos[0].producto, ingresos: porIngresos[0].ingresos }
            : null,
        },
      };
    };

    const actual = await calcularPeriodo(periodoActual, true);
    const anterior = await calcularPeriodo(periodoAnterior, false);

    // variación %: ((actual - anterior) / |anterior|) * 100; null si anterior es 0
    const pct = (actual, anterior) =>
      anterior === 0 ? null : ((actual - anterior) / Math.abs(anterior)) * 100;

    const c = actual.resumen;
    const a = anterior;
    const comparativo = [
      { indicador: "Ventas", actual: c.ventasTotales, anterior: a.ventasTotales, variacion: pct(c.ventasTotales, a.ventasTotales), tipo: "pct", formato: "moneda" },
      { indicador: "Cantidad de ventas", actual: c.cantidadVentas, anterior: a.cantidadVentas, variacion: pct(c.cantidadVentas, a.cantidadVentas), tipo: "pct", formato: "numero" },
      { indicador: "Ticket promedio", actual: c.ticketPromedio, anterior: a.ticketPromedio, variacion: pct(c.ticketPromedio, a.ticketPromedio), tipo: "pct", formato: "moneda" },
      { indicador: "Costo de mercadería", actual: c.costoMercaderia, anterior: a.costoMercaderia, variacion: pct(c.costoMercaderia, a.costoMercaderia), tipo: "pct", formato: "moneda" },
      { indicador: "Ganancia bruta", actual: c.gananciaBruta, anterior: a.gananciaBruta, variacion: pct(c.gananciaBruta, a.gananciaBruta), tipo: "pct", formato: "moneda" },
      { indicador: "Margen bruto", actual: c.margenBrutoPct, anterior: a.margenBrutoPct, variacion: c.margenBrutoPct - a.margenBrutoPct, tipo: "pp", formato: "porcentaje" },
      { indicador: "Gastos operativos", actual: c.gastosOperativos, anterior: a.gastosOperativos, variacion: pct(c.gastosOperativos, a.gastosOperativos), tipo: "pct", formato: "moneda" },
      { indicador: "Ganancia neta", actual: c.gananciaNeta, anterior: a.gananciaNeta, variacion: pct(c.gananciaNeta, a.gananciaNeta), tipo: "pct", formato: "moneda" },
      { indicador: "Margen neto", actual: c.margenNetoPct, anterior: a.margenNetoPct, variacion: c.margenNetoPct - a.margenNetoPct, tipo: "pp", formato: "porcentaje" },
      { indicador: "Unidades vendidas", actual: c.unidadesVendidas, anterior: a.unidadesVendidas, variacion: pct(c.unidadesVendidas, a.unidadesVendidas), tipo: "pct", formato: "numero" },
      { indicador: "Total comprado", actual: c.totalComprometidoCompras, anterior: a.totalComprometidoCompras, variacion: pct(c.totalComprometidoCompras, a.totalComprometidoCompras), tipo: "pct", formato: "moneda" },
      { indicador: "Total cobrado deudores", actual: c.totalCobradoDeudores, anterior: a.totalCobradoDeudores, variacion: pct(c.totalCobradoDeudores, a.totalCobradoDeudores), tipo: "pct", formato: "moneda" },
      { indicador: "Total retirado", actual: c.totalRetirado, anterior: a.totalRetirado, variacion: pct(c.totalRetirado, a.totalRetirado), tipo: "pct", formato: "moneda" },
    ];

    return success(res, {
      periodoActual,
      periodoAnterior,
      resumen: c,
      indicadores: actual.indicadores,
      // Claves distintas por contrato: gastoOperativo (singular) y totalComprometidoCompras
      anterior: {
        ventasTotales: a.ventasTotales,
        cantidadVentas: a.cantidadVentas,
        ticketPromedio: a.ticketPromedio,
        costoMercaderia: a.costoMercaderia,
        gananciaBruta: a.gananciaBruta,
        margenBrutoPct: a.margenBrutoPct,
        gastoOperativo: a.gastosOperativos,
        gananciaNeta: a.gananciaNeta,
        margenNetoPct: a.margenNetoPct,
        unidadesVendidas: a.unidadesVendidas,
        totalComprometidoCompras: a.totalComprometidoCompras,
        totalCobradoDeudores: a.totalCobradoDeudores,
        totalRetirado: a.totalRetirado,
      },
      comparativo,
      // No existe una convención de "retiro" en el código: totalRetirado es 0
      retiroDefinido: false,
    });
  } catch (err) {
    console.error("Error en reporteGerencial:", err);
    return error(res, "Error al generar resumen gerencial: " + err.message, 500);
  }
};

/**
 * Análisis del negocio con semaforización automática (verde / amarillo / rojo).
 * Las métricas se calculan para el período consultado y se comparan contra el
 * período anterior de igual cantidad de días calendario (mismo criterio que el
 * resumen gerencial, lógica duplicada para mantener el archivo autocontenido).
 * Los umbrales de margen bruto se exponen en `umbrales` para que la UI pueda
 * mostrar "según umbrales configurados".
 * GET /api/reportes/analisis-negocio?fechaInicio=YYYY-MM-DD&fechaFin=YYYY-MM-DD
 */
const reporteAnalisisNegocio = async (req, res) => {
  try {
    const { fechaInicio, fechaFin } = req.query;

    if (!fechaInicio || !fechaFin) {
      return error(res, "Debe proporcionar fechaInicio y fechaFin", 400);
    }

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(fechaInicio) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(fechaFin)
    ) {
      return error(res, "Debe proporcionar fechas válidas (YYYY-MM-DD)", 400);
    }

    // Comparación de strings válida porque el formato es YYYY-MM-DD
    if (fechaFin < fechaInicio) {
      return error(res, "La fecha fin debe ser mayor o igual a la fecha inicio", 400);
    }

    const negocioId = req.filterCondition?.negocioId || req.user?.negocioId;

    // Período anterior: misma cantidad de días calendario, inmediatamente antes
    // (mismo cálculo que reporteGerencial, duplicado a propósito).
    const diffDays = Math.round(
      (new Date(fechaFin + "T12:00:00Z") -
        new Date(fechaInicio + "T12:00:00Z")) /
        86400000,
    );
    const inicioAnterior = new Date(fechaInicio + "T12:00:00Z");
    inicioAnterior.setUTCDate(inicioAnterior.getUTCDate() - (diffDays + 1));
    const finAnterior = new Date(fechaInicio + "T12:00:00Z");
    finAnterior.setUTCDate(finAnterior.getUTCDate() - 1);
    const toDate = (d) => d.toISOString().slice(0, 10);

    const periodoActual = { fechaInicio, fechaFin };
    const periodoAnterior = {
      fechaInicio: toDate(inicioAnterior),
      fechaFin: toDate(finAnterior),
    };

    // Redondeo para la respuesta: nunca NaN/Infinity en JSON.
    const redondear = (v, decimales = 1) => {
      if (v == null) return null;
      const f = Math.pow(10, decimales);
      return Math.round(v * f) / f;
    };

    /**
     * Resumen de un período con las MISMAS definiciones que reporteGerencial:
     * ventas totales (completadas), ticket promedio, margen bruto % y gastos
     * operativos (MovimientoCaja egreso sin referencia "compra-%" ni null).
     * Devuelve también las ventas con detalles (necesarias solo para calcular
     * el margen por producto del período actual).
     */
    const calcularResumen = async (periodo) => {
      const { fechaInicio: inicio, fechaFin: fin } = periodo;
      const fVentas = dateFilter(inicio, fin);

      const ventas = await Venta.findAll({
        where: { negocioId, fecha: fVentas, estado: "completada" },
        include: [
          {
            model: VentaDetalle,
            as: "detalles",
            include: [
              {
                model: Producto,
                as: "producto",
                attributes: ["id", "nombre", "precioCompra"],
              },
            ],
          },
        ],
      });

      let ventasTotales = 0;
      let subtotalVentas = 0;
      let costoMercaderia = 0;
      for (const v of ventas) {
        ventasTotales += parseFloat(v.total) || 0;
        for (const d of v.detalles || []) {
          subtotalVentas += parseFloat(d.subtotal) || 0;
          costoMercaderia +=
            (d.cantidad || 0) * (parseFloat(d.producto?.precioCompra) || 0);
        }
      }

      const cantidadVentas = ventas.length;
      const ticketPromedio = cantidadVentas > 0 ? ventasTotales / cantidadVentas : 0;
      // Margen calculado sobre subtotal de detalles (sin IVA), misma base que
      // los márgenes por producto del semáforo (subtotal vs costo). `ventasTotales`
      // (con IVA, desde venta.total) se mantiene solo para ventas/ticket.
      const margenBrutoPct =
        subtotalVentas > 0
          ? ((subtotalVentas - costoMercaderia) / subtotalVentas) * 100
          : 0;

      // Gastos operativos: misma definición que reporteGerencial / estado de resultados.
      // createdAt es TIMESTAMP UTC → ajustar a UTC-3 (Argentina) con INTERVAL.
      // parseFloat: SUM de mysql2 puede venir como string.
      const gastosOperativos =
        parseFloat(
          (await MovimientoCaja.sum("monto", {
            where: {
              negocioId,
              tipo: "egreso",
              createdAt: {
                [Op.gte]: Sequelize.literal(`'${inicio} 03:00:00'`),
                [Op.lt]: Sequelize.literal(
                  `'${fin}' + INTERVAL 1 DAY + INTERVAL 3 HOUR`,
                ),
              },
              [Op.or]: [
                { referencia: { [Op.notLike]: "compra-%" } },
                { referencia: null },
              ],
            },
          })) || 0,
        ) || 0;

      return {
        ventasTotales,
        cantidadVentas,
        ticketPromedio,
        costoMercaderia,
        margenBrutoPct,
        gastosOperativos,
        ventas,
      };
    };

    const actual = await calcularResumen(periodoActual);
    const anterior = await calcularResumen(periodoAnterior);

    // variación %: ((actual - anterior) / |anterior|) * 100; null si anterior es 0
    const pctVariacion = (valActual, valAnterior) =>
      valAnterior === 0 ? null : ((valActual - valAnterior) / Math.abs(valAnterior)) * 100;

    // Umbrales del semáforo (por ahora configurables solo desde acá):
    // margen bruto >= 25% verde · >= 15% amarillo · < 15% rojo.
    const umbrales = { margenVerde: 25, margenAmarillo: 15 };

    // ---- Margen por producto vendido en el período (a precio de compra vigente) ----
    // Sin historial de precios se valora con el precio actual (mismo criterio
    // que la pestaña Ganancias). Sin precio de costo no se puede calcular el
    // margen: esos productos cuentan como ROJO (margen no positivo / no computable).
    const porProducto = {};
    for (const v of actual.ventas) {
      for (const d of v.detalles || []) {
        if (!d.productoId) continue; // detalle sin producto asociado (producto borrado)
        const clave = String(d.productoId);
        if (!porProducto[clave]) {
          porProducto[clave] = {
            nombre: d.producto?.nombre || d.nombreProducto || "Producto",
            subtotal: 0,
            cantidad: 0,
            precioCompra: parseFloat(d.producto?.precioCompra) || 0,
          };
        }
        porProducto[clave].subtotal += parseFloat(d.subtotal) || 0;
        porProducto[clave].cantidad += d.cantidad || 0;
      }
    }

    const margenBajo = [];
    const margenNoPositivo = [];
    for (const p of Object.values(porProducto)) {
      if (p.subtotal <= 0) continue; // sin venta real, no se puede evaluar
      const sinCosto = p.precioCompra == null || p.precioCompra === 0;
      const costo = p.cantidad * p.precioCompra;
      const ganancia = p.subtotal - costo;
      const margenPct = p.subtotal > 0 ? (ganancia / p.subtotal) * 100 : 0;
      const item = {
        nombre: p.nombre,
        margenPct: sinCosto ? null : redondear(margenPct),
        ganancia: sinCosto ? null : redondear(ganancia, 2),
      };
      if (sinCosto || margenPct <= 0) {
        margenNoPositivo.push(item);
      } else if (margenPct < umbrales.margenAmarillo) {
        margenBajo.push(item);
      }
    }

    margenBajo.sort((a, b) => a.margenPct - b.margenPct); // menores primero (más riesgosos)
    // null (sin costo) al final: null - número da 0 en JS, hay que forzar la clave
    const sortKeyMargen = (m) => (m == null ? Number.MAX_SAFE_INTEGER : m);
    margenNoPositivo.sort(
      (a, b) => sortKeyMargen(a.margenPct) - sortKeyMargen(b.margenPct),
    );

    // ---- Productos sin movimiento: activos del negocio que NO vendieron ----
    const productosActivos = await Producto.findAll({
      where: { negocioId, activo: true },
      attributes: ["id", "nombre"],
      order: [["nombre", "ASC"]],
    });
    const idsVendidos = new Set(Object.keys(porProducto).map(Number));
    const productosSinMovimiento = productosActivos.filter(
      (p) => !idsVendidos.has(p.id),
    );
    const nombresSinMovimiento = productosSinMovimiento
      .slice(0, 20)
      .map((p) => p.nombre);

    // ---- Deudores con saldo pendiente ----
    // El modelo ClienteDeudor NO tiene fecha de vencimiento ni estado ("estado" no
    // existe en la tabla). Definición aplicada (fallback del contrato): deudores
    // ACTIVOS del negocio con deudaPendiente > 0 (columna deuda_pendiente = saldo).
    const deudoresPendientes = await ClienteDeudor.findAll({
      where: { negocioId, activo: true, deudaPendiente: { [Op.gt]: 0 } },
      attributes: ["id", "nombre", "deudaPendiente"],
      order: [["deudaPendiente", "DESC"]],
    });
    const detalleDeudores = deudoresPendientes.slice(0, 20).map((d) => ({
      deudor: d.nombre,
      montoPendiente: parseFloat(d.deudaPendiente) || 0,
    }));

    // ---- Semaforización ----
    const variacionVentas = redondear(pctVariacion(actual.ventasTotales, anterior.ventasTotales));
    const variacionGastos = redondear(pctVariacion(actual.gastosOperativos, anterior.gastosOperativos));
    const variacionTicket = redondear(pctVariacion(actual.ticketPromedio, anterior.ticketPromedio));

    // null => período anterior sin datos para comparar: no hay regresión, se trata como verde.
    const colorVariacion = (variacion) =>
      variacion == null ? "verde" : variacion >= 0 ? "verde" : "rojo";

    // Gastos: si el anterior era 0 y ahora hay gastos, subieron (rojo).
    const colorVariacionGastos = () => {
      if (variacionGastos == null) {
        return actual.gastosOperativos > 0 ? "rojo" : "verde";
      }
      return variacionGastos <= 0 ? "verde" : "rojo";
    };

    const margenBrutoValor = redondear(actual.margenBrutoPct);
    const colorMargenBruto =
      margenBrutoValor >= umbrales.margenVerde
        ? "verde"
        : margenBrutoValor >= umbrales.margenAmarillo
          ? "amarillo"
          : "rojo";

    // Luz de conteo: si no hay casos, la luz NO es "roja"/"amarilla" (no hay nada
    // que atender). El nombre es "pendiente", no "vencido": el modelo ClienteDeudor
    // no tiene fecha de vencimiento ni estado, solo saldo (deudaPendiente).
    const colorConteo = (cantidad, colorConCasos) =>
      cantidad > 0 ? colorConCasos : "verde";

    return success(res, {
      periodo: { fechaInicio, fechaFin },
      periodoAnterior,
      umbrales,
      semaforo: {
        margenBruto: { valor: margenBrutoValor, color: colorMargenBruto },
        productosMargenBajo15: {
          cantidad: margenBajo.length,
          color: colorConteo(margenBajo.length, "amarillo"),
        },
        productosMargenNoPositivo: {
          cantidad: margenNoPositivo.length,
          color: colorConteo(margenNoPositivo.length, "rojo"),
        },
        variacionVentas: { variacionPct: variacionVentas, color: colorVariacion(variacionVentas) },
        variacionGastos: { variacionPct: variacionGastos, color: colorVariacionGastos() },
        variacionTicket: { variacionPct: variacionTicket, color: colorVariacion(variacionTicket) },
        productosSinMovimiento: {
          cantidad: productosSinMovimiento.length,
          color: colorConteo(productosSinMovimiento.length, "amarillo"),
        },
        deudoresPendientes: {
          cantidad: deudoresPendientes.length,
          color: colorConteo(deudoresPendientes.length, "rojo"),
        },
      },
      detalle: {
        productosMargenBajo: margenBajo.slice(0, 10),
        productosNoPositivos: margenNoPositivo.slice(0, 10),
        productosSinMovimiento: nombresSinMovimiento,
        deudoresPendientes: detalleDeudores,
      },
    });
  } catch (err) {
    console.error("Error en reporteAnalisisNegocio:", err);
    return error(res, "Error al generar análisis del negocio: " + err.message, 500);
  }
};

/**
 * Valida los parámetros de período (fechaInicio/fechaFin) con el mismo estilo
 * de mensajes que los reportes existentes. Devuelve un string con el error o null.
 * @returns {string|null}
 */
function validarPeriodo(fechaInicio, fechaFin) {
  if (!fechaInicio || !fechaFin) {
    return "Debe proporcionar fechaInicio y fechaFin";
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(fechaInicio) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(fechaFin)
  ) {
    return "Debe proporcionar fechas válidas (YYYY-MM-DD)";
  }
  // La fecha debe ser REAL (ej: 2026-02-31 no existe aunque pase el regex).
  // Round-trip: el parser ISO de JS hace rollover, así que hay que comparar
  // los componentes para detectar días inválidos (02-31 → 03-03).
  const esFechaReal = (fecha) => {
    const d = new Date(fecha + "T12:00:00Z");
    if (isNaN(d.getTime())) return false;
    const [y, m, day] = fecha.split("-").map(Number);
    return (
      d.getUTCFullYear() === y &&
      d.getUTCMonth() + 1 === m &&
      d.getUTCDate() === day
    );
  };
  if (!esFechaReal(fechaInicio) || !esFechaReal(fechaFin)) {
    return "Debe proporcionar fechas válidas (YYYY-MM-DD)";
  }
  // Comparación de strings válida porque el formato es YYYY-MM-DD
  if (fechaFin < fechaInicio) {
    return "La fecha fin debe ser mayor o igual a la fecha inicio";
  }
  return null;
}

/**
 * Reporte de stock: productos del negocio con resumen de existencias.
 * GET /api/reportes/stock
 */
const reporteStock = async (req, res) => {
  try {
    const where = {
      ...req.filterCondition,
    };

    // Sin fechas: es el estado ACTUAL del inventario del negocio.
    const productos = await Producto.findAll({
      where,
      attributes: [
        "id",
        "nombre",
        "codigo",
        "precio",
        "precioCompra",
        "stock",
        "stockMinimo",
        "activo",
      ],
      order: [["nombre", "ASC"]],
    });

    const totalProductos = productos.length;
    const activos = productos.filter((p) => p.activo);
    // El modelo Producto SÍ tiene stockMinimo (columna stock_minimo, default 5).
    // "Stock bajo" = producto activo con stock <= (stockMinimo || 0).
    const stockBajo = activos.filter((p) => {
      const minimo = parseInt(p.stockMinimo, 10) || 0;
      return p.stock <= minimo;
    });
    const sinStock = activos.filter((p) => p.stock <= 0);

    return success(res, {
      resumen: {
        totalProductos,
        activos: activos.length,
        stockBajo: stockBajo.length,
        sinStock: sinStock.length,
      },
      stockBajo: stockBajo.map((p) => ({
        id: p.id,
        nombre: p.nombre,
        codigo: p.codigo,
        stock: p.stock,
        stockMinimo: p.stockMinimo != null ? parseInt(p.stockMinimo, 10) : null,
      })),
      list: productos.map((p) => ({
        id: p.id,
        nombre: p.nombre,
        codigo: p.codigo,
        precio: parseFloat(p.precio) || 0,
        precioCompra: parseFloat(p.precioCompra) || 0,
        stock: p.stock,
        activo: p.activo,
      })),
    });
  } catch (err) {
    console.error("Error en reporteStock:", err);
    return error(res, "Error al generar reporte de stock: " + err.message, 500);
  }
};

/**
 * Reporte de gastos: egresos manuales de caja en el período.
 * Misma definición que gastosOperativos en reporteGerencial:
 * MovimientoCaja tipo "egreso", createdAt ajustado a UTC-3 (Argentina) con
 * INTERVAL 3 HOUR, y referencia que NO empieza con "compra-" (esas se
 * cuentan como compras en el estado de resultados).
 * GET /api/reportes/gastos?fechaInicio=YYYY-MM-DD&fechaFin=YYYY-MM-DD
 */
const reporteGastos = async (req, res) => {
  try {
    const { fechaInicio, fechaFin } = req.query;

    const errorValidacion = validarPeriodo(fechaInicio, fechaFin);
    if (errorValidacion) {
      return error(res, errorValidacion, 400);
    }

    const negocioId = req.filterCondition?.negocioId || req.user?.negocioId;

    const movimientos = await MovimientoCaja.findAll({
      where: {
        negocioId,
        tipo: "egreso",
        createdAt: {
          [Op.gte]: Sequelize.literal(`'${fechaInicio} 03:00:00'`),
          [Op.lt]: Sequelize.literal(
            `'${fechaFin}' + INTERVAL 1 DAY + INTERVAL 3 HOUR`,
          ),
        },
        [Op.or]: [
          { referencia: { [Op.notLike]: "compra-%" } },
          { referencia: null },
        ],
      },
      include: [
        {
          model: User,
          as: "usuario",
          attributes: ["id", "nombre", "email"],
        },
      ],
      order: [["createdAt", "ASC"]],
    });

    const totalGastos = movimientos.reduce(
      (sum, m) => sum + parseFloat(m.monto),
      0,
    );

    return success(res, {
      resumen: {
        totalGastos,
        cantidadMovimientos: movimientos.length,
      },
      detalle: movimientos.map((m) => ({
        id: m.id,
        concepto: m.concepto,
        monto: parseFloat(m.monto),
        referencia: m.referencia,
        fecha: m.createdAt,
        usuario: m.usuario,
      })),
    });
  } catch (err) {
    console.error("Error en reporteGastos:", err);
    return error(
      res,
      "Error al generar reporte de gastos: " + err.message,
      500,
    );
  }
};

/**
 * Reporte de compras: compras completadas en el período.
 * GET /api/reportes/compras?fechaInicio=YYYY-MM-DD&fechaFin=YYYY-MM-DD
 */
const reporteCompras = async (req, res) => {
  try {
    const { fechaInicio, fechaFin } = req.query;

    const errorValidacion = validarPeriodo(fechaInicio, fechaFin);
    if (errorValidacion) {
      return error(res, errorValidacion, 400);
    }

    const where = {
      ...req.filterCondition,
      fecha: dateFilter(fechaInicio, fechaFin),
      estado: "completada",
    };

    const compras = await Compra.findAll({
      where,
      include: [
        {
          model: Proveedor,
          as: "proveedor",
          attributes: ["id", "nombre"],
        },
      ],
      order: [["fecha", "DESC"]],
    });

    const totalCompras = compras.reduce(
      (sum, c) => sum + parseFloat(c.total),
      0,
    );
    const cantidadCompras = compras.length;

    return success(res, {
      resumen: {
        totalCompras,
        cantidadCompras,
        promedio: cantidadCompras > 0 ? totalCompras / cantidadCompras : 0,
      },
      detalle: compras.map((c) => ({
        id: c.id,
        folio: c.folio,
        fecha: c.fecha,
        total: parseFloat(c.total),
        proveedor: c.proveedor || null,
        estado: c.estado,
      })),
    });
  } catch (err) {
    console.error("Error en reporteCompras:", err);
    return error(
      res,
      "Error al generar reporte de compras: " + err.message,
      500,
    );
  }
};

/**
 * Reporte de deudores: clientes con saldo pendiente y cobros del período.
 * Misma definición de "deudor con saldo" que el análisis del negocio:
 * ClienteDeudor activo del negocio con deudaPendiente > 0.
 * GET /api/reportes/deudores?fechaInicio=YYYY-MM-DD&fechaFin=YYYY-MM-DD
 */
const reporteDeudores = async (req, res) => {
  try {
    const { fechaInicio, fechaFin } = req.query;

    const errorValidacion = validarPeriodo(fechaInicio, fechaFin);
    if (errorValidacion) {
      return error(res, errorValidacion, 400);
    }

    const negocioId = req.filterCondition?.negocioId || req.user?.negocioId;

    // ---- Deudores con saldo (misma consulta que reporteAnalisisNegocio) ----
    const deudores = await ClienteDeudor.findAll({
      where: { negocioId, activo: true, deudaPendiente: { [Op.gt]: 0 } },
      attributes: ["nombre", "deudaPendiente"],
      order: [["deudaPendiente", "DESC"]],
    });

    const totalPendiente = deudores.reduce(
      (sum, d) => sum + parseFloat(d.deudaPendiente),
      0,
    );

    // ---- Cobrado en el período: SUMA real de todos los pagos (no limitada) ----
    // Mismo criterio que totalCobradoDeudores en reporteGerencial.
    // parseFloat: SUM de mysql2 puede venir como string.
    const cobradoPeriodo =
      parseFloat(
        (await PagoDeuda.sum("monto", {
          where: { negocioId, fecha: dateFilter(fechaInicio, fechaFin) },
        })) || 0,
      ) || 0;

    // ---- Cobros del período (detalle con su deudor, limit 50) ----
    // Consulta SEPARADA de la suma: el limit 50 aplica solo al listado.
    const cobros = await PagoDeuda.findAll({
      where: { negocioId, fecha: dateFilter(fechaInicio, fechaFin) },
      include: [
        {
          model: ClienteDeudor,
          as: "deudor",
          attributes: ["nombre"],
        },
      ],
      order: [["fecha", "DESC"]],
      limit: 50,
    });

    return success(res, {
      resumen: {
        totalPendiente,
        cantidadDeudores: deudores.length,
        cobradoPeriodo,
      },
      detalle: deudores.map((d) => ({
        nombre: d.nombre,
        deudaPendiente: parseFloat(d.deudaPendiente),
      })),
      cobrosPeriodo: cobros.map((p) => ({
        deudor: p.deudor?.nombre || "Sin deudor",
        monto: parseFloat(p.monto),
        fecha: p.fecha,
      })),
    });
  } catch (err) {
    console.error("Error en reporteDeudores:", err);
    return error(
      res,
      "Error al generar reporte de deudores: " + err.message,
      500,
    );
  }
};

module.exports = {
  reporteVentas,
  reporteProductosMasVendidos,
  reporteCaja,
  reporteEstadoResultados,
  reporteGerencial,
  reporteAnalisisNegocio,
  reporteStock,
  reporteGastos,
  reporteCompras,
  reporteDeudores,
};
