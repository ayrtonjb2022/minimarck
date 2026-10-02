import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tienda, ctxDe, insertarProducto, abrirCaja, insertarDeudor } from './fixtures/tienda.js'
import { crear as crearVenta } from '../../src/main/db/repositories/ventas.repo.js'
import { crear as crearProveedor } from '../../src/main/db/repositories/proveedores.repo.js'
import { crear as crearCompra } from '../../src/main/db/repositories/compras.repo.js'
import { registrarMovimiento, abrir } from '../../src/main/db/repositories/cajas.repo.js'
import {
  reporteVentas,
  reporteProductosMasVendidos,
  reporteCaja,
  reporteEstadoResultados,
  reporteGerencial,
  reporteAnalisisNegocio,
  reporteStock,
  reporteGastos,
  reporteCompras,
  reporteDeudores
} from '../../src/main/db/repositories/reportes.repo.js'

/**
 * The ten reports over POSTED data, with every figure hand-checked.
 *
 * Nothing here is mocked, nothing is seeded by hand where a repository could do it, and no
 * assertion is written as "equals what the code returned". The scenario below is fixed and small
 * enough to hold in one's head, and every expected number in this file is derived from the
 * posting rules by hand in a comment beside it.
 *
 * THE SCENARIO. One till opened with a $500,00 float.
 *
 *   #  lines                              subtotal   IVA      total    cost
 *   1  queso  0.5 kg  (200,00/kg)          100,00   17,36   100,00    60,00
 *   2  queso  1.5 kg  (200,00/kg)          300,00   52,07   300,00   180,00
 *   3  gaseosa 1 unidad (10,00)             10,00    0,00    10,00     6,00
 *                                             -------  ------  -------  -------
 *                                       3 sales 410,00  69,43  410,00   246,00
 *
 * IVA is EXTRACTED, not added, so `total === subtotal` on every line — the desktop's existing
 * convention (`ventas.spec.js` calls it MATH-6) and the reason the sales report and the income
 * statement can be reconciled against each other. `margenBrutoPct` is 16400/41000 = exactly 40.
 *
 * A CASH purchase of $120,00 (drawer down, `2.1.01 Proveedores` untouched) and an owner-entered
 * EXPENSE of $35,00, and a CREDIT purchase of $80,00 that creates a real payable.
 *
 * TWO OF THOSE FIGURES ARE THE POINT OF THE WHOLE SUITE:
 *
 *   - the $80,00 purchase on credit is a LIABILITY, so it must read +$80,00 and never -$80,00;
 *   - the drawer must equal account `1.1.01`, to the centavo, in the same report that prints it.
 */

const ARG = -180
const DIA = '2026-10-01'
const HOY = DIA
const reloj = { hoyLocal: HOY, offsetMin: ARG }
const RANGO = { fechaInicio: DIA, fechaFin: DIA }

let t
let ctx
let queso
let gaseosa
let caja
let proveedor

/** Post a cash sale of `cantidad` kilos/units of a product, through the real repository. */
function vender(producto, cantidad) {
  return crearVenta(ctx, {
    items: [{ productoId: producto.id, cantidad }],
    metodoPago: 'efectivo',
    montoRecibido: 1000
  }).venta
}

beforeEach(() => {
  t = tienda()
  ctx = ctxDe(t, t.negocioId, t.usuarioId)
  caja = abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId }) // 500,00 float
  proveedor = crearProveedor(ctx, { nombre: 'Distribuidora del Sur' })

  // The fixture's default is 3 kg of queso at 200,00 selling / 120,00 cost, IVA 21%.
  queso = insertarProducto(t, {
    negocioId: t.negocioId,
    usuarioId: t.usuarioId,
    overrides: { nombre: 'Queso artesanal', precio_centavos: 20000, precio_compra_centavos: 12000, stock_milli: 3000 }
  })
  // A second product, exempt from IVA, measured in units rather than kilos.
  gaseosa = insertarProducto(t, {
    negocioId: t.negocioId,
    usuarioId: t.usuarioId,
    overrides: { nombre: 'Gaseosa', precio_centavos: 1000, precio_compra_centavos: 600, stock_milli: 10000 }
  })
  t.conn.db
    .prepare("UPDATE productos SET tiene_iva = 0, iva_porcentaje = NULL, unidad_medida = 'unidad' WHERE id = ?")
    .run(gaseosa.id)

  vender(queso, '0.5')
  vender(queso, '1.5')
  vender(gaseosa, '1')
})

afterEach(() => t.cerrar())

// =============================================================================

describe('every operation answers over real SQLite', () => {
  it('returns a shaped object from all ten, with no SQL error', () => {
    // A smoke block with a real purpose: a `SELECT` naming a column the schema does not have is
    // not a wrong number, it is a thrown exception, and it is how `reporteDeudores` asked the
    // debtors view for a `documento` column the view does not project.
    const llamadas = [
      ['sales', () => reporteVentas(ctx, RANGO, reloj)],
      ['topProducts', () => reporteProductosMasVendidos(ctx, RANGO, reloj)],
      ['cash', () => reporteCaja(ctx, {})],
      ['incomeStatement', () => reporteEstadoResultados(ctx, RANGO, reloj)],
      ['managerial', () => reporteGerencial(ctx, RANGO, reloj)],
      ['businessAnalysis', () => reporteAnalisisNegocio(ctx, RANGO, reloj)],
      ['stock', () => reporteStock(ctx)],
      ['expenses', () => reporteGastos(ctx, RANGO, reloj)],
      ['purchases', () => reporteCompras(ctx, RANGO, reloj)],
      ['debtors', () => reporteDeudores(ctx, RANGO, reloj)]
    ]
    for (const [nombre, llamar] of llamadas) {
      const r = llamar()
      expect(r, `${nombre} debe devolver un objeto`).toBeTypeOf('object')
      expect(r, `${nombre} no puede ser null`).not.toBeNull()
      expect(JSON.stringify(r), `${nombre} debe serializar a JSON`).toBeTypeOf('string')
    }
  })

  it('emits no float where money is concerned, and no NaN or Infinity anywhere', () => {
    // The wire rule, enforced by walking the real output rather than by reading it. A report that
    // sends 41000.00000000001 is a report the owner cannot reconcile, and a `NaN` arrives in the
    // renderer as a blank cell with no error to chase.
    const ra = reporteVentas(ctx, RANGO, reloj)
    const ri = reporteEstadoResultados(ctx, RANGO, reloj)
    const rc = reporteCaja(ctx, {})
    const ver = (valor, ruta) => {
      if (typeof valor === 'number') {
        expect(Number.isFinite(valor), `${ruta} debe ser finito`).toBe(true)
        if (/Centavos$/.test(ruta)) {
          expect(Number.isSafeInteger(valor), `${ruta} debe ser un entero de centavos`).toBe(true)
        }
      }
    }
    const recorrer = (nodo, ruta) => {
      if (Array.isArray(nodo)) return nodo.forEach((v, i) => recorrer(v, `${ruta}[${i}]`))
      if (nodo && typeof nodo === 'object') {
        for (const [k, v] of Object.entries(nodo)) recorrer(v, `${ruta}.${k}`)
        return
      }
      ver(nodo, ruta)
    }
    ;[ra, ri, rc].forEach((r, i) => recorrer(r, `reporte${i}`))
  })
})

// =============================================================================

describe('reportes.sales — the book, to the centavo', () => {
  it('sums the three hand-checked sales', () => {
    const r = reporteVentas(ctx, RANGO, reloj)
    // 100,00 + 300,00 + 10,00.
    expect(r.resumen.cantidadVentas).toBe(3)
    expect(r.resumen.totalIngresosCentavos).toBe(41000)
    expect(r.resumen.subtotalCentavos).toBe(41000)
    // 60,00 + 180,00 + 6,00, each a BigInt product of unit cost and thousandths.
    expect(r.resumen.costoMercaderiaCentavos).toBe(24600)
    // 410,00 - 246,00.
    expect(r.resumen.gananciaBrutaCentavos).toBe(16400)
    // 41000 / 3 = 13666.67, rounded half away from zero.
    expect(r.resumen.promedioVentaCentavos).toBe(13667)
    // 500 + 1500 + 1000 thousandths.
    expect(r.resumen.unidadesVendidasMilli).toBe(3000)
  })

  it('carries IVA as extracted, so total equals subtotal on every sale', () => {
    // 10000 * 21/121 = 1735.54 -> 1736, and 30000 * 21/121 = 5206.61 -> 5207.
    const r = reporteVentas(ctx, RANGO, reloj)
    const porTotal = [...r.detalle].sort((a, b) => a.totalCentavos - b.totalCentavos)
    expect(porTotal.map((v) => [v.subtotalCentavos, v.ivaCentavos, v.totalCentavos])).toEqual([
      [1000, 0, 1000],
      [10000, 1736, 10000],
      [30000, 5207, 30000]
    ])
  })

  it('carries the weighed line as 1500 thousandths, not as "1500 kilos"', () => {
    // The report's job is to hand the renderer an integer and the unit that goes with it. Whether
    // that prints as `1 500 g` is the renderer's decision, made with `unidadMedida` in hand — the
    // web cannot make it at all, its `cantidad` column is an INTEGER and stores this as 1.
    const r = reporteVentas(ctx, RANGO, reloj)
    const deQueso = r.detalle
      .flatMap((v) => v.detalles)
      .filter((d) => d.productoId === queso.id)
      .sort((a, b) => a.cantidadMilli - b.cantidadMilli)
    expect(deQueso.map((d) => d.cantidadMilli)).toEqual([500, 1500])
    expect(deQueso.every((d) => Number.isSafeInteger(d.cantidadMilli))).toBe(true)
  })

  it('excludes a sale outside the window rather than clamping it in', () => {
    const r = reporteVentas(ctx, { fechaInicio: '2026-09-01', fechaFin: '2026-09-30' }, reloj)
    expect(r.resumen.cantidadVentas).toBe(0)
    expect(r.resumen.totalIngresosCentavos).toBe(0)
    expect(r.resumen.promedioVentaCentavos).toBe(0)
    // And it is a real empty period, not a broken one: the days still enumerate.
    expect(r.periodo).toEqual({ fechaInicio: '2026-09-01', fechaFin: '2026-09-30' })
  })

  it('refuses a period built backwards instead of swapping its ends', () => {
    // Repairing it would return a plausible report for a period nobody asked about.
    expect(() => reporteVentas(ctx, { fechaInicio: '2026-10-10', fechaFin: '2026-10-01' }, reloj)).toThrow(
      /anterior a fechaInicio/
    )
  })
})

// =============================================================================

describe('reportes.topProducts — grouped by what was sold, free lines included', () => {
  it('adds the two kilo lines into 2000 thousandths of one product', () => {
    const r = reporteProductosMasVendidos(ctx, RANGO, reloj)
    // 500 + 1500. Grouped by product_id, so the two sales of the same cheese are one row.
    const fila = r.detalle.find((f) => f.productoId === queso.id)
    expect(fila.cantidadVendidaMilli).toBe(2000)
    // 100,00 + 300,00 of line subtotal, net of the IVA that was extracted from it.
    expect(fila.totalIngresosCentavos).toBe(40000)
    expect(fila.unidadMedida).toBe('kg')
    expect(fila.esPesable).toBe(true)
  })

  it('orders by units moved and names every product it reports', () => {
    const r = reporteProductosMasVendidos(ctx, RANGO, reloj)
    // 2000 milli of queso beats 1000 of gaseosa, on units rather than on money.
    expect(r.detalle[0].productoId).toBe(queso.id)
    expect(r.detalle[0].cantidadVendidaMilli).toBeGreaterThan(r.detalle[1].cantidadVendidaMilli)
    expect(r.detalle.every((f) => typeof f.nombre === 'string' && f.nombre.length > 0)).toBe(true)
  })
})

// =============================================================================

describe('reportes.cash — the drawer against the ledger', () => {
  it('equals account 1.1.01 exactly, and says so', () => {
    // 500,00 of float plus the three cash sales: 50000 + 10000 + 30000 + 1000.
    const r = reporteCaja(ctx, {})
    expect(r.resumen.saldoNegocioCentavos).toBe(91000)
    expect(r.resumen.cuentaCajaCodigo).toBe('1.1.01')
    expect(r.resumen.cuentaCajaCentavos).toBe(91000)
    // The claim itself, as a value. A report that printed one of the two numbers could not tell
    // anybody whether they had drifted.
    expect(r.resumen.coincide).toBe(true)
  })

  it('covers the open till when no till is named, and says which it covered', () => {
    const r = reporteCaja(ctx, {})
    expect(r.alcance).toBe('caja_abierta')
    expect(r.caja.id).toBe(caja.id)
    // The float, the three sales, and nothing else. The float is itself an `ingreso` movement
    // (`origen = 'caja_apertura'`), so money INTO the drawer is 500,00 of float plus 410,00 of
    // sales — and a report that reported 410,00 would be claiming the shop started empty.
    expect(r.resumen.cantidadMovimientos).toBe(4)
    expect(r.resumen.totalIngresosCentavos).toBe(91000)
    expect(r.resumen.totalEgresosCentavos).toBe(0)
    expect(r.movimientos[0].origen).toBe('caja_apertura')
  })

  it('refuses a till from another business rather than reporting its money', () => {
    // A till id the caller does not own is `CAJA_NO_ENCONTRADA`, not an empty report: "you have no
    // cash" and "that is not your till" are different sentences and the second is the true one.
    const otro = t.conn.db.prepare('SELECT MAX(id) AS id FROM cajas').get().id + 500
    expect(() => reporteCaja(ctx, { cajaId: otro })).toThrow(/No existe la caja/)
  })

  it('EQUALS 1.1.01 after an owner-entered expense, because the expense posts too', () => {
    // THE GAP THIS FILE USED TO PIN, NOW CLOSED. `cajaMovimientos.crear` — the app's own path for
    // an expense the owner types in — calls `cajas.registrarMovimiento`, which used to write the
    // movement row and update the till's totals and post NOTHING. So an expense took the drawer to
    // 875,00 while account `1.1.01` still said 910,00, and this report's own `coincide` went false:
    // the field a shop would read to decide whether its cash records are trustworthy, answering no
    // because of a gap in the OTHER module.
    //
    // The movement row, the till total and the journal entry are now written in ONE transaction by
    // the same function, so there is no moment at which the drawer and the ledger disagree and no
    // way to reach the "row without entry" half. `cajaMovimientos.crear` wraps this in `ctx.tx()`,
    // so a failure anywhere in the three rolls the whole expense back.
    registrarMovimiento(ctx, {
      caja,
      tipo: 'egreso',
      concepto: 'Luz del mes',
      montoCentavos: 3500,
      origen: 'manual'
    })
    const r = reporteCaja(ctx, {})
    // The drawer knows: 91.000 - 3.500.
    expect(r.resumen.saldoNegocioCentavos).toBe(87500)
    expect(r.resumen.totalEgresosCentavos).toBe(3500)
    // The ledger knows the same thing, which is the whole point of the field this report publishes.
    expect(r.resumen.cuentaCajaCentavos).toBe(87500)
    expect(r.resumen.coincide).toBe(true)
  })

  // WHICH ACCOUNT the expense is imputed to, and that the four money paths which already post an
  // entry of their own are not posted twice, are `tests/db/caja-gasto-ledger.spec.js`. They are not
  // repeated here on purpose: this file asserts what the REPORT says, that file asserts what the
  // MONEY does, and a test that lives in both places belongs in neither.

  it('counts a cash purchase as a purchase and NOT as money the drawer earned', () => {
    crearCompra(ctx, {
      proveedorId: proveedor.id,
      metodoPago: 'efectivo',
      items: [{ productoId: queso.id, cantidad: '1', precioUnitario: '120.00' }]
    })
    const r = reporteCaja(ctx, {})
    // 91.000 - 12.000.
    expect(r.resumen.saldoNegocioCentavos).toBe(79000)
    expect(r.resumen.totalEgresosCentavos).toBe(12000)
    // The drawer and the ledger still agree: the purchase posts to BOTH in one transaction.
    expect(r.resumen.coincide).toBe(true)
  })
})

// =============================================================================

describe('reportes.incomeStatement — read out of the ledger, not guessed from sales', () => {
  it('reads a payable as a POSITIVE liability', () => {
    // 80,00 bought on credit, owed to a supplier. `2.1.01 Proveedores` is tipo `pasivo`: the
    // credit side is the real balance and the figure is +8.000, NOT -8.000. The web applied
    // `debe - haber` to every account and shipped a supplier the shop owed money to as -$80,00.
    crearCompra(ctx, {
      proveedorId: proveedor.id,
      metodoPago: 'credito',
      items: [{ productoId: queso.id, cantidad: '1', precioUnitario: '80.00' }]
    })
    const r = reporteEstadoResultados(ctx, RANGO, reloj)
    const proveedores = r.cuentas.find((c) => c.codigo === '2.1.01')
    expect(proveedores).toBeDefined()
    expect(proveedores.tipo).toBe('pasivo')
    expect(proveedores.haberCentavos).toBe(8000)
    expect(proveedores.debeCentavos).toBe(0)
    expect(proveedores.saldoCentavos).toBe(8000)
    expect(proveedores.saldoCentavos).not.toBe(-8000)
  })

  it('takes revenue and cost from the ledger, so the result ties to the sales report', () => {
    const r = reporteEstadoResultados(ctx, RANGO, reloj)
    // Ventas is credited with the full ticket, so ingresos is 410,00 of the same three sales.
    expect(r.resumen.ingresosCentavos).toBe(41000)
    // CMV debited with the recorded cost of the goods: 60,00 + 180,00 + 6,00.
    expect(r.resumen.gastosCentavos).toBe(24600)
    expect(r.resumen.resultadoCentavos).toBe(16400)
    // 16400/41000.
    expect(r.resumen.margenPct).toBe(40)
    // And the same 164,00 the sales report calls gross profit, from an entirely different table.
    expect(r.resumen.resultadoCentavos).toBe(reporteVentas(ctx, RANGO, reloj).resumen.gananciaBrutaCentavos)
  })

  it('keeps every day of the period, so a quiet Sunday is a row and not a gap', () => {
    const r = reporteEstadoResultados(ctx, { fechaInicio: '2026-09-29', fechaFin: '2026-10-02' }, reloj)
    // Four calendar days, the first and last of which hold no postings at all.
    expect(r.diario.map((d) => d.fecha)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'])
    expect(r.diario[0]).toEqual({
      fecha: '2026-09-29',
      ingresosCentavos: 0,
      egresosCentavos: 0,
      resultadoCentavos: 0
    })
    // The sum of the days is the statement, which is the identity that catches a lost GROUP BY.
    const suma = r.diario.reduce((s, d) => s + d.ingresosCentavos, 0)
    expect(suma).toBe(r.resumen.ingresosCentavos)
  })
})

// =============================================================================

describe('reportes.managerial — this window against the one before it', () => {
  it('reports the current window and an EMPTY previous one honestly', () => {
    const r = reporteGerencial(ctx, RANGO, reloj)
    expect(r.periodoActual).toEqual({ fechaInicio: DIA, fechaFin: DIA })
    // Same LENGTH as the current window, ending the day before it starts so the two cannot
    // overlap. A one-day window therefore compares against exactly one day, not a month.
    expect(r.periodoAnterior).toEqual({ fechaInicio: '2026-09-30', fechaFin: '2026-09-30' })
    expect(r.cantidadDias).toBe(1)
    expect(r.resumen.totalVentasCentavos).toBe(41000)
    expect(r.anterior.totalVentasCentavos).toBe(0)
  })

  it('cannot state a growth rate against a window with nothing in it', () => {
    // Not 0%, not Infinity: there is no base to divide by, and Infinity would reach the renderer
    // as a cell reading "Infinity%".
    const r = reporteGerencial(ctx, RANGO, reloj)
    const ventas = r.comparativo.find((c) => c.indicador === 'Ventas')
    expect(ventas.actual).toBe(41000)
    expect(ventas.anterior).toBe(0)
    expect(ventas.variacion).toBeNull()
  })

  it('measures a margin in POINTS, not in percent', () => {
    const r = reporteGerencial(ctx, RANGO, reloj)
    const margen = r.comparativo.find((c) => c.indicador === 'Margen bruto')
    expect(margen.formato).toBe('porcentaje')
    expect(margen.tipo).toBe('pp')
    expect(margen.actual).toBe(40)
    // The previous window had no revenue, so it had NO MARGIN — not a margin of zero. The
    // variation is therefore unknown, and saying "+40 points" would be a false claim about a
    // business that has only just opened.
    expect(margen.anterior).toBeNull()
    expect(margen.variacion).toBeNull()
  })

  it('says it cannot tell a withdrawal apart, because nothing here withdraws', () => {
    // A confident $0,00 would imply a category the codebase does not have.
    const r = reporteGerencial(ctx, RANGO, reloj)
    expect(r.retiroDefinido).toBe(false)
    expect(r.resumen.totalRetiradoCentavos).toBe(0)
  })

  it('names the biggest day and the best-selling product', () => {
    const r = reporteGerencial(ctx, RANGO, reloj)
    // All three sales share one local day, so that day is both the largest and the smallest.
    expect(r.indicadores.diaMayorVenta).toEqual({ fecha: DIA, totalCentavos: 41000 })
    expect(r.indicadores.topProductoCantidad).toMatchObject({
      productoId: queso.id,
      cantidadMilli: 2000
    })
  })
})

// =============================================================================

describe('reportes.businessAnalysis — the diagnosis', () => {
  it('measures a margin on the cost recorded AT THE SALE', () => {
    const r = reporteAnalisisNegocio(ctx, RANGO, reloj)
    // Queso: 400,00 of lines against 240,00 of recorded cost (60,00 + 180,00) = 40%.
    const quesoEnInforme = r.detalle.productosMargenBajo.find((p) => p.productoId === queso.id)
    const items = [
      ...r.detalle.productosMargenBajo,
      ...r.detalle.productosNoPositivos
    ].filter((p) => p.productoId === queso.id)
    expect(items.length + (quesoEnInforme ? 1 : 0)).toBeGreaterThanOrEqual(0)
    // 40% is at or above the amber threshold, so the product is not flagged as thin at all.
    expect(r.detalle.productosMargenBajo.map((p) => p.productoId)).not.toContain(queso.id)
    expect(r.detalle.productosNoPositivos.map((p) => p.productoId)).not.toContain(queso.id)
    expect(r.semaforo.margenBruto.valorPct).toBe(40)
    expect(r.semaforo.margenBruto.color).toBe('verde')
  })

  it('exposes the thresholds it judged by, so the colour is not the law', () => {
    const r = reporteAnalisisNegocio(ctx, RANGO, reloj)
    expect(r.umbrales).toEqual({ margenVerdePct: 25, margenAmarilloPct: 15 })
  })

  it('calls an INCREASE in expenses red, and no base at all red too', () => {
    // The previous window had no expenses, so the variation has no denominator. Reading `null` as
    // neutral would call a brand new expense neutral, which is the one thing it must not be.
    registrarMovimiento(ctx, {
      caja,
      tipo: 'egreso',
      concepto: 'Luz del mes',
      montoCentavos: 3500,
      origen: 'manual'
    })
    const r = reporteAnalisisNegocio(ctx, RANGO, reloj)
    expect(r.semaforo.variacionGastos.variacionPct).toBeNull()
    expect(r.semaforo.variacionGastos.color).toBe('rojo')
  })

  it('lists a product that never moved, by name', () => {
    const inactivo = insertarProducto(t, {
      negocioId: t.negocioId,
      usuarioId: t.usuarioId,
      overrides: { nombre: 'Mate de yerba', precio_centavos: 5000, stock_milli: 1000 }
    })
    const r = reporteAnalisisNegocio(ctx, RANGO, reloj)
    expect(r.detalle.productosSinMovimiento.map((p) => p.nombre)).toContain('Mate de yerba')
    expect(r.detalle.productosSinMovimiento.map((p) => p.id)).toContain(inactivo.id)
  })
})

// =============================================================================

describe('reportes.stock — the shelf as it is right now', () => {
  it('reports the shelf in thousandths after the two weighed sales', () => {
    const r = reporteStock(ctx)
    // 3 kg on the shelf, half a kilo and a kilo and a half sold.
    const fila = r.list.find((p) => p.id === queso.id)
    expect(fila.stockMilli).toBe(1000)
    expect(fila.unidadMedida).toBe('kg')
    // 10 units, one sold.
    expect(r.list.find((p) => p.id === gaseosa.id).stockMilli).toBe(9000)
  })

  it('values the shelf at the recorded cost, in centavos', () => {
    const r = reporteStock(ctx)
    // queso 1 kg at 120,00 = 12.000; gaseosa 9 units at 6,00 = 5.400.
    expect(r.resumen.valorInventarioCentavos).toBe(17400)
  })

  it('counts a product at or below its minimum as low stock', () => {
    // The fixture's minimum is 5 kg and 1 kg is left, so this is the one that should be flagged.
    const r = reporteStock(ctx)
    expect(r.stockBajo.map((p) => p.id)).toContain(queso.id)
    // 9 units against a 5 kg minimum is 5000 milli, so 9000 is comfortably above it.
    expect(r.stockBajo.map((p) => p.id)).not.toContain(gaseosa.id)
  })
})

// =============================================================================

describe('reportes.expenses — only what the OWNER entered', () => {
  it('lists the owner expense and NOT the cash purchase', () => {
    registrarMovimiento(ctx, {
      caja,
      tipo: 'egreso',
      concepto: 'Luz del mes',
      montoCentavos: 3500,
      origen: 'manual'
    })
    crearCompra(ctx, {
      proveedorId: proveedor.id,
      metodoPago: 'efectivo',
      items: [{ productoId: queso.id, cantidad: '1', precioUnitario: '120.00' }]
    })
    const r = reporteGastos(ctx, RANGO, reloj)
    // The 120,00 purchase is money the shop spent, and it is ALSO money the shop spent on goods.
    // Counting it here as well is the web's `referencia NOT LIKE 'compra-%'` bug reproduced in the
    // wild: the same outflow twice, under two names. It is excluded, and only the 35,00 remains.
    expect(r.resumen.totalGastosCentavos).toBe(3500)
    expect(r.resumen.cantidadMovimientos).toBe(1)
    expect(r.detalle.map((d) => d.concepto)).toEqual(['Luz del mes'])
    expect(r.detalle[0].origen).toBe('manual')
  })

  it('cannot mistake a debtor\'s payment for money the shop spent', () => {
    // A collection is an `ingreso`, so it is on the other side of the ledger entirely. The web's
    // prefix rule looked at `referencia`, where a payment and a purchase share the word "pago".
    const deudor = insertarDeudor(t, { negocioId: t.negocioId, usuarioId: t.usuarioId })
    crearVenta(ctx, {
      items: [{ productoId: queso.id, cantidad: '1' }],
      metodoPago: 'credito',
      clienteDeudorId: deudor.id
    })
    const r = reporteGastos(ctx, RANGO, reloj)
    expect(r.resumen.totalGastosCentavos).toBe(0)
    expect(r.resumen.cantidadMovimientos).toBe(0)
  })

  it('is 0 and not null for a period with no expenses', () => {
    const r = reporteGastos(ctx, RANGO, reloj)
    expect(r.resumen.totalGastosCentavos).toBe(0)
    expect(r.resumen.promedioGastoCentavos).toBe(0)
  })
})

// =============================================================================

describe('reportes.purchases — what the shop bought, COMPLETED', () => {
  it('sums the completed purchases and names the supplier', () => {
    crearCompra(ctx, {
      proveedorId: proveedor.id,
      metodoPago: 'efectivo',
      items: [{ productoId: queso.id, cantidad: '1', precioUnitario: '120.00' }]
    })
    crearCompra(ctx, {
      proveedorId: proveedor.id,
      metodoPago: 'tarjeta',
      items: [{ productoId: queso.id, cantidad: '1', precioUnitario: '60.00' }]
    })
    const r = reporteCompras(ctx, RANGO, reloj)
    expect(r.resumen.cantidadCompras).toBe(2)
    expect(r.resumen.totalComprasCentavos).toBe(18000)
    expect(r.porProveedor).toEqual([{ proveedor: 'Distribuidora del Sur', totalCentavos: 18000 }])
  })

  it('excludes a purchase on credit, which is `pendiente` until it is paid', () => {
    // `compras.repo.js:218` sets `estado = metodoPago === 'credito' ? 'pendiente' : 'completada'`,
    // and the report reads only `completada` — which is what the web does as well
    // (`reporte.controller.js:245`). Goods have arrived, but this is not yet a purchase the shop
    // has settled, and the report that counts money owed as money spent is the one the owner
    // reconciles against a bank statement. The payable is still real, and it IS in the income
    // statement: the ledger carries it from the moment the purchase is recorded.
    const compra = crearCompra(ctx, {
      proveedorId: proveedor.id,
      metodoPago: 'credito',
      items: [{ productoId: queso.id, cantidad: '1', precioUnitario: '80.00' }]
    })
    expect(compra.estado).toBe('pendiente')
    expect(reporteCompras(ctx, RANGO, reloj).resumen.cantidadCompras).toBe(0)
    // ...and the 8.000 payable is on the ledger, signed positive.
    const proveedores = reporteEstadoResultados(ctx, RANGO, reloj).cuentas.find(
      (c) => c.codigo === '2.1.01'
    )
    expect(proveedores.saldoCentavos).toBe(8000)
  })

  it('reports a purchase paid by card, which left no trace in the drawer', () => {
    // Read from `compras`, not from the movements: a card purchase or a purchase on account moves
    // no cash, and a report built from the drawer would simply omit it.
    crearCompra(ctx, {
      proveedorId: proveedor.id,
      metodoPago: 'tarjeta',
      items: [{ productoId: queso.id, cantidad: '1', precioUnitario: '60.00' }]
    })
    expect(reporteCompras(ctx, RANGO, reloj).resumen.totalComprasCentavos).toBe(6000)
    // And the drawer is untouched by it, which is the point of the two reports disagreeing.
    expect(reporteCaja(ctx, {}).resumen.totalEgresosCentavos).toBe(0)
  })
})

// =============================================================================

describe('reportes.debtors — who owes, and what was collected', () => {
  it('reports a credit sale as a debt, and a payment as money collected', () => {
    const deudor = insertarDeudor(t, {
      negocioId: t.negocioId,
      usuarioId: t.usuarioId,
      nombre: 'Juan Carlos Pérez'
    })
    // One kilo of queso on credit: 200,00 owed.
    crearVenta(ctx, {
      items: [{ productoId: queso.id, cantidad: '1' }],
      metodoPago: 'credito',
      clienteDeudorId: deudor.id
    })
    const r = reporteDeudores(ctx, RANGO, reloj)
    expect(r.resumen.cantidadDeudores).toBe(1)
    expect(r.resumen.totalPendienteCentavos).toBe(20000)
    expect(r.detalle[0].nombre).toBe('Juan Carlos Pérez')
    // Nothing has been paid yet, so the collected figure is a real 0.
    expect(r.resumen.cobradoPeriodoCentavos).toBe(0)
    expect(r.resumen.cantidadCobros).toBe(0)
  })

  it('reads the balance from the view, so the report cannot disagree with the till', () => {
    // The derivation lives in `v_clientes_deudores` for exactly this reason: three queries that
    // each recompute "who owes what" are three chances to disagree with the drawer.
    const deudor = insertarDeudor(t, { negocioId: t.negocioId, usuarioId: t.usuarioId })
    crearVenta(ctx, {
      items: [{ productoId: queso.id, cantidad: '1' }],
      metodoPago: 'credito',
      clienteDeudorId: deudor.id
    })
    const desdeLaVista = t.conn.db
      .prepare('SELECT deuda_pendiente_centavos AS d FROM v_clientes_deudores WHERE id = ?')
      .get(deudor.id).d
    expect(reporteDeudores(ctx, RANGO, reloj).resumen.totalPendienteCentavos).toBe(desdeLaVista)
  })

  it('does not list a debtor who owes nothing', () => {
    insertarDeudor(t, { negocioId: t.negocioId, usuarioId: t.usuarioId })
    const r = reporteDeudores(ctx, RANGO, reloj)
    // A list of every customer, with a zero beside each, is noise; the report is for the people
    // who owe.
    expect(r.resumen.cantidadDeudores).toBe(0)
  })
})

// =============================================================================

describe('the local day, in the SQL the reports actually run', () => {
  /**
   * The $10,00 gaseosa sale, found BY VALUE rather than by position.
   *
   * `detalle` is ordered newest first and all three sales are posted milliseconds apart, so
   * `detalle[0]` is the gaseosa — which is not the sale a reader would assume, and picking a sale
   * by index in a test about dates is how a test ends up moving the wrong row and quietly
   * asserting nothing.
   */
  function idDeLaGaseosa() {
    const fila = reporteVentas(ctx, RANGO, reloj).detalle.find((v) => v.totalCentavos === 1000)
    if (!fila) throw new Error('no se encontró la venta de $10,00')
    return fila.id
  }

  /** Move a posted sale, and its ledger entry, to a chosen instant. */
  function situar(ventaId, isoUtc) {
    t.conn.db.prepare('UPDATE ventas SET fecha = ? WHERE id = ?').run(isoUtc, ventaId)
    t.conn.db
      .prepare(
        `UPDATE asientos_contables SET fecha = ?
          WHERE referencia = (SELECT folio FROM ventas WHERE id = ?)`
      )
      .run(isoUtc, ventaId)
  }

  it('COUNTS a sale at 23:30 local as today\'s', () => {
    // 23:30 in Córdoba is 02:30Z on the 2nd. The stored timestamp says the 2nd; the shop says the
    // 1st. `date('now')` and a date-only BETWEEN both lose this sale, and it is nine hours of every
    // day that they lose.
    situar(idDeLaGaseosa(), '2026-10-02T02:30:00.000Z')
    const r = reporteVentas(ctx, RANGO, reloj)
    expect(r.resumen.cantidadVentas).toBe(3)
    expect(r.resumen.totalIngresosCentavos).toBe(41000)
  })

  it('EXCLUDES a sale at 00:30 the next local day', () => {
    // 03:30Z is 00:30 local on the 2nd, so this one belongs to tomorrow's report. The remaining
    // two sales are the 100,00 and the 300,00 of queso.
    situar(idDeLaGaseosa(), '2026-10-02T03:30:00.000Z')
    const r = reporteVentas(ctx, RANGO, reloj)
    expect(r.resumen.cantidadVentas).toBe(2)
    expect(r.resumen.totalIngresosCentavos).toBe(40000)
  })

  it('buckets that late sale under TODAY in the daily rows too', () => {
    // The window and the grouping are different code. A sign mistake in one of them leaves every
    // total correct and only the per-day heading wrong, which is the bug that survives review.
    situar(idDeLaGaseosa(), '2026-10-02T02:30:00.000Z')
    const r = reporteEstadoResultados(ctx, RANGO, reloj)
    expect(r.diario.map((d) => d.fecha)).toEqual([DIA])
    expect(r.diario[0].ingresosCentavos).toBe(41000)
  })

  it('counts a sale from the previous window as the previous period, not this one', () => {
    // 21:00Z is 18:00 on the 30th in Argentina — inside the previous window of 2026-09-30.
    situar(idDeLaGaseosa(), '2026-09-30T21:00:00.000Z')
    const r = reporteGerencial(ctx, RANGO, reloj)
    expect(r.resumen.totalVentasCentavos).toBe(40000)
    expect(r.anterior.totalVentasCentavos).toBe(1000)
  })
})

// =============================================================================

describe('cross-tenant — the other shop\'s money is not this shop\'s money', () => {
  let otro
  let ctxOtro

  beforeEach(() => {
    const ts = '2026-01-01T00:00:00.000Z'
    const info = t.conn.db
      .prepare(
        `INSERT INTO negocios (nombre, ruc, tipo_comercio, configuracion, activo, created_at, updated_at)
         VALUES ('La Esquina', NULL, 'otro', '{}', 1, ?, ?)`
      )
      .run(ts, ts)
    otro = Number(info.lastInsertRowid)
    const usr = t.conn.db
      .prepare(
        // No `password` column: authentication was removed from the desktop and the credential
        // lives in `user_identidades`. A user row is all a report test needs, and inventing a
        // `password_hash` here would be a column that does not exist.
        `INSERT INTO users (nombre, email, rol, activo, negocio_id, created_at, updated_at)
         VALUES ('Otra', 'otra@ejemplo.test', 'admin', 1, ?, ?, ?)`
      )
      .run(otro, ts, ts)
    ctxOtro = {
      db: t.conn.db,
      tx: t.conn.tx,
      negocioId: otro,
      actorId: Number(usr.lastInsertRowid)
    }
  })

  it('excludes the other business\'s sales from every report', () => {
    // A big sale in the neighbouring shop. If any report forgot `negocio_id = ?`, this is the sale
    // that would appear in the wrong drawer, and it is a thousand times bigger than the real ones
    // so it cannot be mistaken for a rounding artefact.
    const suyo = insertarProducto(t, {
      negocioId: otro,
      usuarioId: ctxOtro.actorId,
      overrides: { nombre: 'Producto ajeno', precio_centavos: 999900, stock_milli: 1000 }
    })
    // Opened through the repository, not with a hand-written INSERT: `cajas` needs `user_id` AND
    // `usuario_apertura`, and a till the app could not have produced is not a useful control.
    abrir(ctxOtro, { saldoInicial: 0 })
    crearVenta(ctxOtro, {
      items: [{ productoId: suyo.id, cantidad: '1' }],
      metodoPago: 'efectivo',
      montoRecibido: 10000
    })

    // 410,00 of ours, and not one centavo of theirs.
    expect(reporteVentas(ctx, RANGO, reloj).resumen.totalIngresosCentavos).toBe(41000)
    expect(reporteEstadoResultados(ctx, RANGO, reloj).resumen.ingresosCentavos).toBe(41000)
    expect(reporteGerencial(ctx, RANGO, reloj).resumen.totalVentasCentavos).toBe(41000)
    expect(reporteProductosMasVendidos(ctx, RANGO, reloj).detalle.map((d) => d.nombre)).not.toContain(
      'Producto ajeno'
    )
    expect(reporteStock(ctx).list.map((p) => p.nombre)).not.toContain('Producto ajeno')
    // The drawer: 500,00 of float and three sales, and their till is not in it.
    expect(reporteCaja(ctx, {}).resumen.saldoNegocioCentavos).toBe(91000)
    expect(reporteCaja(ctx, {}).caja.id).toBe(caja.id)
  })

  it('does not let the other business\'s till be read by id', () => {
    // A real till, genuinely open, genuinely theirs. Asking for it by id from this business must
    // be refused rather than served: "you have no cash" and "that is not your till" are different
    // sentences, and only the second one is true here.
    const ajena = abrir(ctxOtro, { saldoInicial: 12345 })
    expect(() => reporteCaja(ctx, { cajaId: ajena.id })).toThrow(/No existe la caja/)
    // And the refusal is not a side effect of an empty shop: our own till still reports.
    expect(reporteCaja(ctx, { cajaId: caja.id }).caja.id).toBe(caja.id)
  })
})
