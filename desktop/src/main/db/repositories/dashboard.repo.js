import { IpcError } from '../../bridge/errors.js'
import { assertCents } from '../../../shared/money.js'
import { enumerarDias, hoyLocal as hoyLocalDe, modificadorIso, rangoPeriodo, sumarDias } from '../reportes/fechas.js'
import { centavos, entero } from '../reportes/metricas.js'

/**
 * The numbers on the first screen: what the shop sold, what is left on the shelf, who owes.
 *
 * TWO CHANGES FROM THE WEB'S `getStats`, both because its window is wrong rather than merely ugly.
 *
 * THE WINDOW. The web does
 *
 *     whereVenta.fecha = { [Op.gte]: new Date(...).toISOString().slice(0, 10) }
 *
 * which is a bare `YYYY-MM-DD` compared against a DATETIME column. MySQL coerces the column to
 * that date at MIDNIGHT, so on any day that is not the first the dashboard counts zero sales
 * after 00:00 — the busiest part of the day — and the shop sees an empty panel next to a till full
 * of money. Every window here is a half-open local interval from `fechas.js`, and the "last seven
 * days" series is built by enumerating the seven local days and filling them, rather than by asking
 * the database for whatever it happens to have.
 *
 * THE DAYS. The web computes the seven labels with `new Date()` in the server's own timezone and
 * the values with `DATE(fecha)` in the database's, and joins them on a string. Between those two
 * zones the labels and the values are of DIFFERENT DAYS, and the chart silently plots Monday's
 * money under Tuesday. Here the days are enumerated once, in local time, and each row is looked up
 * by its own `YYYY-MM-DD` key.
 *
 * `periodo` accepts the web's four values and answers all of them with the same arithmetic: a
 * window of N days ending on the current LOCAL day.
 */

const DIAS_SEMANA = Object.freeze(['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'])

/** How many local days back each of the web's four presets reaches. */
const PRESETS = Object.freeze({ day: 1, week: 7, month: 30, year: 365 })

export function dashboardStats(ctx, payload, { ahora = new Date(), offsetMin } = {}) {
  const db = ctx.db
  const hoy = hoyLocalDe(ahora, offsetMin)
  const modificador = modificadorIso(offsetMin)
  const requested = payload?.periodo ?? 'month'

  const dias = PRESETS[requested]
  if (dias === undefined) {
    throw new IpcError(
      'DASHBOARD_PERIODO_INVALIDO',
      400,
      `periodo inválido: ${JSON.stringify(requested)}. Se espera uno de: ${Object.keys(PRESETS).join(', ')}.`
    )
  }
  const desde = sumarDias(hoy, -(dias - 1))
  const { desde: desdeUtc, hasta } = rangoPeriodo(desde, hoy, offsetMin)

  // ---- 1. sales in the window --------------------------------------------------------------
  const ventasTotales = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total_centavos), 0) AS ingresos
         FROM ventas
        WHERE negocio_id = ? AND estado = 'completada' AND deleted_at IS NULL
          AND fecha >= ? AND fecha < ?`
    )
    .get(ctx.negocioId, desdeUtc, hasta)

  const porMetodo = db
    .prepare(
      `SELECT metodo_pago, COUNT(*) AS cantidad, COALESCE(SUM(total_centavos), 0) AS total
         FROM ventas
        WHERE negocio_id = ? AND estado = 'completada' AND deleted_at IS NULL
          AND fecha >= ? AND fecha < ?
        GROUP BY metodo_pago
        ORDER BY total DESC`
    )
    .all(ctx.negocioId, desdeUtc, hasta)

  // ---- 2. the last seven local days, with the gaps filled ------------------------------------
  const siete = enumerarDias(sumarDias(hoy, -6), hoy)
  const rangoSiete = rangoPeriodo(siete[0], siete[siete.length - 1], offsetMin)
  const porDia = db
    .prepare(
      `SELECT date(v.fecha, ?) AS dia, COALESCE(SUM(v.total_centavos), 0) AS total
         FROM ventas v
        WHERE v.negocio_id = ? AND v.estado = 'completada' AND v.deleted_at IS NULL
          AND v.fecha >= ? AND v.fecha < ?
        GROUP BY dia`
    )
    .all(modificador, ctx.negocioId, rangoSiete.desde, rangoSiete.hasta)

  const mapaDia = new Map(porDia.map((d) => [d.dia, d.total]))
  const diarias = siete.map((dia) => ({
    fecha: dia,
    day: nombreDeDia(dia),
    valueCentavos: centavos(mapaDia.get(dia), `ventas del ${dia}`)
  }))

  // ---- 3. products ---------------------------------------------------------------------------
  const productosResumen = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN activo = 1 AND stock_milli <= 0 THEN 1 ELSE 0 END), 0) AS sin_stock,
              COALESCE(SUM(CASE WHEN activo = 1 AND stock_milli <= stock_minimo_milli THEN 1 ELSE 0 END), 0) AS bajo_stock,
              COALESCE(SUM(CASE WHEN activo = 1 THEN 1 ELSE 0 END), 0) AS activos
         FROM productos
        WHERE negocio_id = ? AND deleted_at IS NULL`
    )
    .get(ctx.negocioId)

  // THE TENANT IS THE SALE'S, NOT THE LINE'S, because `ventas_detalles` HAS NO `negocio_id`
  // column. Writing `d.negocio_id` — which reads like every other query in this repo and is the
  // obvious thing to type — is `no such column` on this schema, and it takes the panel's whole top
  // list down with it. This is the SECOND place in this codebase that had to learn it;
  // `reportes.repo.js`'s `resumenVentas` carries the same note, and `tests/db/ventas.spec.js` a
  // third. Scoping goes through the `ventas` row, which owns the tenant.
  const topVendidos = db
    .prepare(
      `SELECT d.producto_id,
              p.nombre, p.unidad_medida, p.codigo, p.stock_milli,
              SUM(d.cantidad_milli) AS cantidad_milli,
              SUM(d.subtotal_centavos) AS ingresos_centavos
          FROM ventas_detalles d
          JOIN ventas v ON v.id = d.venta_id
          LEFT JOIN productos p ON p.id = d.producto_id AND p.negocio_id = v.negocio_id
         WHERE v.negocio_id = ? AND v.estado = 'completada' AND v.deleted_at IS NULL
           AND v.fecha >= ? AND v.fecha < ?
         GROUP BY d.producto_id
        ORDER BY cantidad_milli DESC
        LIMIT 5`
    )
    .all(ctx.negocioId, desdeUtc, hasta)

  // ---- 4. debtors ------------------------------------------------------------------------------
  const deudores = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(deuda_pendiente_centavos), 0) AS pendiente,
              COALESCE(SUM(deuda_total_centavos), 0) AS historico
         FROM v_clientes_deudores
        WHERE negocio_id = ? AND activo = 1 AND deleted_at IS NULL`
    )
    .get(ctx.negocioId)

  // ---- 5. the last five sales, ANY of them, not only this window's -----------------------------
  const recientes = db
    .prepare(
      `SELECT v.id, v.folio, v.total_centavos, v.estado, v.created_at,
              d.nombre AS deudor
         FROM ventas v
         LEFT JOIN clientes_deudores d ON d.id = v.deudor_id AND d.negocio_id = v.negocio_id
        WHERE v.negocio_id = ? AND v.deleted_at IS NULL
        ORDER BY v.created_at DESC, v.id DESC
        LIMIT 5`
    )
    .all(ctx.negocioId)

  return {
    periodo: { valor: requested, fechaInicio: desde, fechaFin: hoy, dias },
    ventas: {
      total: entero(ventasTotales.n, 'ventas del período'),
      ingresosCentavos: centavos(ventasTotales.ingresos, 'ingresos del período'),
      porMetodo: porMetodo.map((m) => ({
        metodoPago: m.metodo_pago,
        cantidad: entero(m.cantidad, 'ventas por método'),
        totalCentavos: assertCents(m.total, 'total por método')
      })),
      diarias,
      recientes: recientes.map((v) => ({
        id: v.id,
        folio: v.folio || `V${v.id}`,
        clienteNombre: v.deudor ?? 'Mostrador',
        totalCentavos: assertCents(v.total_centavos, 'total de venta'),
        estado: v.estado,
        fecha: v.created_at
      }))
    },
    productos: {
      total: entero(productosResumen.total, 'productos'),
      activos: entero(productosResumen.activos, 'productos activos'),
      sinStock: entero(productosResumen.sin_stock, 'productos sin stock'),
      bajoStock: entero(productosResumen.bajo_stock, 'productos con stock bajo'),
      topVendidos: topVendidos.map((p) => ({
        productoId: p.producto_id,
        nombre: p.producto_id === null ? 'Venta libre' : (p.nombre ?? 'Producto'),
        codigo: p.codigo,
        unidadMedida: p.unidad_medida ?? 'unidad',
        stockMilli: entero(p.stock_milli ?? 0, 'stock'),
        cantidadMilli: entero(p.cantidad_milli, 'cantidad vendida'),
        ingresosCentavos: assertCents(p.ingresos_centavos, 'ingresos del producto')
      }))
    },
    deudores: {
      total: entero(deudores.total, 'deudores'),
      deudaTotalCentavos: assertCents(deudores.pendiente, 'deuda total'),
      deudaHistoricaCentavos: assertCents(deudores.historico, 'deuda histórica')
    }
  }
}

/** `2026-10-01` -> `Jueves`. Built from UTC so it cannot depend on the host's zone. */
function nombreDeDia(fecha) {
  const [anio, mes, dia] = fecha.split('-').map(Number)
  const indice = new Date(Date.UTC(anio, mes - 1, dia)).getUTCDay()
  return DIAS_SEMANA[indice]
}
