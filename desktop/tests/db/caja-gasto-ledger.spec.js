import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  tienda,
  ctxDe,
  abrirCaja,
  insertarProducto,
  insertarDeudor,
  partidasDeOperacion,
  saldosAsiento
} from './fixtures/tienda.js'
import { registrarMovimiento, saldoCaja } from '../../src/main/db/repositories/cajas.repo.js'
import { CUENTA } from '../../src/main/db/repositories/cuentas.repo.js'
import { crear as crearCompra } from '../../src/main/db/repositories/compras.repo.js'
import { crear as crearProveedor } from '../../src/main/db/repositories/proveedores.repo.js'
import { crear as crearVenta } from '../../src/main/db/repositories/ventas.repo.js'
import { registrarPago } from '../../src/main/db/repositories/deudores.repo.js'

/**
 * A manual till movement and the ledger — the behaviour, on its own, without a report.
 *
 * `reportes.spec.js` asserts that the DRAWER equals account `1.1.01` after an expense, and that
 * assertion is worth exactly as much as the accounting underneath it. This file is that accounting:
 * which account an expense is imputed to, whether the entry balances, and whether the four money
 * paths that already post an entry of their own are left alone. Split for the same reason `money.js`
 * and `qty.js` have their own specs: a report test that fails cannot tell you whether the report is
 * wrong or the money is, and this is the half that decides which.
 *
 * THE SCENARIO. One till, opened with a $500,00 float. Nothing else. So `1.1.01` starts at 50.000
 * and every expected number below is that float plus or minus the movement under test.
 *
 * TWO THINGS THIS FILE REFUSES TO DO, and both are the reason for its existence:
 *
 *   - it does not read a number back out of the code under test. Every figure is hand-derived from
 *     the posting rules, in a comment, next to the assertion. `expect(cuentaCaja).toBe(cuentaCaja)`
 *     passes forever and proves nothing at all.
 *   - it does not trust `coincide` or any other single headline. A drawer that moves and an account
 *     that does not can still look balanced in three different ways, so each test names the accounts
 *     it expects rather than the total it happens to add up to.
 */
let t
let ctx
let caja
let queso

/** One account's balance for this business: `debe - haber`, in centavos. */
function saldoCuenta(codigo) {
  return t.conn.db
    .prepare(
      `SELECT COALESCE(SUM(d.debe_centavos), 0) - COALESCE(SUM(d.haber_centavos), 0) AS n
         FROM detalles_asientos d JOIN cuentas_contables c ON c.id = d.cuenta_contable_id
        WHERE c.codigo = ? AND c.negocio_id = ?`
    )
    .get(codigo, t.negocioId).n
}

/** The journal lines of the entry this movement created, named rather than filtered. */
function partidasDelMovimiento() {
  const id = t.conn.db
    .prepare("SELECT id FROM asientos_contables WHERE referencia LIKE 'caja-movimiento:%' ORDER BY id DESC LIMIT 1")
    .get()
  return partidasDeOperacion(t, t.negocioId, `caja-movimiento:${Number(id.id)}`).map((p) => ({
    codigo: p.codigo,
    debe: p.debe,
    haber: p.haber
  }))
}

const comoMapa = (partidas) => Object.fromEntries(partidas.map((p) => [p.codigo, p]))

beforeEach(() => {
  t = tienda()
  ctx = ctxDe(t, t.negocioId, t.usuarioId)
  caja = abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId }) // 500,00
  queso = insertarProducto(t, {
    negocioId: t.negocioId,
    usuarioId: t.usuarioId,
    overrides: { nombre: 'Queso', precio_centavos: 20000, precio_compra_centavos: 12000, stock_milli: 3000 }
  })
})

afterEach(() => t.cerrar())

// =============================================================================

describe('a manual expense moves the drawer and the ledger, or neither', () => {
  it('debits Otros Gastos, credits Caja, and balances', () => {
    registrarMovimiento(ctx, { caja, tipo: 'egreso', concepto: 'Luz del mes', montoCentavos: 3500, origen: 'manual' })

    // THE TWO SIDES, BY NAME. An expense that credits the drawer and debits nothing is balanced the
    // way a sentence with no verb is grammatical: the trial balance would agree, `coincide` would be
    // true, and the income statement would report the shop as profitable with 3.500 of unexplained
    // cash missing. The debit is the half that carries the meaning, so it is asserted first and by
    // code rather than by total.
    expect(comoMapa(partidasDelMovimiento())).toEqual({
      [CUENTA.OTROS_GASTOS]: { codigo: '5.4.01', debe: 3500, haber: 0 },
      [CUENTA.CAJA]: { codigo: '1.1.01', debe: 0, haber: 3500 }
    })

    // `debe === haber`, read back from the database rather than from the argument this repository
    // was called with. `asentar` throws before the first INSERT when they differ, so a balanced row
    // here is evidence the validator ran, not arithmetic we repeated back to ourselves.
    const asientoId = t.conn.db
      .prepare("SELECT id FROM asientos_contables WHERE referencia LIKE 'caja-movimiento:%'")
      .get().id
    expect(saldosAsiento(t.conn, asientoId)).toEqual({ debe: 3500, haber: 3500 })
  })

  it('leaves the drawer and 1.1.01 EQUAL, asserted as equality and not as a delta', () => {
    registrarMovimiento(ctx, { caja, tipo: 'egreso', concepto: 'Luz del mes', montoCentavos: 3500, origen: 'manual' })

    // 50.000 float - 3.500. A delta assertion — "the account fell by 3.500" — would pass even if the
    // account had ALSO been debited by an unrelated 3.500 somewhere else, and that is precisely the
    // shape the bug had: the drawer moved and the account did not, so every delta lined up while
    // the two totals did not. Direct equality is the only assertion that can see it.
    const enLaBase = t.conn.db.prepare('SELECT * FROM cajas WHERE id = ?').get(caja.id)
    expect(saldoCaja(enLaBase)).toBe(46500)
    expect(saldoCuenta(CUENTA.CAJA)).toBe(46500)
    expect(saldoCuenta(CUENTA.CAJA)).toBe(saldoCaja(enLaBase))
  })

  it('grows the chart on the way in, so a database that predates 5.4.01 still works', () => {
    // THE REGRESSION THAT DECIDED THE ACCOUNT'S MECHANISM. `5.4.01` is in no migration, so it is
    // created by `asegurarPlan` — and the FIRST thing that calls it is usually a till opening with
    // a float, not an expense. That is the right order and worth stating: the account exists before
    // the first expense that could need it, rather than on the same request.
    expect(
      t.conn.db
        .prepare("SELECT nombre, tipo FROM cuentas_contables WHERE codigo = '5.4.01' AND negocio_id = ?")
        .get(t.negocioId)
    ).toEqual({ nombre: 'Otros Gastos', tipo: 'gasto' })

    // NOW THE CASE THAT ACTUALLY MATTERS: a shop that has been running since before this account
    // existed. Its chart has 25 rows and no catch-all. If the post assumed the account was there,
    // this would be a foreign-key failure on a database that was fine yesterday — and it would
    // surface as a crash on the one screen an owner reaches for when the drawer is short.
    // Deleting the row is what an older database actually looks like.
    t.conn.db.prepare("DELETE FROM cuentas_contables WHERE codigo = '5.4.01' AND negocio_id = ?").run(t.negocioId)
    expect(saldoCuenta(CUENTA.OTROS_GASTOS)).toBe(0)

    registrarMovimiento(ctx, { caja, tipo: 'egreso', concepto: 'Bolsas', montoCentavos: 1200, origen: 'manual' })

    // Back, and carrying the entry — created in the same transaction as the movement it explains.
    expect(saldoCuenta(CUENTA.OTROS_GASTOS)).toBe(1200)
    expect(saldoCuenta(CUENTA.CAJA)).toBe(50000 - 1200)
  })

  it('books an owner-entered INGRESO the other way round, against Otros Ingresos', () => {
    // The mirror, and a gap of its own rather than a courtesy. The operation accepts `tipo: 'ingreso'`,
    // and the `cerrar` failure tells an operator to use THIS operation to record the money they
    // forgot to ring up — so following the app's own advice used to move the drawer without the
    // ledger. `4.2.01 Otros Ingresos` was already in the chart, so this direction needed no new
    // account and only the same wiring.
    registrarMovimiento(ctx, { caja, tipo: 'ingreso', concepto: 'Fondo del mostrador', montoCentavos: 2500, origen: 'manual' })

    // Cash IN: the drawer is the DEBIT this time. Getting the sides the same way round as an
    // expense would credit `1.1.01` for money that arrived, and leave the drawer reporting less
    // cash than the owner is holding.
    expect(comoMapa(partidasDelMovimiento())).toEqual({
      [CUENTA.CAJA]: { codigo: '1.1.01', debe: 2500, haber: 0 },
      [CUENTA.OTROS_INGRESOS]: { codigo: '4.2.01', debe: 0, haber: 2500 }
    })
    expect(saldoCuenta(CUENTA.CAJA)).toBe(52500)
  })
})

// =============================================================================

describe('the money paths that already post an entry are left alone', () => {
  /**
   * THE COUNTERPART TO THE FIX, AND THE ONE THAT GUARDS IT.
   *
   * Four other flows reach `registrarMovimiento` and each posts its own entry, at a different moment
   * and against different accounts. If the post were keyed on "this moved the till" instead of
   * "nothing else posted it", each would gain a SECOND entry, and the second would be a drawer
   * credited twice against a catch-all — inflating expenses and reporting profit the shop never
   * made.
   *
   * `coincide` CANNOT see that. The drawer and `1.1.01` both move by the extra amount, so they
   * drift together and stay equal; the income statement is the only place the duplicate shows. So
   * these assert on ENTRY COUNTS, which is the only measurement that can tell one entry from two.
   */
  const entradas = () => t.conn.db.prepare('SELECT COUNT(*) AS n FROM asientos_contables').get().n

  it('a cash purchase still posts exactly one entry', () => {
    const proveedor = crearProveedor(ctx, { nombre: 'Distribuidora del Sur' })
    const antes = entradas()
    crearCompra(ctx, {
      proveedorId: proveedor.id,
      metodoPago: 'efectivo',
      items: [{ productoId: queso.id, cantidad: '1', precioUnitario: '120.00' }]
    })
    // ONE: inventory against the drawer. Two would mean the drawer was credited twice and
    // `1.2.01 Mercaderías` debited twice, which is a purchase that cost the shop double and a till
    // that reports twice the money it holds.
    expect(entradas() - antes).toBe(1)
    expect(saldoCuenta(CUENTA.CAJA)).toBe(50000 - 12000)
  })

  it('a cash sale still posts exactly two entries, and neither of them is the new one', () => {
    const antes = entradas()
    crearVenta(ctx, {
      items: [{ productoId: queso.id, cantidad: '0.5' }],
      metodoPago: 'efectivo',
      montoRecibido: 10000
    })
    // TWO, and the count is the point: a sale posts revenue and cost of goods as SEPARATE entries,
    // because they are separate economic facts and a margin is the difference between two entries.
    expect(entradas() - antes).toBe(2)
    // Not one of them touched the catch-all, and the expense account is still empty.
    expect(saldoCuenta(CUENTA.OTROS_GASTOS)).toBe(0)
    expect(saldoCuenta(CUENTA.CAJA)).toBe(50000 + 10000)
  })

  it('an expense after a sale adds exactly one entry, not three', () => {
    crearVenta(ctx, {
      items: [{ productoId: queso.id, cantidad: '0.5' }],
      metodoPago: 'efectivo',
      montoRecibido: 10000
    })
    const antes = entradas()
    registrarMovimiento(ctx, { caja, tipo: 'egreso', concepto: 'Luz', montoCentavos: 3500, origen: 'manual' })
    // The failure mode a later refactor would produce: a post keyed on the TILL rather than on
    // `manual` re-posts the sale too, and the number of entries is what says so.
    expect(entradas() - antes).toBe(1)
    // 50.000 float + 10.000 sale - 3.500 expense.
    expect(saldoCuenta(CUENTA.CAJA)).toBe(56500)
    expect(saldoCuenta(CUENTA.OTROS_GASTOS)).toBe(3500)
  })

  it('a debtor payment, which is `manual` too, does not gain a second entry', () => {
    // The one opt-out in the codebase, and it is one line long for a reason. Money collected from a
    // debtor is `origen: 'manual'` because no ticket brought it in — the same vocabulary an owner
    // expense uses — but its real counterpart is `1.3.01 Clientes (Deudores)`, the debt that got
    // cancelled, and `deudores.repo.js` already posts that entry itself. Posted here as well, the
    // drawer would be credited twice and a collected debt would read as earned income.
    const deudor = insertarDeudor(t, { negocioId: t.negocioId, usuarioId: t.usuarioId })
    // A $200,00 sale on credit. The repository insists on a debtor for it, which is the point: a
    // credit sale with nobody to owe the money is not a sale, it is a drawer that grew.
    crearVenta(ctx, {
      clienteDeudorId: deudor.id,
      items: [{ productoId: queso.id, cantidad: '1' }],
      metodoPago: 'credito',
      montoRecibido: 0
    })

    const antes = entradas()
    registrarPago(ctx, deudor.id, { monto: '100', metodoPago: 'efectivo' })
    // ONE: the drawer against the receivable. The sale above posted two, and this is the only
    // thing that changed since.
    expect(entradas() - antes).toBe(1)
    // The counterpart is the RECEIVABLE, not `4.2.01 Otros Ingresos`: collecting a debt is not
    // earning money, it is being given back what was owed. An entry here that credited the income
    // account would turn $100,00 of old debt into $100,00 of new sales.
    expect(saldoCuenta(CUENTA.CLIENTES)).toBe(20000 - 10000)
    expect(saldoCuenta(CUENTA.OTROS_INGRESOS)).toBe(0)
    // The 200,00 credit sale never touched the drawer; the 100,00 collected did.
    expect(saldoCuenta(CUENTA.CAJA)).toBe(50000 + 10000)
  })
})

// =============================================================================

describe('a movement that is not money does not invent an entry', () => {
  it('a zero movement is skipped, so the chart and the ledger are untouched', () => {
    // `movimientos_caja.monto_centavos >= 1`, and `registrarMovimiento` returns before the INSERT for
    // a zero. The consequence worth pinning is not the skipped row — it is that a zero must not post
    // a ZERO entry either, and must not run `asegurarPlan` on the way there. A balanced entry of
    // nothing is a row in the journal that explains no event, and it is the kind of row that turns
    // "why is there an entry with no movement behind it" into a question with no good answer.
    const cuentas = () => t.conn.db.prepare('SELECT COUNT(*) AS n FROM cuentas_contables WHERE negocio_id = ?').get(t.negocioId).n
    const entradasAntes = t.conn.db.prepare('SELECT COUNT(*) AS n FROM asientos_contables').get().n
    const movimientosAntes = t.conn.db.prepare('SELECT COUNT(*) AS n FROM movimientos_caja').get().n
    const cuentasAntes = cuentas()

    expect(registrarMovimiento(ctx, { caja, tipo: 'egreso', concepto: 'Nada', montoCentavos: 0, origen: 'manual' })).toBeNull()

    expect(t.conn.db.prepare('SELECT COUNT(*) AS n FROM asientos_contables').get().n).toBe(entradasAntes)
    expect(t.conn.db.prepare('SELECT COUNT(*) AS n FROM movimientos_caja').get().n).toBe(movimientosAntes)
    expect(cuentas()).toBe(cuentasAntes)
  })
})
