/**
 * The ten report screens, over the real handlers.
 *
 * THIS IS A THIN LAYER AND THAT IS THE POINT.
 *
 * The screen names a `(group, op)` pair and a date range, and nothing else. In particular it does
 * not name a tenant, because `negocioId` is filled in by main from the signed-in session
 * (`ipc/call` → `identity.negocioId`) and the renderer has no way to express a different one — the
 * payload this file builds has no such key, and `limpiar()` in `api/ipc.js` would drop it if it
 * had one. A screen that could pick its own tenant would be a screen that could read another
 * shop's money, so the absence of the key is the security property and it is worth stating here:
 * the ONLY way a report gets a business is from the session.
 *
 * WHY THE ARGUMENTS ARE THE RENDERER'S UNITS. `llamar()`'s contract says a payload is in pesos
 * and kilos and main converts. Every report here is a READ, and reads do not convert: the reports
 * take `fechaInicio`/`fechaFin` as `YYYY-MM-DD` local days and answer in the same shape they
 * already use elsewhere in the app — `*Centavos`, `*Milli`. Inventing a second conversion layer for
 * display would be a place for the two sides to disagree about a total, and the whole reason
 * `shared/money.js` exists is that there is one such place.
 */
import { llamar } from './ipc'

/**
 * Drop a range that is not filled in, and refuse one that is inverted.
 *
 * `limpiar()` in `api/ipc.js` already drops `null`/`undefined`/`''`, so an untouched date input
 * would arrive at main as "no range" and the report would silently answer for the CURRENT month.
 * That is a reasonable default and a terrible one to arrive at by accident, so the screen checks
 * first and says which field is missing. A report that quietly answered a different question than
 * the one asked is worse than one that refuses.
 */
function rango({ fechaInicio, fechaFin }, etiqueta) {
  if (!fechaInicio || !fechaFin) {
    throw new Error(`${etiqueta}: elegí la fecha de inicio y la de fin antes de consultar.`)
  }
  if (fechaInicio > fechaFin) {
    throw new Error(`${etiqueta}: la fecha de inicio es posterior a la de fin.`)
  }
  return { fechaInicio, fechaFin }
}

/**
 * THE TEN REPORTS, one function each, named for the screen rather than for the operation.
 *
 * The names mirror the contract exactly. `reportes.sales` is `reporteVentas` here and `ventas` on
 * the page, and a reader who has one of the three in front of them can find the other two: a
 * translation layer with a different name per layer is a translation layer nobody can grep.
 */
export const reportesAPI = {
  /** Sales in the window, with each ticket's lines. */
  ventas: (rangoFechas) => llamar('reportes', 'sales', rango(rangoFechas, 'Ventas')),

  /** What moved most, by units, with the money each brought in. */
  productosMasVendidos: (rangoFechas, limit = 50) =>
    llamar('reportes', 'topProducts', { ...rango(rangoFechas, 'Productos'), limit }),

  /** The till: its movements, and the drawer against account `1.1.01`. Takes NO dates. */
  caja: (cajaId) => llamar('reportes', 'cash', cajaId === undefined ? {} : { cajaId }),

  /** The statement of results, read out of the ledger. */
  estadoResultados: (rangoFechas) =>
    llamar('reportes', 'incomeStatement', rango(rangoFechas, 'Estado de resultados')),

  /** This window against the one before it. */
  gerencial: (rangoFechas) => llamar('reportes', 'managerial', rango(rangoFechas, 'Resumen gerencial')),

  /** The diagnosis: low margins, dead stock, who owes. */
  analisisNegocio: (rangoFechas) =>
    llamar('reportes', 'businessAnalysis', rango(rangoFechas, 'Análisis del negocio')),

  /** The shelf as it is NOW. Takes no dates, and this file does not offer any. */
  stock: () => llamar('reportes', 'stock', {}),

  /** The owner's own outgoings: neither a purchase nor a refund. */
  gastos: (rangoFechas) => llamar('reportes', 'expenses', rango(rangoFechas, 'Gastos')),

  /** What was bought from suppliers, paid or not. */
  compras: (rangoFechas) => llamar('reportes', 'purchases', rango(rangoFechas, 'Compras')),

  /** Who owes, and what was collected in the window. */
  deudores: (rangoFechas) => llamar('reportes', 'debtors', rango(rangoFechas, 'Deudores'))
}

/**
 * The home screen's numbers.
 *
 * `periodo` is one of `day`, `week`, `month`, `year` — the web's four presets, counted back from
 * the CURRENT LOCAL DAY, which main decides. There is no `hoy` parameter and no `fechaInicio` here
 * on purpose: a dashboard whose window the renderer chose is a dashboard that can be made to say
 * anything.
 */
export const dashboardAPI = {
  stats: (periodo = 'month') => llamar('dashboard', 'stats', { periodo })
}
