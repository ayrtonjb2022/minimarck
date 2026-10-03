import { IpcError } from '../../bridge/errors.js'
import { assertCents } from '../../../shared/money.js'
import { lineTotalCentavos } from '../../../shared/qty.js'
import { saldoGeneral, saldoCaja, cajaActiva } from './cajas.repo.js'
import { CUENTA } from './cuentas.repo.js'
import {
  cantidadDias,
  enumerarDias,
  exigirFecha,
  modificadorIso,
  periodoAnterior,
  rangoPeriodo
} from '../reportes/fechas.js'
import {
  centavos,
  diferenciaPuntos,
  entero,
  margenPct,
  promedioCentavos,
  saldoDeTipo,
  tasa,
  variacionPct
} from '../reportes/metricas.js'

/**
 * The ten owner-facing reports, over the real SQLite database.
 *
 * THREE RULES SHAPE EVERY FUNCTION HERE, and each one is a divergence from the web on purpose.
 *
 * 1. MONEY LEAVES AS INTEGER CENTAVOS. The web returns `parseFloat(v.total)` — a float in pesos —
 *    and every total on every tab is the sum of values that were each already rounded once. This
 *    module aggregates the `*_centavos` columns directly and never divides by 100, so a figure
 *    reaches the renderer exact and the only place pesos exist is `formatCents`. A report is a
 *    reconciliation document: a total that is off by one centavo is a question the owner has to
 *    ask the software, and the answer has to be "it is not".
 *
 * 2. A DAY IS A LOCAL DAY. Every window is `[local midnight, next local midnight)` computed by
 *    `fechas.js`, and every per-day grouping is `date(column, <offset modifier>)`. The web hardcodes
 *    `INTERVAL 3 HOUR` in seven queries and one of its dashboards compares a bare `'YYYY-MM-DD'`
 *    against a timestamp column, which drops every sale after midnight. See the header of
 *    `fechas.js`.
 *
 * 3. A TILL MOVEMENT IS CLASSIFIED BY `origen`, NOT BY A PREFIX ON `referencia`. This is the change
 *    with the most teeth. The web decides "is this an operating expense?" with
 *    `referencia NOT LIKE 'compra-%'`, but this app writes `compra:{id}` and `compra-cancel:{id}`
 *    (`compras.repo.js:316,615`) — no hyphen — so the web's own test does not match what the
 *    desktop produces, and a cash purchase would be counted as an expense as well as a purchase.
 *    `origen` is CHECK-constrained to a five-word vocabulary
 *    (`'venta','compra','caja_apertura','caja_cierre','manual'`), and each word means exactly one
 *    thing, so every classification below is an equality against a value the schema guarantees.
 *
 * WHAT THE MOVEMENT VOCABULARY MEANS, which is the whole of rules 1-3 in one table:
 *
 *   origen          tipo      what it is                              counted in
 *   venta           ingreso   a sale                                  sales
 *   venta           egreso    a cancelled sale, money back to drawer  sales, negative
 *   compra          egreso    a purchase paid from the drawer         purchases
 *   compra          ingreso   a cancelled purchase, money back        purchases, negative
 *   manual          egreso    an expense the owner entered            expenses
 *   manual          ingreso   a debtor's payment, collected           collections
 *   caja_apertura   ingreso   the float the shift started with        opening
 *
 * A debtor's payment is an `ingreso` with `origen='manual'` (`deudores.repo.js:486`), which is
 * why "operating expense" can be written as `tipo='egreso' AND origen='manual'` with no prefix
 * test and no risk of counting money the shop collected as money it spent.
 */

/** The till vocabulary, as SQL fragments. Named so a call site never spells a literal. */
const ORIGEN = Object.freeze({
  VENTA: "'venta'",
  COMPRA: "'compra'",
  MANUAL: "'manual'"
})

/**
 * Resolve a report window from its payload, defaulting both ends to the local day.
 *
 * A period is refused rather than repaired: `fechaFin < fechaInicio` means the caller built the
 * range backwards, and silently swapping the ends would return a plausible-looking report for a
 * period nobody asked about. The default window is the local day of `hoyLocal()`, NOT
 * `toISOString().slice(0, 10)` — the web's default, which returns yesterday's date for the first
 * three hours of every local morning.
 */
export function resolverPeriodo(payload, { hoyLocal, offsetMin }) {
  const fechaFin = exigirFecha(payload?.fechaFin ?? hoyLocal, 'fechaFin')
  const fechaInicio = exigirFecha(payload?.fechaInicio ?? fechaFin, 'fechaInicio')
  if (fechaFin < fechaInicio) {
    throw new IpcError(
      'REPORTE_PERIODO_INVALIDO',
      400,
      `fechaFin (${fechaFin}) es anterior a fechaInicio (${fechaInicio}).`
    )
  }
  return {
    fechaInicio,
    fechaFin,
    offsetMin,
    modificador: modificadorIso(offsetMin),
    ...rangoPeriodo(fechaInicio, fechaFin, offsetMin)
  }
}

/** `asientos_contables` + `detalles_asientos` + `cuentas_contables`, the ledger, joined once. */
const FROM_LEDGER = `
  FROM asientos_contables a
  JOIN detalles_asientos d
    ON d.asiento_contable_id = a.id AND d.negocio_id = a.negocio_id
  JOIN cuentas_contables c
    ON c.id = d.cuenta_contable_id AND c.negocio_id = d.negocio_id`

/**
 * A completed sale in the window: totals, and the cost of the goods on its lines.
 *
 * `costoMercaderia` is computed in JAVASCRIPT and not in SQL, and the reason is an overflow rather
 * than a preference. The schema allows `costo_unitario_centavos` up to `MAX_CENTS` (1e15) and
 * `cantidad_milli` up to 1e12, and their product is 1e27 — a thousand times past
 * `Number.MAX_SAFE_INTEGER` and, in SQLite, past the integer range too, where a multiplication
 * silently promotes to REAL and returns a DIFFERENT number. `lineTotalCentavos` does the product,
 * the division and the rounding in `BigInt` and has a test for it, so the lines are read and
 * summed here rather than trusting SQL with a multiply it cannot hold.
 *
 * AND THE CUSTOMER'S NAME IS THE DEBTOR'S, when there is one. A credit sale writes `deudor_id` and
 * leaves `ventas.cliente_nombre` empty, so reading that column alone printed "Mostrador" — the
 * counter — on a ticket the customer walked away from owing money, which is exactly the row an
 * owner is looking for when they ask who is buying on credit. `COALESCE` takes the debtor's name
 * and keeps an explicitly typed name for the counter case, and the tenant equality sits in the
 * `ON` clause so the join can only ever ADD a name: a sale is never dropped because the debtor
 * row is missing, soft-deleted or belongs to another business.
 */
function resumenVentas(db, negocioId, desde, hasta) {
  const ventas = db
    .prepare(
      `SELECT v.id, v.folio, v.fecha, v.metodo_pago, v.estado,
              v.subtotal_centavos, v.iva_centavos, v.descuento_centavos, v.total_centavos,
              v.cliente_nombre, v.cliente_documento, v.observaciones, v.monto_recibido_centavos,
              v.monto_cambio_centavos, v.deudor_id, v.caja_id, v.user_id, v.created_at,
              u.nombre AS usuario_nombre, u.email AS usuario_email,
              COALESCE(NULLIF(v.cliente_nombre, ''), d.nombre) AS cliente_nombre_resuelto
         FROM ventas v
         JOIN users u ON u.id = v.user_id
         LEFT JOIN clientes_deudores d ON d.id = v.deudor_id AND d.negocio_id = v.negocio_id
        WHERE v.negocio_id = ? AND v.estado = 'completada' AND v.deleted_at IS NULL
          AND v.fecha >= ? AND v.fecha < ?
        ORDER BY v.fecha DESC, v.id DESC`
    )
    .all(negocioId, desde, hasta)

  if (ventas.length === 0) {
    return { ventas, subtotalCentavos: 0, totalCentavos: 0, costoCentavos: 0, unidadesMilli: 0 }
  }

  const ids = ventas.map((v) => v.id)
  const marcas = ids.map(() => '?').join(', ')
  // NO `negocio_id` filter here, because `ventas_detalles` HAS NO TENANT COLUMN. The line belongs
  // to a sale, and the sale's tenant is the line's tenant; the ids above are already restricted
  // to this business, so the `IN` list IS the scoping. Writing `d.negocio_id = ?` — which reads
  // like every other query in this file and is the obvious thing to type — is `no such column` on
  // this schema, and it took the whole sales report down with it. `tests/db/ventas.spec.js` says
  // the same thing in a helper comment; this is the second place that had to learn it.
  const lineas = db
    .prepare(
      `SELECT d.venta_id, d.cantidad_milli, d.subtotal_centavos, d.descuento_centavos,
              d.precio_unitario_centavos, d.costo_unitario_centavos, d.nombre_producto, d.producto_id
         FROM ventas_detalles d
        WHERE d.venta_id IN (${marcas})`
    )
    .all(...ids)

  const porVenta = new Map()
  for (const l of lineas) {
    const lista = porVenta.get(l.venta_id)
    if (lista) lista.push(l)
    else porVenta.set(l.venta_id, [l])
  }

  let subtotalCentavos = 0
  let totalCentavos = 0
  let costoCentavos = 0
  let unidadesMilli = 0

  for (const v of ventas) {
    subtotalCentavos += v.subtotal_centavos
    totalCentavos += v.total_centavos
    for (const l of porVenta.get(v.id) ?? []) {
      unidadesMilli += l.cantidad_milli
      costoCentavos += lineTotalCentavos(l.costo_unitario_centavos, l.cantidad_milli, {
        label: `costo ${l.nombre_producto ?? 'libre'}`
      })
    }
  }

  return {
    ventas,
    porVenta,
    subtotalCentavos: assertCents(subtotalCentavos, 'subtotal de ventas'),
    totalCentavos: assertCents(totalCentavos, 'total de ventas'),
    costoCentavos: assertCents(costoCentavos, 'costo de mercadería'),
    unidadesMilli: entero(unidadesMilli, 'unidades vendidas')
  }
}

/**
 * One window's numbers, for the two reports that compare it against the previous one.
 *
 * Written ONCE on purpose. The web has this block copied into `reporteGerencial` and again into
 * `reporteAnalisisNegocio`, and the two copies had already drifted: gerencial takes its margin
 * over `ventasTotales` (IVA included) while analisis takes it over `subtotalVentas` (IVA
 * extracted), so the same shop on the same day is shown two different margins depending on the
 * tab. One function, one base: the margin here is over the line subtotals, net of tax, which is
 * the figure a product-level margin can also be measured against.
 */
function resumenPeriodo(db, negocioId, desde, hasta) {
  const v = resumenVentas(db, negocioId, desde, hasta)
  const cantidadVentas = v.ventas.length

  const compras = db
    .prepare(
      `SELECT COALESCE(SUM(total_centavos), 0) AS total, COUNT(*) AS n
         FROM compras
        WHERE negocio_id = ? AND estado = 'completada' AND deleted_at IS NULL
          AND fecha >= ? AND fecha < ?`
    )
    .get(negocioId, desde, hasta)

  // Operating expenses: an outflow from the drawer that the owner entered. See the header table.
  const gastos = db
    .prepare(
      `SELECT COALESCE(SUM(monto_centavos), 0) AS total, COUNT(*) AS n
         FROM movimientos_caja
        WHERE negocio_id = ? AND tipo = 'egreso' AND origen = ${ORIGEN.MANUAL}
          AND created_at >= ? AND created_at < ?`
    )
    .get(negocioId, desde, hasta)

  const cobros = db
    .prepare(
      `SELECT COALESCE(SUM(monto_centavos), 0) AS total, COUNT(*) AS n
         FROM pagos_deuda
        WHERE negocio_id = ? AND fecha >= ? AND fecha < ?`
    )
    .get(negocioId, desde, hasta)

  const gananciaBrutaCentavos = assertCents(v.subtotalCentavos - v.costoCentavos, 'ganancia bruta')

  return {
    fechaInicio: null, // filled in by the caller, which knows the calendar days
    fechaFin: null,
    cantidadVentas: entero(cantidadVentas, 'cantidad de ventas'),
    totalVentasCentavos: v.totalCentavos,
    subtotalVentasCentavos: v.subtotalCentavos,
    ticketPromedioCentavos: promedioCentavos(v.totalCentavos, cantidadVentas, 'ticket promedio'),
    costoMercaderiaCentavos: v.costoCentavos,
    unidadesVendidasMilli: v.unidadesMilli,
    gananciaBrutaCentavos,
    margenBrutoPct: margenPct(v.subtotalCentavos, v.costoCentavos),
    gastosOperativosCentavos: centavos(gastos.total, 'gastos operativos'),
    cantidadGastos: entero(gastos.n, 'cantidad de gastos'),
    gananciaNetaCentavos: assertCents(gananciaBrutaCentavos - gastos.total, 'ganancia neta'),
    margenNetoPct: margenPct(v.subtotalCentavos, v.costoCentavos + gastos.total),
    totalComprasCentavos: centavos(compras.total, 'total de compras'),
    cantidadCompras: entero(compras.n, 'cantidad de compras'),
    totalCobradoDeudoresCentavos: centavos(cobros.total, 'cobrado de deudores'),
    cantidadCobros: entero(cobros.n, 'cantidad de cobros')
  }
}

/** `resumenPeriodo` for the requested window AND the window before it, with the days attached. */
function resumenComparativo(db, negocioId, periodo) {
  const { fechaInicio, fechaFin, offsetMin } = periodo
  const anterior = periodoAnterior(fechaInicio, fechaFin)
  const rangoAnterior = rangoPeriodo(anterior.fechaInicio, anterior.fechaFin, offsetMin)

  const actual = resumenPeriodo(db, negocioId, periodo.desde, periodo.hasta)
  actual.fechaInicio = fechaInicio
  actual.fechaFin = fechaFin

  const previo = resumenPeriodo(db, negocioId, rangoAnterior.desde, rangoAnterior.hasta)
  previo.fechaInicio = anterior.fechaInicio
  previo.fechaFin = anterior.fechaFin

  return { actual, anterior: previo, periodoAnterior: anterior }
}

// =============================================================================
// 1. reportes.sales
// =============================================================================

/**
 * The sales book for the window: every completed sale, newest first, with its lines.
 *
 * `resumen` is the count, the money in, and the average ticket. The average is integer centavos
 * rounded half away from zero, so a $10,00 ticket and a $10,01 ticket do not average to $10,005.
 */
export function reporteVentas(ctx, payload, { hoyLocal, offsetMin }) {
  const periodo = resolverPeriodo(payload, { hoyLocal, offsetMin })
  const { ventas, subtotalCentavos, totalCentavos, costoCentavos, unidadesMilli, porVenta } =
    resumenVentas(ctx.db, ctx.negocioId, periodo.desde, periodo.hasta)

  return {
    periodo: { fechaInicio: periodo.fechaInicio, fechaFin: periodo.fechaFin },
    resumen: {
      cantidadVentas: ventas.length,
      totalIngresosCentavos: totalCentavos,
      subtotalCentavos,
      costoMercaderiaCentavos: costoCentavos,
      unidadesVendidasMilli: unidadesMilli,
      gananciaBrutaCentavos: assertCents(subtotalCentavos - costoCentavos, 'ganancia bruta'),
      promedioVentaCentavos: promedioCentavos(totalCentavos, ventas.length, 'promedio de venta')
    },
    detalle: ventas.map((v) => ({
      id: v.id,
      folio: v.folio,
      fecha: v.fecha,
      metodoPago: v.metodo_pago,
      estado: v.estado,
      totalCentavos: v.total_centavos,
      subtotalCentavos: v.subtotal_centavos,
      ivaCentavos: v.iva_centavos,
      descuentoCentavos: v.descuento_centavos,
      clienteNombre: v.cliente_nombre_resuelto,
      clienteDocumento: v.cliente_documento,
      observaciones: v.observaciones,
      montoRecibidoCentavos: v.monto_recibido_centavos,
      montoCambioCentavos: v.monto_cambio_centavos,
      deudorId: v.deudor_id,
      cajaId: v.caja_id,
      usuarioNombre: v.usuario_nombre,
      usuarioEmail: v.usuario_email,
      createdAt: v.created_at,
      detalles: (porVenta.get(v.id) ?? []).map((l) => ({
        productoId: l.producto_id,
        nombreProducto: l.nombre_producto,
        cantidadMilli: entero(l.cantidad_milli, 'cantidad'),
        precioUnitarioCentavos: l.precio_unitario_centavos,
        costoUnitarioCentavos: l.costo_unitario_centavos,
        descuentoCentavos: l.descuento_centavos,
        subtotalCentavos: l.subtotal_centavos
      }))
    }))
  }
}

// =============================================================================
// 2. reportes.topProducts
// =============================================================================

/**
 * The products that moved most, by units, with their money.
 *
 * GROUPED BY `COALESCE(producto_id, nombre_producto)`, which is the web's rule and the right one:
 * a free-text line sold at the till has no `producto_id`, and grouping on the id alone would put
 * every such line in one row with a `NULL` name and a total nobody can explain. Each free line
 * keeps its own name.
 *
 * `cantidadMilli` is thousandths of the product's own unit and comes back with the unit, because
 * the renderer needs `unidad` to print `1 500 g` instead of the 1500 that is actually stored. The
 * web cannot do this: its `cantidad` column is an INTEGER and a half-kilo line is stored as one
 * unit.
 */
export function reporteProductosMasVendidos(ctx, payload, { hoyLocal, offsetMin }) {
  const periodo = resolverPeriodo(payload, { hoyLocal, offsetMin })
  const limit = entero(payload?.limit ?? 10, 'limit')
  if (limit < 1 || limit > 5000) {
    throw new IpcError('REPORTE_LIMIT_INVALIDO', 400, `limit debe estar entre 1 y 5000: ${limit}`)
  }

  const filas = ctx.db
    .prepare(
      `SELECT COALESCE(d.producto_id, d.nombre_producto) AS grupo,
              d.producto_id,
              p.nombre AS producto_nombre,
              p.unidad_medida,
              COALESCE(p.es_pesable, 0) AS es_pesable,
              SUM(d.cantidad_milli) AS total_vendido_milli,
              SUM(d.subtotal_centavos) AS total_ingresos_centavos
         FROM ventas_detalles d
         JOIN ventas v ON v.id = d.venta_id
         LEFT JOIN productos p ON p.id = d.producto_id AND p.negocio_id = v.negocio_id
         WHERE v.negocio_id = ? AND v.estado = 'completada' AND v.deleted_at IS NULL
           AND v.fecha >= ? AND v.fecha < ?
         GROUP BY grupo
         ORDER BY total_vendido_milli DESC, total_ingresos_centavos DESC, grupo
         LIMIT ?`
    )
    .all(ctx.negocioId, periodo.desde, periodo.hasta, limit)

  return {
    periodo: { fechaInicio: periodo.fechaInicio, fechaFin: periodo.fechaFin },
    resumen: {
      cantidadProductos: filas.length,
      totalIngresosCentavos: assertCents(
        filas.reduce((s, f) => s + f.total_ingresos_centavos, 0),
        'ingresos de productos'
      )
    },
    detalle: filas.map((f) => ({
      productoId: f.producto_id,
      nombre: f.producto_id === null ? (f.grupo ?? 'Venta libre') : (f.producto_nombre ?? 'Producto'),
      esVentaLibre: f.producto_id === null,
      unidadMedida: f.unidad_medida ?? 'unidad',
      esPesable: f.es_pesable === 1,
      cantidadVendidaMilli: entero(f.total_vendido_milli, 'cantidad vendida'),
      totalIngresosCentavos: assertCents(f.total_ingresos_centavos, 'ingresos del producto')
    }))
  }
}

// =============================================================================
// 3. reportes.cash
// =============================================================================

/**
 * The till: its movements, its totals, and the two numbers that have to agree.
 *
 * THIS REPORT EXISTS TO BE CHECKED AGAINST SOMETHING. `saldoCentavos` is what the drawer's own
 * movement rows say, and `cuentaCajaCentavos` is the balance of account `1.1.01 Caja` in the
 * ledger. They are two independent records of the same physical pile of cash, and the desktop
 * writes both in the same transaction as the sale, so they must be equal. `coincide` is that
 * claim, made visible — a report that simply printed one of them could not tell anybody whether
 * they had drifted apart.
 *
 * The comparison is against `saldoGeneral`, not against a single till: `1.1.01` is the account of
 * ALL the cash the shop holds, so a business with a closed till from yesterday and an open one
 * today must compare the ledger against both. `saldoGeneral()` is that figure, and it is built
 * from the tills' own totals rather than from a second query of the movements, so the two sides of
 * the comparison really are two different routes to the same number.
 *
 * `cajaId` is optional. Absent, the report covers the open till, and if no till is open it
 * reports the whole business's cash and says so in `alcance`, rather than returning the movements
 * of a till that was never opened.
 */
export function reporteCaja(ctx, payload) {
  const db = ctx.db
  const pedido = payload?.cajaId

  let caja = null
  let alcance = 'negocio'
  if (pedido !== null && pedido !== undefined) {
    caja = db
      .prepare('SELECT * FROM cajas WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL')
      .get(entero(pedido, 'cajaId'), ctx.negocioId)
    if (!caja) {
      throw new IpcError('CAJA_NO_ENCONTRADA', 404, `No existe la caja ${pedido} en este negocio.`)
    }
    alcance = 'caja'
  } else {
    caja = cajaActiva(db, ctx.negocioId)
    if (caja) alcance = 'caja_abierta'
  }

  const filas = caja
    ? db
        .prepare(
          `SELECT m.id, m.tipo, m.concepto, m.monto_centavos, m.saldo_anterior_centavos,
                  m.saldo_nuevo_centavos, m.origen, m.referencia, m.caja_id, m.venta_id,
                  m.created_at, u.nombre AS usuario_nombre
             FROM movimientos_caja m
             JOIN users u ON u.id = m.user_id
            WHERE m.negocio_id = ? AND m.caja_id = ?
            ORDER BY m.created_at ASC, m.id ASC`
        )
        .all(ctx.negocioId, caja.id)
    : []

  const totalIngresosCentavos = assertCents(
    filas.filter((m) => m.tipo === 'ingreso').reduce((s, m) => s + m.monto_centavos, 0),
    'ingresos de caja'
  )
  const totalEgresosCentavos = assertCents(
    filas.filter((m) => m.tipo === 'egreso').reduce((s, m) => s + m.monto_centavos, 0),
    'egresos de caja'
  )

  const general = saldoGeneral(db, ctx.negocioId)
  const cuentaCaja = db
    .prepare(
      `SELECT c.id, c.codigo,
              COALESCE(SUM(d.debe_centavos), 0) AS debe,
              COALESCE(SUM(d.haber_centavos), 0) AS haber
         FROM cuentas_contables c
         LEFT JOIN detalles_asientos d
           ON d.cuenta_contable_id = c.id AND d.negocio_id = c.negocio_id
        WHERE c.negocio_id = ? AND c.codigo = ?
        GROUP BY c.id`
    )
    .get(ctx.negocioId, CUENTA.CAJA)

  // The account is an `activo`, so the sign is debe - haber. Read through the shared rule rather
  // than inlined, so the drawer and the ledger cannot disagree about what a positive means.
  const cuentaCajaCentavos = cuentaCaja
    ? saldoDeTipo(cuentaCaja.tipo ?? 'activo', cuentaCaja.debe, cuentaCaja.haber)
    : 0
  const saldoDelNegocio = general.saldoGeneral

  return {
    alcance,
    caja: caja
      ? {
          id: caja.id,
          estado: caja.estado,
          fechaApertura: caja.fecha_apertura,
          fechaCierre: caja.fecha_cierre,
          saldoInicialCentavos: caja.saldo_inicial_centavos,
          saldoFinalCentavos: caja.saldo_final_centavos,
          saldoActualCentavos: saldoCaja(caja)
        }
      : null,
    resumen: {
      totalIngresosCentavos,
      totalEgresosCentavos,
      saldoFinalCentavos: assertCents(totalIngresosCentavos - totalEgresosCentavos, 'saldo final'),
      cantidadMovimientos: filas.length,
      saldoCajaCentavos: caja ? saldoCaja(caja) : 0,
      saldoNegocioCentavos: saldoDelNegocio,
      cuentaCajaCodigo: cuentaCaja ? cuentaCaja.codigo : null,
      cuentaCajaCentavos,
      // The claim, stated as a value. `true` means the drawer and the ledger agree to the centavo.
      coincide: saldoDelNegocio === cuentaCajaCentavos
    },
    movimientos: filas.map((m) => ({
      id: m.id,
      tipo: m.tipo,
      concepto: m.concepto,
      montoCentavos: m.monto_centavos,
      saldoAnteriorCentavos: m.saldo_anterior_centavos,
      saldoNuevoCentavos: m.saldo_nuevo_centavos,
      origen: m.origen,
      referencia: m.referencia,
      ventaId: m.venta_id,
      fecha: m.created_at,
      usuarioNombre: m.usuario_nombre
    }))
  }
}

// =============================================================================
// 4. reportes.incomeStatement
// =============================================================================

/**
 * The statement of results, read OUT OF THE LEDGER and grouped by account type.
 *
 * THIS IS THE ONE REPORT THAT TAKES ITS NUMBERS FROM `detalles_asientos` RATHER THAN FROM
 * `ventas` AND `compras`, and it is the report the whole accounting half of this app exists for.
 * The web builds its "estado de resultados" by adding up sale totals and subtracting purchase
 * totals, which is a cash-basis guess dressed as a statement, and it counts a cash purchase twice
 * — once as a purchase and again as a till outflow (`reporte.controller.js:258-304`). This one
 * asks the double-entry record instead:
 *
 *     ingresos   = SUM(haber) over accounts of type `ingreso`
 *     gastos     = SUM(debe)  over accounts of type `gasto`
 *     resultado  = ingresos - gastos
 *
 * and the sign for every account comes from `saldoDeTipo`, which is the per-type table from
 * `contabilidad.controller.js:480-484`. That matters here in a way it does not in a sales report:
 * a liability account in the same result would read `-$80,00` for money the shop owes, and the
 * statement is the page an owner shows a bank.
 *
 * The `cuentas` array is there so the per-type reading is inspectable rather than implied, and
 * `diario` is the same statement day by day, grouped on the LOCAL day of the entry.
 *
 * ONE THING THE LEDGER SAYS THAT THE WEB'S DID NOT: revenue is credited with the full ticket
 * (`4.1.01` is debited/credited with `total_centavos`, IVA included), so `ingresosCentavos` here is
 * gross of tax while the margin in `reportes.managerial` is measured on line subtotals net of it.
 * The two are different numbers about different things and are named for it. See `DIVERGENCES.md`.
 */
export function reporteEstadoResultados(ctx, payload, { hoyLocal, offsetMin }) {
  const periodo = resolverPeriodo(payload, { hoyLocal, offsetMin })
  const db = ctx.db

  const porTipo = db
    .prepare(
      `SELECT c.tipo,
              COALESCE(SUM(d.debe_centavos), 0) AS debe,
              COALESCE(SUM(d.haber_centavos), 0) AS haber
       ${FROM_LEDGER}
        WHERE a.negocio_id = ? AND a.fecha >= ? AND a.fecha < ?
        GROUP BY c.tipo`
    )
    .all(ctx.negocioId, periodo.desde, periodo.hasta)

  let ingresosCentavos = 0
  let gastosCentavos = 0
  const cuentas = []
  for (const fila of porTipo) {
    if (fila.tipo === 'ingreso') ingresosCentavos += saldoDeTipo(fila.tipo, fila.debe, fila.haber)
    if (fila.tipo === 'gasto') gastosCentavos += saldoDeTipo(fila.tipo, fila.debe, fila.haber)
  }
  ingresosCentavos = assertCents(ingresosCentavos, 'ingresos')
  gastosCentavos = assertCents(gastosCentavos, 'gastos')
  const resultadoCentavos = assertCents(ingresosCentavos - gastosCentavos, 'resultado')

  const porCuenta = db
    .prepare(
      `SELECT c.codigo, c.nombre, c.tipo,
              COALESCE(SUM(d.debe_centavos), 0) AS debe,
              COALESCE(SUM(d.haber_centavos), 0) AS haber
       ${FROM_LEDGER}
        WHERE a.negocio_id = ? AND a.fecha >= ? AND a.fecha < ?
          AND c.tipo IN ('ingreso', 'gasto', 'pasivo', 'capital', 'activo')
        GROUP BY c.id
        ORDER BY c.codigo`
    )
    .all(ctx.negocioId, periodo.desde, periodo.hasta)

  const diarioSql = db
    .prepare(
      `SELECT date(a.fecha, ?) AS dia,
              COALESCE(SUM(CASE WHEN c.tipo = 'ingreso' THEN d.haber_centavos ELSE 0 END), 0) AS ingresos,
              COALESCE(SUM(CASE WHEN c.tipo = 'gasto' THEN d.debe_centavos ELSE 0 END), 0) AS egresos
       ${FROM_LEDGER}
        WHERE a.negocio_id = ? AND a.fecha >= ? AND a.fecha < ?
        GROUP BY dia
        ORDER BY dia`
    )
    .all(periodo.modificador, ctx.negocioId, periodo.desde, periodo.hasta)

  const porDia = new Map(diarioSql.map((d) => [d.dia, d]))
  const diario = enumerarDias(periodo.fechaInicio, periodo.fechaFin).map((dia) => {
    const fila = porDia.get(dia)
    const ingresos = centavos(fila?.ingresos, `ingresos del ${dia}`)
    const egresos = centavos(fila?.egresos, `egresos del ${dia}`)
    return { fecha: dia, ingresosCentavos: ingresos, egresosCentavos: egresos, resultadoCentavos: assertCents(ingresos - egresos, `resultado del ${dia}`) }
  })

  return {
    periodo: { fechaInicio: periodo.fechaInicio, fechaFin: periodo.fechaFin },
    resumen: {
      ingresosCentavos,
      gastosCentavos,
      resultadoCentavos,
      margenPct: tasa(ingresosCentavos === 0 ? null : (resultadoCentavos / ingresosCentavos) * 100)
    },
    diario,
    cuentas: porCuenta.map((c) => ({
      codigo: c.codigo,
      nombre: c.nombre,
      tipo: c.tipo,
      debeCentavos: c.debe,
      haberCentavos: c.haber,
      // Signed the way THIS account's type is read. A `pasivo` with 8000 in the credit column
      // comes back +8000, and that is the whole point of routing it through `saldoDeTipo`.
      saldoCentavos: saldoDeTipo(c.tipo, c.debe, c.haber)
    }))
  }
}

// =============================================================================
// 5. reportes.managerial
// =============================================================================

/**
 * The window against the window before it, with a traffic light.
 *
 * `comparativo` is a flat array of `{ indicador, actual, anterior, variacion, tipo, formato }` and
 * is built ONCE from a table of the metrics, because the web hand-wrote thirteen nearly identical
 * object literals and then referred to `c.cantidadVentas` in one of them and `a.cantidadVentas` in
 * another — the same field, one of which does not exist on the previous period's summary. A table
 * cannot have that bug: a missing key is a missing row, and a missing row is visible.
 *
 * `totalRetiradoCentavos` is 0 and `retiroDefinido` is false, as in the web: nothing in this
 * codebase removes money from the till for the owner's own use, so there is no `retiro-%`
 * convention to count and pretending otherwise would invent a category. The flag is there so the
 * UI can say so instead of printing a confident $0,00.
 */
export function reporteGerencial(ctx, payload, { hoyLocal, offsetMin }) {
  const periodo = resolverPeriodo(payload, { hoyLocal, offsetMin })
  const db = ctx.db
  const { actual, anterior, periodoAnterior: previo } = resumenComparativo(db, ctx.negocioId, periodo)

  const porDia = db
    .prepare(
      `SELECT date(v.fecha, ?) AS dia, SUM(v.total_centavos) AS total, COUNT(*) AS n
         FROM ventas v
        WHERE v.negocio_id = ? AND v.estado = 'completada' AND v.deleted_at IS NULL
          AND v.fecha >= ? AND v.fecha < ?
        GROUP BY dia
        ORDER BY dia`
    )
    .all(periodo.modificador, ctx.negocioId, periodo.desde, periodo.hasta)

  const dias = porDia
    .map((d) => ({ fecha: d.dia, totalCentavos: centavos(d.total, 'total del día') }))
    .sort((a, b) => b.totalCentavos - a.totalCentavos)

  const top = db
    .prepare(
      `SELECT COALESCE(d.producto_id, d.nombre_producto) AS grupo, d.producto_id,
              p.nombre AS producto_nombre,
              SUM(d.cantidad_milli) AS cantidad_milli,
              SUM(d.subtotal_centavos) AS ingresos_centavos
         FROM ventas_detalles d
         JOIN ventas v ON v.id = d.venta_id
         LEFT JOIN productos p ON p.id = d.producto_id AND p.negocio_id = v.negocio_id
        WHERE v.negocio_id = ? AND v.estado = 'completada' AND v.deleted_at IS NULL
          AND v.fecha >= ? AND v.fecha < ?
        GROUP BY grupo`
    )
    .all(ctx.negocioId, periodo.desde, periodo.hasta)

  const nombre = (f) => (f.producto_id === null ? (f.grupo ?? 'Venta libre') : (f.producto_nombre ?? 'Producto'))
  const porCantidad = [...top].sort((a, b) => b.cantidad_milli - a.cantidad_milli)
  const porIngresos = [...top].sort((a, b) => b.ingresos_centavos - a.ingresos_centavos)

  const COMPARATIVO = [
    { indicador: 'Ventas', campo: 'totalVentasCentavos', formato: 'moneda' },
    { indicador: 'Cantidad de ventas', campo: 'cantidadVentas', formato: 'numero' },
    { indicador: 'Ticket promedio', campo: 'ticketPromedioCentavos', formato: 'moneda' },
    { indicador: 'Costo de mercadería', campo: 'costoMercaderiaCentavos', formato: 'moneda' },
    { indicador: 'Ganancia bruta', campo: 'gananciaBrutaCentavos', formato: 'moneda' },
    { indicador: 'Margen bruto', campo: 'margenBrutoPct', formato: 'porcentaje', tipo: 'pp' },
    { indicador: 'Gastos operativos', campo: 'gastosOperativosCentavos', formato: 'moneda' },
    { indicador: 'Ganancia neta', campo: 'gananciaNetaCentavos', formato: 'moneda' },
    { indicador: 'Margen neto', campo: 'margenNetoPct', formato: 'porcentaje', tipo: 'pp' },
    { indicador: 'Unidades vendidas', campo: 'unidadesVendidasMilli', formato: 'cantidad' },
    { indicador: 'Total comprado', campo: 'totalComprasCentavos', formato: 'moneda' },
    { indicador: 'Total cobrado deudores', campo: 'totalCobradoDeudoresCentavos', formato: 'moneda' }
  ]

  const comparativo = COMPARATIVO.map(({ indicador, campo, formato, tipo = 'pct' }) => {
    const a = actual[campo]
    const b = anterior[campo]
    return {
      indicador,
      formato,
      tipo,
      actual: a,
      anterior: b,
      // Percentage POINTS for a margin, percent for everything else: a margin that went from 20%
      // to 25% rose 5 points and 25%, and printing "25%" for a change of 5 is a different claim.
      variacion: tipo === 'pp' ? diferenciaPuntos(a, b) : variacionPct(a, b)
    }
  })

  return {
    periodoActual: { fechaInicio: periodo.fechaInicio, fechaFin: periodo.fechaFin },
    periodoAnterior: previo,
    cantidadDias: cantidadDias(periodo.fechaInicio, periodo.fechaFin),
    resumen: { ...actual, totalRetiradoCentavos: 0 },
    anterior: { ...anterior, totalRetiradoCentavos: 0 },
    comparativo,
    indicadores: {
      diaMayorVenta: dias[0] ?? null,
      diaMenorVenta: dias.length > 0 ? dias[dias.length - 1] : null,
      topProductoCantidad: porCantidad[0]
        ? {
            producto: nombre(porCantidad[0]),
            productoId: porCantidad[0].producto_id,
            cantidadMilli: entero(porCantidad[0].cantidad_milli, 'cantidad')
          }
        : null,
      topProductoIngresos: porIngresos[0]
        ? {
            producto: nombre(porIngresos[0]),
            productoId: porIngresos[0].producto_id,
            ingresosCentavos: assertCents(porIngresos[0].ingresos_centavos, 'ingresos del producto')
          }
        : null
    },
    retiroDefinido: false
  }
}

// =============================================================================
// 6. reportes.businessAnalysis
// =============================================================================

/**
 * The diagnosis, not the numbers: which products earn too little, which do not move, who owes.
 *
 * The margins are per PRODUCT and measured on the recorded line cost
 * (`ventas_detalles.costo_unitario_centavos`), which the desktop writes at the moment of the sale
 * and the web cannot — it falls back to the product's CURRENT purchase price, so a restock
 * rewrites the margin of every sale that came before it. Using the recorded cost is what makes
 * this report a statement about the past rather than a guess about the present.
 *
 * A product with NO recorded cost cannot have a margin, and it is counted in
 * `productosMargenNoPositivo` with `margenPct: null` rather than with a 0%. A margin of zero is a
 * real finding — the shop sold the item at cost — while "there is no cost" is a gap in the data,
 * and the two must not wear the same number.
 *
 * THE TRAFFIC LIGHTS. `variacionVentas` and `variacionTicket` are green at zero or above and red
 * below; `variacionGastos` is the reverse, and it is red when the previous window had no expenses
 * and this one does, because a `null` variation there means "no base to divide by" and reading it
 * as neutral would call an increase neutral. `margenBruto` uses the web's thresholds, 25% green /
 * 15% amber, exposed in `umbrales` so the UI can say "according to the configured thresholds"
 * instead of implying they are the law.
 */
export function reporteAnalisisNegocio(ctx, payload, { hoyLocal, offsetMin }) {
  const periodo = resolverPeriodo(payload, { hoyLocal, offsetMin })
  const db = ctx.db
  const { actual, anterior, periodoAnterior: previo } = resumenComparativo(db, ctx.negocioId, periodo)
  const umbrales = { margenVerdePct: 25, margenAmarilloPct: 15 }

  const lineas = db
    .prepare(
      `SELECT d.producto_id, d.nombre_producto, d.cantidad_milli, d.subtotal_centavos,
              d.costo_unitario_centavos, p.nombre AS producto_nombre, p.unidad_medida
         FROM ventas_detalles d
         JOIN ventas v ON v.id = d.venta_id
         LEFT JOIN productos p ON p.id = d.producto_id AND p.negocio_id = v.negocio_id
        WHERE v.negocio_id = ? AND v.estado = 'completada' AND v.deleted_at IS NULL
          AND v.fecha >= ? AND v.fecha < ? AND d.producto_id IS NOT NULL`
    )
    .all(ctx.negocioId, periodo.desde, periodo.hasta)

  const porProducto = new Map()
  for (const l of lineas) {
    const clave = l.producto_id
    let p = porProducto.get(clave)
    if (!p) {
      p = {
        productoId: clave,
        nombre: l.producto_nombre ?? l.nombre_producto ?? 'Producto',
        // WITHOUT THIS THE REPORT PRINTS KILOS AS UNITS. `unidadesMilli` is thousandths of the
        // product's OWN unit, so 3500 of a kilo product is three and a half kilos; a renderer that
        // received no unit has nothing but "unidad" to say, and prints `3 500 unidades` about three
        // and a half kilos of cheese. The unit travels with the number, the way it does in
        // `reportes.topProducts`, for the same reason.
        unidadMedida: l.unidad_medida ?? 'unidad',
        unidadesMilli: 0,
        subtotalCentavos: 0,
        costoCentavos: 0,
        costoConocido: true
      }
      porProducto.set(clave, p)
    }
    p.unidadesMilli += l.cantidad_milli
    p.subtotalCentavos += l.subtotal_centavos
    if (l.costo_unitario_centavos > 0) {
      p.costoCentavos += lineTotalCentavos(l.costo_unitario_centavos, l.cantidad_milli, {
        label: `costo ${p.nombre}`
      })
    } else {
      // A line with no cost makes the product's average cost unknowable, and a margin computed
      // against a partial cost would overstate it. The flag is per product and sticky.
      p.costoConocido = false
    }
  }

  const margenBajo = []
  const margenNoPositivo = []
  for (const p of porProducto.values()) {
    if (p.subtotalCentavos === 0) continue
    const gananciaCentavos = assertCents(p.subtotalCentavos - p.costoCentavos, `ganancia de ${p.nombre}`)
    const margen = p.costoConocido ? margenPct(p.subtotalCentavos, p.costoCentavos) : null
    const item = {
      productoId: p.productoId,
      nombre: p.nombre,
      unidadMedida: p.unidadMedida,
      unidadesMilli: p.unidadesMilli,
      subtotalCentavos: p.subtotalCentavos,
      costoCentavos: p.costoCentavos,
      costoConocido: p.costoConocido,
      margenPct: margen,
      gananciaCentavos: p.costoConocido ? gananciaCentavos : null
    }
    if (!p.costoConocido || margen <= 0) margenNoPositivo.push(item)
    else if (margen < umbrales.margenAmarilloPct) margenBajo.push(item)
  }

  // Riskiest first. A `null` margin sorts last rather than first: `null - 5` is -5 in JavaScript,
  // so a plain comparator would rank an unknown cost ABOVE a known 0% and put the entries the
  // owner most needs to look at at the bottom of the list.
  const clave = (m) => (m.margenPct === null ? Number.MAX_SAFE_INTEGER : m.margenPct)
  margenBajo.sort((a, b) => clave(a) - clave(b))
  margenNoPositivo.sort((a, b) => clave(a) - clave(b))

  const activos = db
    .prepare(
      `SELECT id, nombre FROM productos
        WHERE negocio_id = ? AND activo = 1 AND deleted_at IS NULL
        ORDER BY nombre`
    )
    .all(ctx.negocioId)
  const vendidos = new Set(porProducto.keys())
  const sinMovimiento = activos.filter((p) => !vendidos.has(p.id))

  const deudores = db
    .prepare(
      `SELECT nombre, deuda_pendiente_centavos, deuda_total_centavos
         FROM v_clientes_deudores
        WHERE negocio_id = ? AND activo = 1 AND deleted_at IS NULL AND deuda_pendiente_centavos > 0
        ORDER BY deuda_pendiente_centavos DESC`
    )
    .all(ctx.negocioId)

  const colorVariacion = (v) => (v === null ? 'verde' : v >= 0 ? 'verde' : 'rojo')
  const colorConteo = (n, conCasos) => (n > 0 ? conCasos : 'verde')

  const variacionVentas = variacionPct(actual.totalVentasCentavos, anterior.totalVentasCentavos)
  const variacionGastos = variacionPct(
    actual.gastosOperativosCentavos,
    anterior.gastosOperativosCentavos
  )
  const variacionTicket = variacionPct(
    actual.ticketPromedioCentavos,
    anterior.ticketPromedioCentavos
  )
  const colorGastos =
    variacionGastos === null
      ? actual.gastosOperativosCentavos > 0
        ? 'rojo'
        : 'verde'
      : variacionGastos <= 0
        ? 'verde'
        : 'rojo'
  const margenBrutoValor = actual.margenBrutoPct
  const colorMargen =
    margenBrutoValor === null
      ? 'verde'
      : margenBrutoValor >= umbrales.margenVerdePct
        ? 'verde'
        : margenBrutoValor >= umbrales.margenAmarilloPct
          ? 'amarillo'
          : 'rojo'

  return {
    periodo: { fechaInicio: periodo.fechaInicio, fechaFin: periodo.fechaFin },
    periodoAnterior: previo,
    umbrales,
    semaforo: {
      margenBruto: { valorPct: margenBrutoValor, color: colorMargen },
      productosMargenBajo: {
        cantidad: margenBajo.length,
        color: colorConteo(margenBajo.length, 'amarillo')
      },
      productosMargenNoPositivo: {
        cantidad: margenNoPositivo.length,
        color: colorConteo(margenNoPositivo.length, 'rojo')
      },
      // SHORTHAND `{ variacionPct }` HERE WAS A FUNCTION, NOT THE VALUE. It names the imported
      // helper `variacionPct` rather than the local `variacionVentas`, so the object carried a
      // function where a number belongs. Over JSON the function is dropped and the column silently
      // reads "—"; handed across the bridge without a round-trip it survives `== null`, coerces
      // through `Math.abs(fn)` to `NaN`, and prints "−NaN%". The variable is `variacionVentas`.
      variacionVentas: { variacionPct: variacionVentas, color: colorVariacion(variacionVentas) },
      variacionGastos: { variacionPct: variacionGastos, color: colorGastos },
      variacionTicket: { variacionPct: variacionTicket, color: colorVariacion(variacionTicket) },
      productosSinMovimiento: {
        cantidad: sinMovimiento.length,
        color: colorConteo(sinMovimiento.length, 'amarillo')
      },
      deudoresPendientes: {
        cantidad: deudores.length,
        color: colorConteo(deudores.length, 'rojo')
      }
    },
    detalle: {
      productosMargenBajo: margenBajo.slice(0, 10),
      productosNoPositivos: margenNoPositivo.slice(0, 10),
      productosSinMovimiento: sinMovimiento.slice(0, 20).map((p) => ({ id: p.id, nombre: p.nombre })),
      deudoresPendientes: deudores.slice(0, 20).map((d) => ({
        nombre: d.nombre,
        montoPendienteCentavos: assertCents(d.deuda_pendiente_centavos, 'deuda pendiente')
      }))
    }
  }
}

// =============================================================================
// 7. reportes.stock
// =============================================================================

/**
 * The shelf, as it is right now — no dates, because a stock report about a range of days is a
 * different thing and this is not it.
 *
 * `stockBajo` counts an ACTIVE product at or below its minimum, and `sinStock` at or below zero.
 * The comparison is on `stock_milli` against `stock_minimo_milli`, both thousandths, so a kilo
 * product with a 5 kg minimum is 5000 and not 5.
 *
 * `valorInventarioCentavos` is the money on the shelf, at the recorded cost, and the web has no
 * such column to sum because it stores no cost per lot. It is the number an owner actually wants
 * from this screen and the reason to run a stock report at all. Like every product of two
 * thousandths and a money column it is multiplied in JavaScript, for the overflow reason given at
 * `resumenVentas`.
 */
export function reporteStock(ctx) {
  const productos = ctx.db
    .prepare(
      `SELECT p.id, p.nombre, p.codigo, p.precio_centavos, p.precio_compra_centavos,
              p.stock_milli, p.stock_minimo_milli, p.activo, p.unidad_medida, p.es_pesable,
              p.tiene_iva, p.iva_porcentaje
         FROM productos p
        WHERE p.negocio_id = ? AND p.deleted_at IS NULL
        ORDER BY p.nombre`
    )
    .all(ctx.negocioId)

  let valorInventarioCentavos = 0
  const list = productos.map((p) => {
    // `lineTotalCentavos` is the same rounding the sale used, so the value of the stock on hand
    // is exactly the sum of what the units on hand would have cost, to the centavo.
    valorInventarioCentavos += lineTotalCentavos(p.precio_compra_centavos, p.stock_milli, {
      label: `inventario ${p.nombre}`
    })
    return {
      id: p.id,
      nombre: p.nombre,
      codigo: p.codigo,
      precioCentavos: p.precio_centavos,
      precioCompraCentavos: p.precio_compra_centavos,
      stockMilli: p.stock_milli,
      stockMinimoMilli: p.stock_minimo_milli,
      unidadMedida: p.unidad_medida,
      esPesable: p.es_pesable === 1,
      tieneIva: p.tiene_iva === 1,
      ivaPorcentaje: p.iva_porcentaje ?? null,
      activo: p.activo === 1
    }
  })

  const activos = list.filter((p) => p.activo)
  const stockBajo = activos.filter((p) => p.stockMilli <= p.stockMinimoMilli)
  const sinStock = activos.filter((p) => p.stockMilli <= 0)

  return {
    resumen: {
      totalProductos: list.length,
      activos: activos.length,
      inactivos: list.length - activos.length,
      stockBajo: stockBajo.length,
      sinStock: sinStock.length,
      valorInventarioCentavos: assertCents(valorInventarioCentavos, 'valor de inventario')
    },
    stockBajo: stockBajo.map((p) => ({
      id: p.id,
      nombre: p.nombre,
      codigo: p.codigo,
      stockMilli: p.stockMilli,
      stockMinimoMilli: p.stockMinimoMilli,
      unidadMedida: p.unidadMedida
    })),
    list
  }
}

// =============================================================================
// 8. reportes.expenses
// =============================================================================

/**
 * The owner's own outgoings: money that left the drawer and was not a purchase and not a refund.
 *
 * `origen = 'manual' AND tipo = 'egreso'` is the whole definition, and it is deliberately not the
 * web's `referencia NOT LIKE 'compra-%'`. Three reasons, in order of how much damage the wrong one
 * does:
 *
 *   1. The desktop writes `compra:{id}` — a COLON, not a hyphen (`compras.repo.js:316`). The web's
 *      pattern does not match it, so every cash purchase would also be listed here as an expense
 *      and the owner would see the same outflow twice, under two names.
 *   2. A cancelled sale writes an egreso with `origen = 'venta'`
 *      (`ventas.repo.js:697-704`). Under a prefix rule it is an expense; under `origen` it is what
 *      it is, the reversal of a sale, and it belongs with the sales figures.
 *   3. A debtor's payment is an `ingreso` (`deudores.repo.js:486`), so money the shop COLLECTED
 *      cannot be mistaken for money it spent. With a prefix rule over `referencia` it could,
 *      because the two share the word `pago`.
 */
export function reporteGastos(ctx, payload, { hoyLocal, offsetMin }) {
  const periodo = resolverPeriodo(payload, { hoyLocal, offsetMin })
  const filas = ctx.db
    .prepare(
      `SELECT m.id, m.concepto, m.monto_centavos, m.referencia, m.origen, m.created_at,
              u.nombre AS usuario_nombre
         FROM movimientos_caja m
         JOIN users u ON u.id = m.user_id
        WHERE m.negocio_id = ? AND m.tipo = 'egreso' AND m.origen = ${ORIGEN.MANUAL}
          AND m.created_at >= ? AND m.created_at < ?
        ORDER BY m.created_at ASC, m.id ASC`
    )
    .all(ctx.negocioId, periodo.desde, periodo.hasta)

  const totalGastosCentavos = assertCents(
    filas.reduce((s, m) => s + m.monto_centavos, 0),
    'total de gastos'
  )

  return {
    periodo: { fechaInicio: periodo.fechaInicio, fechaFin: periodo.fechaFin },
    resumen: {
      totalGastosCentavos,
      cantidadMovimientos: filas.length,
      promedioGastoCentavos: promedioCentavos(totalGastosCentavos, filas.length, 'promedio de gasto')
    },
    detalle: filas.map((m) => ({
      id: m.id,
      concepto: m.concepto,
      montoCentavos: m.monto_centavos,
      referencia: m.referencia,
      origen: m.origen,
      fecha: m.created_at,
      usuarioNombre: m.usuario_nombre
    }))
  }
}

// =============================================================================
// 9. reportes.purchases
// =============================================================================

/**
 * What the shop bought from its suppliers in the window.
 *
 * Read from `compras`, not from the till: a purchase paid by card or on account leaves no
 * movement in the drawer, and a report built from `movimientos_caja` would silently omit it. The
 * two views disagree on purpose and both are true — this is what was bought, `reportes.cash` is
 * what moved in cash.
 */
export function reporteCompras(ctx, payload, { hoyLocal, offsetMin }) {
  const periodo = resolverPeriodo(payload, { hoyLocal, offsetMin })
  const filas = ctx.db
    .prepare(
      `SELECT c.id, c.folio, c.fecha, c.estado, c.subtotal_centavos, c.iva_centavos,
              c.descuento_centavos, c.total_centavos, c.observaciones, c.proveedor_id,
              c.created_at, pr.nombre AS proveedor_nombre
         FROM compras c
         LEFT JOIN proveedores pr ON pr.id = c.proveedor_id AND pr.negocio_id = c.negocio_id
        WHERE c.negocio_id = ? AND c.estado = 'completada' AND c.deleted_at IS NULL
          AND c.fecha >= ? AND c.fecha < ?
        ORDER BY c.fecha DESC, c.id DESC`
    )
    .all(ctx.negocioId, periodo.desde, periodo.hasta)

  const totalComprasCentavos = assertCents(
    filas.reduce((s, c) => s + c.total_centavos, 0),
    'total de compras'
  )

  const porProveedor = new Map()
  for (const c of filas) {
    const clave = c.proveedor_nombre ?? 'Sin proveedor'
    porProveedor.set(clave, (porProveedor.get(clave) ?? 0) + c.total_centavos)
  }

  return {
    periodo: { fechaInicio: periodo.fechaInicio, fechaFin: periodo.fechaFin },
    resumen: {
      totalComprasCentavos,
      cantidadCompras: filas.length,
      promedioCentavos: promedioCentavos(totalComprasCentavos, filas.length, 'promedio de compra')
    },
    porProveedor: [...porProveedor.entries()]
      .map(([proveedor, totalCentavos]) => ({ proveedor, totalCentavos }))
      .sort((a, b) => b.totalCentavos - a.totalCentavos),
    detalle: filas.map((c) => ({
      id: c.id,
      folio: c.folio,
      fecha: c.fecha,
      estado: c.estado,
      subtotalCentavos: c.subtotal_centavos,
      ivaCentavos: c.iva_centavos,
      descuentoCentavos: c.descuento_centavos,
      totalCentavos: c.total_centavos,
      observaciones: c.observaciones,
      proveedorId: c.proveedor_id,
      proveedor: c.proveedor_id === null ? null : (c.proveedor_nombre ?? 'Proveedor'),
      createdAt: c.created_at
    }))
  }
}

// =============================================================================
// 10. reportes.debtors
// =============================================================================

/**
 * Who owes, and what was collected in the window.
 *
 * The balance comes from `v_clientes_deudores`, the view the schema defines for exactly this: a
 * debtor's pending debt is their credit sales minus their payments, clamped at zero. The
 * derivation lives in the view because it has to be the same derivation in the debtor screen, in
 * this report and in the dashboard — three queries that each recompute "who owes what" is three
 * chances to disagree with the till.
 *
 * `cobradoPeriodoCentavos` is a SEPARATE query from the list, and the `limit` on the list must not
 * reach the total. The web got that right with a comment; here the total is its own `SUM` and the
 * list is capped, so a shop with 400 collections in a month still reports the real figure.
 */
export function reporteDeudores(ctx, payload, { hoyLocal, offsetMin }) {
  const periodo = resolverPeriodo(payload, { hoyLocal, offsetMin })
  const db = ctx.db

  // The BALANCE comes from the view, which is the point of the view: one derivation, shared with
  // the debtor screen and the dashboard, so the three cannot drift apart. The `documento` does NOT
  // — the view projects `id, negocio_id, nombre, activo, deleted_at, limite_credito_centavos,
  // deuda_total_centavos, deuda_pendiente_centavos` and no more, so it is joined from the table for
  // a report the owner will read aloud over the phone. Adding it to the view instead would mean a
  // migration to change a schema this phase is not touching, for one display column.
  const deudores = db
    .prepare(
      `SELECT v.id, v.nombre, c.documento, v.limite_credito_centavos,
              v.deuda_total_centavos, v.deuda_pendiente_centavos
         FROM v_clientes_deudores v
         JOIN clientes_deudores c ON c.id = v.id AND c.negocio_id = v.negocio_id
        WHERE v.negocio_id = ? AND v.activo = 1 AND v.deleted_at IS NULL
          AND v.deuda_pendiente_centavos > 0
        ORDER BY v.deuda_pendiente_centavos DESC`
    )
    .all(ctx.negocioId)

  const cobrado = db
    .prepare(
      `SELECT COALESCE(SUM(monto_centavos), 0) AS total, COUNT(*) AS n
         FROM pagos_deuda
        WHERE negocio_id = ? AND fecha >= ? AND fecha < ?`
    )
    .get(ctx.negocioId, periodo.desde, periodo.hasta)

  const cobros = db
    .prepare(
      `SELECT p.id, p.monto_centavos, p.fecha, p.metodo_pago, p.referencia, d.nombre AS deudor
         FROM pagos_deuda p
         JOIN clientes_deudores d ON d.id = p.deudor_id AND d.negocio_id = p.negocio_id
        WHERE p.negocio_id = ? AND p.fecha >= ? AND p.fecha < ?
        ORDER BY p.fecha DESC, p.id DESC
        LIMIT 50`
    )
    .all(ctx.negocioId, periodo.desde, periodo.hasta)

  return {
    periodo: { fechaInicio: periodo.fechaInicio, fechaFin: periodo.fechaFin },
    resumen: {
      cantidadDeudores: deudores.length,
      totalPendienteCentavos: assertCents(
        deudores.reduce((s, d) => s + d.deuda_pendiente_centavos, 0),
        'total pendiente'
      ),
      totalHistoricoCentavos: assertCentosSiFalta(deudores),
      cobradoPeriodoCentavos: centavos(cobrado.total, 'cobrado en el período'),
      cantidadCobros: entero(cobrado.n, 'cantidad de cobros')
    },
    detalle: deudores.map((d) => ({
      id: d.id,
      nombre: d.nombre,
      documento: d.documento,
      limiteCreditoCentavos: d.limite_credito_centavos ?? null,
      deudaTotalCentavos: d.deuda_total_centavos,
      deudaPendienteCentavos: d.deuda_pendiente_centavos
    })),
    cobrosPeriodo: cobros.map((p) => ({
      id: p.id,
      deudor: p.deudor ?? 'Sin deudor',
      montoCentavos: p.monto_centavos,
      fecha: p.fecha,
      metodoPago: p.metodo_pago,
      referencia: p.referencia
    }))
  }
}

function assertCentosSiFalta(filas) {
  return assertCents(
    filas.reduce((s, d) => s + d.deuda_total_centavos, 0),
    'total histórico'
  )
}
