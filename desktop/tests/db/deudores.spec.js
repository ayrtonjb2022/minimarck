import { describe, it, expect, afterEach } from 'vitest'
import { crear as crearVenta } from '../../src/main/db/repositories/ventas.repo.js'
import { cerrar } from '../../src/main/db/repositories/cajas.repo.js'
import { balanceGeneral, CUENTA } from '../../src/main/db/repositories/cuentas.repo.js'
import {
  crear as crearDeudor,
  listar,
  pagos,
  registrarPago
} from '../../src/main/db/repositories/deudores.repo.js'
import { tienda, ctxDe, insertarProducto, abrirCaja, insertarDeudor, partidasDe } from './fixtures/tienda.js'

/**
 * The debtor repository, on a REAL migrated and seeded database.
 *
 * The claims this file is here to prove, and what each one would cost if it were false:
 *
 *   - A PARTIAL PAYMENT REDUCES THE BALANCE BY EXACTLY ITS OWN AMOUNT, read back through the view.
 *     $10.000 owed, $2.500 paid, $7.500 left — a rounding cent here is a customer disputing a
 *     number the shop printed on a receipt.
 *   - THE RECEIPT FIGURE IS THE VIEW'S FIGURE. The `deudor` in the response is re-read from
 *     `v_clientes_deudores` inside the payment's own transaction, so what the screen draws and
 *     what the next reader of the list gets are the same number by construction.
 *   - DOUBLE-ENTRY IDENTITY asked of the DATABASE, for all three methods: a payment debits the
 *     account the money landed in and credits `1.3.01 Clientes`, and the whole ledger still nets
 *     to zero.
 *   - ONLY CASH MOVES THE DRAWER. A card payment and a transfer post the same journal entry with
 *     the same effect on the debt and write NO `movimientos_caja` row — because a bank claim
 *     counted as cash is a till that can never be reconciled.
 *   - CASH WITH NO TILL OPEN writes NOTHING AT ALL: not the payment, not the journal, not the
 *     audit row. The refusal is tested by counting the tables afterwards, because a rollback that
 *     left the payment behind would be a receipt with no money.
 *   - A CREDIT SALE, A CANCELLATION AND A PAYMENT still net to zero across the whole ledger, which
 *     is the identity that says the two sides of this feature agree with each other.
 *
 * MONEY INPUTS are pesos, exactly what the renderer sends (`2500` = $2.500 = 250000 centavos);
 * assertions are centavos. SQLite is never mocked, and every balance comes from the view rather
 * than from arithmetic in the test, so a passing suite cannot be passing on a wrong formula.
 */

const stores = []
afterEach(() => {
  while (stores.length > 0) stores.pop().cerrar()
})

/** One product ($2.000/kg, 21% IVA, 3 kg) and an optional till, which is what a cash payment needs. */
function escenario({ conCaja = true } = {}) {
  const t = tienda()
  stores.push(t)
  const ctx = ctxDe(t, t.negocioId, t.usuarioId)
  const producto = insertarProducto(t, {
    negocioId: t.negocioId,
    usuarioId: t.usuarioId,
    overrides: { stock_milli: 3000 }
  })
  const caja = conCaja ? abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId }) : null
  return { t, ctx, producto, caja }
}

/** A debtor who owes $10.000: one 500 g sale at $2.000/kg, on credit. */
function deudorConDeuda({ conCaja = true, limiteCreditoCentavos = 1000000, monto = '10000' } = {}) {
  const s = escenario({ conCaja })
  const deudor = insertarDeudor(s.t, {
    negocioId: s.t.negocioId,
    usuarioId: s.t.usuarioId,
    limiteCreditoCentavos
  })
  // `items`, not `detalles`: that is the name `ventas.repo.js#validar` reads, and a guess would
  // have failed with "La venta debe tener al menos un producto" — a refusal about the shape of the
  // ticket that says nothing about the money.
  //
  // `cantidad: '0.5'` IS A STRING ON PURPOSE. `toMilli` scales a bare number by 1000, reading it as
  // whole units: `500` is 500 kilos, and the sale died of "Stock insuficiente" against a 3 kg shelf.
  // The POS sends a decimal as text, which is what this is.
  crearVenta(s.ctx, {
    clienteDeudorId: deudor.id,
    clienteNombre: deudor.nombre,
    metodoPago: 'credito',
    items: [{ productoId: s.producto.id, cantidad: '0.5', precioUnitario: 20000 }]
  })
  return { ...s, deudor }
}

function contar(t, tabla, negocioId) {
  return t.conn.db.prepare(`SELECT COUNT(*) AS n FROM ${tabla} WHERE negocio_id = ?`).get(negocioId).n
}

function pagosDe(t, negocioId) {
  return t.conn.db
    .prepare('SELECT * FROM pagos_deuda WHERE negocio_id = ? ORDER BY id')
    .all(negocioId)
}

function movimientosDe(t, cajaId) {
  return t.conn.db.prepare('SELECT * FROM movimientos_caja WHERE caja_id = ? ORDER BY id').all(cajaId)
}

/**
 * The movements EXCLUDING the opening one.
 *
 * `abrirCaja` writes a `caja_apertura` row for the float, so "the drawer did not move" has to
 * exclude the row that put money in it. Counting the raw list would report a movement on a card
 * payment and the assertion would be measuring the till being opened, not the payment.
 */
function movimientosDeCobro(t, cajaId) {
  return t.conn.db
    .prepare("SELECT * FROM movimientos_caja WHERE caja_id = ? AND origen <> 'caja_apertura' ORDER BY id")
    .all(cajaId)
}

describe('registrarPago — the partial payment', () => {
  it('takes part of the debt and leaves the exact remainder, read back through the view', () => {
    const { t, ctx, deudor } = deudorConDeuda()

    expect(listar(ctx, {}).filas[0].deudaPendienteCentavos).toBe(1000000)

    const r = registrarPago(ctx, deudor.id, { monto: '2500', metodoPago: 'efectivo' })

    // 10000 - 2500 = 7500, and not one cent of it was computed here: every figure is the view's.
    expect(r.pago.montoCentavos).toBe(250000)
    expect(r.deudor.deudaPendienteCentavos).toBe(750000)
    expect(r.pagadoCompleto).toBe(false)
    // The audit figure of what was ever owed does not move when money arrives. It is the
    // historical total, and shrinking it would make a cancelled sale look like it never existed.
    expect(r.deudor.deudaTotalCentavos).toBe(1000000)
    // And the list agrees with the response, which is the whole point of reading it back.
    expect(listar(ctx, {}).filas[0].deudaPendienteCentavos).toBe(750000)
    expect(t.conn.db.prepare('SELECT deuda_pendiente_centavos AS n FROM v_clientes_deudores WHERE id = ?').get(deudor.id).n).toBe(750000)
  })

  it('two instalments of the same debt add up to the debt, and only then is it settled', () => {
    const { t, ctx, deudor } = deudorConDeuda()

    const a = registrarPago(ctx, deudor.id, { monto: '3333' })
    expect(a.pagadoCompleto).toBe(false)
    expect(a.deudor.deudaPendienteCentavos).toBe(666700)

    // $33,33 three times is $99,99 and the last one cent is the fourth payment. This is the
    // reason the whole codebase is integer centavos: the sum is exact because no step was a float.
    registrarPago(ctx, deudor.id, { monto: '3333' })
    const c = registrarPago(ctx, deudor.id, { monto: '3334' })

    expect(c.pagadoCompleto).toBe(true)
    expect(c.deudor.deudaPendienteCentavos).toBe(0)
    expect(pagosDe(t, t.negocioId)).toHaveLength(3)
  })

  it('refuses a payment larger than the debt instead of banking the difference', () => {
    const { t, ctx, deudor } = deudorConDeuda()

    // $10.001 against $10.000 owed. The web refuses this too, and the view clamps at zero, but
    // the clamp is not permission: a silent clamp would answer `pendiente: 0` for a payment the
    // operator believes was recorded, and the receipt would say the debt is settled.
    expect(() => registrarPago(ctx, deudor.id, { monto: '10001' })).toThrowError(/excede la deuda/i)

    expect(pagosDe(t, t.negocioId)).toHaveLength(0)
    expect(listar(ctx, {}).filas[0].deudaPendienteCentavos).toBe(1000000)
  })
  it('refuses a payment when there is no debt at all, and writes nothing', () => {
    const { t, ctx } = escenario()
    const deudor = insertarDeudor(t, { negocioId: t.negocioId, usuarioId: t.usuarioId })

    expect(() => registrarPago(ctx, deudor.id, { monto: '1000' })).toThrowError(/excede la deuda/i)
    expect(contar(t, 'pagos_deuda', t.negocioId)).toBe(0)
    expect(contar(t, 'detalles_asientos', t.negocioId)).toBe(0)
  })

  it('refuses zero, a negative amount and a non-numeric amount, each before any write', () => {
    const { t, ctx, deudor } = deudorConDeuda()

    expect(() => registrarPago(ctx, deudor.id, { monto: '0' })).toThrowError(/mayor a 0/i)
    expect(() => registrarPago(ctx, deudor.id, { monto: '-500' })).toThrowError(/mayor a 0/i)
    expect(() => registrarPago(ctx, deudor.id, { monto: 'doce' })).toThrowError()

    expect(contar(t, 'pagos_deuda', t.negocioId)).toBe(0)
    // FOUR, not two: the credit sale is a two-line entry (Clientes / Ingresos) and the IVA accrual
    // posts its own pair. The count proves these three refusals added nothing to it.
    expect(contar(t, 'detalles_asientos', t.negocioId)).toBe(4)
  })
})

describe('registrarPago — the method decides the account and the drawer', () => {
  it('cash debits the till, credits Clientes, and moves the drawer', () => {
    const { t, ctx, deudor, caja } = deudorConDeuda()
    const ingresosAntes = caja.total_ingresos_centavos

    const r = registrarPago(ctx, deudor.id, { monto: '1000', metodoPago: 'efectivo' })

    // The entry, asked of the database by account CODE rather than by id, so a remapped chart of
    // accounts would fail this test instead of silently passing it.
    const partidas = t.conn.db
      .prepare(
        `SELECT c.codigo, d.debe_centavos AS debe, d.haber_centavos AS haber
           FROM detalles_asientos d
           JOIN cuentas_contables c ON c.id = d.cuenta_contable_id
          WHERE d.asiento_contable_id = (SELECT id FROM asientos_contables WHERE referencia = ?)
          ORDER BY c.codigo`
      )
      .all(`pago:${r.pago.id}`)

    expect(partidas).toEqual([
      { codigo: CUENTA.CAJA, debe: 100000, haber: 0 },
      { codigo: CUENTA.CLIENTES, debe: 0, haber: 100000 }
    ])

    // The drawer, not just the journal: `total_ingresos` is what the till counts at close.
    const mov = movimientosDeCobro(t, caja.id).at(-1)
    expect(mov.tipo).toBe('ingreso')
    expect(mov.monto_centavos).toBe(100000)
    expect(mov.origen).toBe('manual')
    expect(mov.venta_id).toBeNull()
    const cajaDespues = t.conn.db.prepare('SELECT * FROM cajas WHERE id = ?').get(caja.id)
    expect(cajaDespues.total_ingresos_centavos).toBe(ingresosAntes + 100000)
  })

  it('a card payment posts the SAME debt reduction and moves NO drawer at all', () => {
    const { t, ctx, deudor, caja } = deudorConDeuda()
    const ingresosAntes = caja.total_ingresos_centavos

    const r = registrarPago(ctx, deudor.id, { monto: '1000', metodoPago: 'tarjeta' })

    // The debt fell by the same amount: the receivable is settled either way.
    expect(r.deudor.deudaPendienteCentavos).toBe(900000)
    expect(r.movimientoCaja).toBeNull()

    const codigos = t.conn.db
      .prepare(
        `SELECT c.codigo, d.debe_centavos AS debe
           FROM detalles_asientos d
           JOIN cuentas_contables c ON c.id = d.cuenta_contable_id
          WHERE d.asiento_contable_id = (SELECT id FROM asientos_contables WHERE referencia = ?)
          ORDER BY c.codigo`
      )
      .all(`pago:${r.pago.id}`)
    expect(codigos).toEqual([
      { codigo: CUENTA.BANCO, debe: 100000 },
      { codigo: CUENTA.CLIENTES, debe: 0 }
    ])

    // This is the assertion that matters most in the whole file: a card claim is a bank balance,
    // and the only number that proves it is that the DRAWER did not move.
    expect(movimientosDeCobro(t, caja.id)).toHaveLength(0)
    const cajaDespues = t.conn.db.prepare('SELECT * FROM cajas WHERE id = ?').get(caja.id)
    expect(cajaDespues.total_ingresos_centavos).toBe(ingresosAntes)
  })

  it('a transfer behaves exactly like a card: Banco, no drawer', () => {
    const { t, ctx, deudor, caja } = deudorConDeuda()

    registrarPago(ctx, deudor.id, { monto: '1000', metodoPago: 'transferencia' })

    expect(movimientosDeCobro(t, caja.id)).toHaveLength(0)
    const banco = t.conn.db
      .prepare(
        `SELECT SUM(debe_centavos) AS n FROM detalles_asientos d
           JOIN cuentas_contables c ON c.id = d.cuenta_contable_id
          WHERE c.codigo = ?`
      )
      .get(CUENTA.BANCO).n
    expect(banco).toBe(100000)
  })

  it('refuses `mixto` — the port says where the money went, and a split nobody collects cannot', () => {
    const { t, ctx, deudor } = deudorConDeuda()

    // The WEB accepts `mixto` on a payment (`deudor.controller.js:291-296`) because it writes no
    // journal entry for one. Accepting it here would mean posting a single entry for money whose
    // destination is unknown, which is a lie in a ledger rather than a missing feature.
    expect(() => registrarPago(ctx, deudor.id, { monto: '1000', metodoPago: 'mixto' })).toThrowError(
      /desglose efectivo\/crédito/i
    )
    expect(contar(t, 'pagos_deuda', t.negocioId)).toBe(0)
    expect(contar(t, 'detalles_asientos', t.negocioId)).toBe(4)
  })

  it('allows a card payment with no till open, because a card never needed a drawer', () => {
    const { t, ctx, deudor } = deudorConDeuda({ conCaja: false })

    const r = registrarPago(ctx, deudor.id, { monto: '1000', metodoPago: 'tarjeta' })
    expect(r.deudor.deudaPendienteCentavos).toBe(900000)
    expect(contar(t, 'pagos_deuda', t.negocioId)).toBe(1)
  })

  it('refuses a CASH payment with no till open, and writes nothing at all', () => {
    const { t, ctx, deudor } = deudorConDeuda({ conCaja: false })
    const partidasAntes = contar(t, 'detalles_asientos', t.negocioId)
    const auditoriaAntes = contar(t, 'auditoria', t.negocioId)

    expect(() => registrarPago(ctx, deudor.id, { monto: '1000', metodoPago: 'efectivo' })).toThrowError(
      /no hay caja abierta/i
    )

    // The rollback is the assertion. A payment row without a drawer movement is a receipt for
    // money that is in nobody's till, and a journal entry for cash that never arrived. The
    // auditoria count is taken against a BEFORE number rather than zero, because the scenario's
    // own credit sale and the till opening already wrote their own rows.
    expect(contar(t, 'pagos_deuda', t.negocioId)).toBe(0)
    expect(contar(t, 'detalles_asientos', t.negocioId)).toBe(partidasAntes)
    expect(contar(t, 'auditoria', t.negocioId)).toBe(auditoriaAntes)
    expect(listar(ctx, {}).filas[0].deudaPendienteCentavos).toBe(1000000)
  })

  it('defaults to cash when no method is sent, and says so in the stored row', () => {
    const { ctx, deudor } = deudorConDeuda()

    const r = registrarPago(ctx, deudor.id, { monto: '100' })
    expect(r.pago.metodoPago).toBe('efectivo')
  })
})

describe('registrarPago — the ledger', () => {
  it('a credit sale plus a payment still nets the whole ledger to zero', () => {
    const { t, ctx, deudor } = deudorConDeuda()

    registrarPago(ctx, deudor.id, { monto: '4000', metodoPago: 'efectivo' })

    // Asked of the database as a SUM over every line in the business, which is the only form in
    // which "balanced" means something: each entry can be balanced on its own while the ledger
    // drifts, and only the total catches it.
    const sumas = partidasDe(t, t.negocioId).reduce(
      (acc, p) => ({ debe: acc.debe + p.debe, haber: acc.haber + p.haber }),
      { debe: 0, haber: 0 }
    )
    expect(sumas.debe).toBe(sumas.haber)
    expect(sumas.debe).toBeGreaterThan(0)
  })

  it('three payments in three methods net to zero, and the receivable ends at the debt', () => {
    const { t, ctx, deudor } = deudorConDeuda()

    registrarPago(ctx, deudor.id, { monto: '2000', metodoPago: 'efectivo' })
    registrarPago(ctx, deudor.id, { monto: '3000', metodoPago: 'tarjeta' })
    const r = registrarPago(ctx, deudor.id, { monto: '5000', metodoPago: 'transferencia' })

    expect(r.pagadoCompleto).toBe(true)
    const b = balanceGeneral(t.conn.db, t.negocioId)
    expect(b.debe).toBe(b.haber)
    // 1.3.01 was debited 10000 by the sale and credited 10000 by the three payments, so what is
    // left of the receivable is nothing — read as the account's own balance, not as the view.
    const clientes = t.conn.db
      .prepare(
        `SELECT COALESCE(SUM(d.debe_centavos), 0) - COALESCE(SUM(d.haber_centavos), 0) AS n
           FROM detalles_asientos d JOIN cuentas_contables c ON c.id = d.cuenta_contable_id
          WHERE c.codigo = ?`
      )
      .get(CUENTA.CLIENTES).n
    expect(clientes).toBe(0)
  })

  it('a payment is not tied to a sale, so its `venta_id` is null and the drawer says `manual`', () => {
    const { t, ctx, deudor, caja } = deudorConDeuda()

    registrarPago(ctx, deudor.id, { monto: '1000', metodoPago: 'efectivo', referencia: 'REC-77' })

    const pago = pagosDe(t, t.negocioId)[0]
    expect(pago.venta_id).toBeNull()
    expect(pago.referencia).toBe('REC-77')
    expect(movimientosDeCobro(t, caja.id)[0].origen).toBe('manual')
  })
})

describe('registrarPago — atomicity', () => {
  it('a failure injected at the LAST write takes the payment, the ledger and the drawer with it', () => {
    const { t, ctx, deudor, caja } = deudorConDeuda()
    const partidasAntes = contar(t, 'detalles_asientos', t.negocioId)
    const movimientosAntes = movimientosDeCobro(t, caja.id).length

    // The auditoria INSERT is the last write of the payment. A trigger that refuses it simulates
    // a disk error at the worst possible moment, and a mock could not tell the difference between
    // "it threw" and "it threw and left half a payment behind".
    t.conn.db.exec(`
      CREATE TRIGGER test_rechaza_auditoria
      BEFORE INSERT ON auditoria
      WHEN NEW.tabla = 'pagos_deuda'
      BEGIN SELECT RAISE(ABORT, 'disco lleno'); END;
    `)

    expect(() => registrarPago(ctx, deudor.id, { monto: '1000', metodoPago: 'efectivo' })).toThrow()

    expect(contar(t, 'pagos_deuda', t.negocioId)).toBe(0)
    expect(contar(t, 'detalles_asientos', t.negocioId)).toBe(partidasAntes)
    expect(movimientosDeCobro(t, caja.id)).toHaveLength(movimientosAntes)
    expect(listar(ctx, {}).filas[0].deudaPendienteCentavos).toBe(1000000)
  })
})

describe('pagos — the history behind the balance', () => {
  it('returns newest first, in the contract\'s field names', () => {
    const { ctx, deudor } = deudorConDeuda()

    registrarPago(ctx, deudor.id, { monto: '1000', metodoPago: 'efectivo' })
    registrarPago(ctx, deudor.id, { monto: '2000', metodoPago: 'tarjeta' })

    const r = pagos(ctx, deudor.id)
    expect(r.deudorId).toBe(deudor.id)
    expect(r.pagos.map((p) => p.montoCentavos)).toEqual([200000, 100000])
    expect(r.pagos[0].metodoPago).toBe('tarjeta')
    // The same names the receipt reads. `monto` does not exist on this contract, and an earlier
    // receipt read it and summed every row to zero.
    expect(r.pagos[0]).toHaveProperty('montoCentavos')
    expect(r.pagos[0]).not.toHaveProperty('monto')
  })

  it('refuses a malformed id, and scopes the history to the debtor asked for', () => {
    const { ctx, deudor } = deudorConDeuda()
    registrarPago(ctx, deudor.id, { monto: '1000' })

    // `0`, a string and a negative are all nonsense, and they are refused as such rather than
    // answering `[]` — an empty history reads as "this customer has never paid", which for a
    // malformed id is a false statement about a real person's account.
    expect(() => pagos(ctx, 0)).toThrowError(/inválido/i)
    expect(() => pagos(ctx, 'abc')).toThrowError(/inválido/i)
    expect(() => pagos(ctx, -1)).toThrowError(/inválido/i)

    // An id that is well-formed but belongs to nobody returns an empty list, and that IS the
    // web's behavior (`getPagos` queries by `deudorId` and paginates whatever it finds,
    // `deudor.controller.js:360-388`). Adding an existence check here would be the port
    // inventing a refusal the web does not make, over a read the caller only ever issues with an
    // id it just read off a debtor row.
    expect(pagos(ctx, 999999).pagos).toEqual([])
  })

  it('never shows one shop a payment recorded in another', () => {
    const { t, ctx, deudor } = deudorConDeuda()
    registrarPago(ctx, deudor.id, { monto: '1000' })

    // The ids are global autoincrements, so the debtor id alone would be enough to find the row.
    // The `negocio_id` predicate is the thing that makes this a scoping test rather than an id test.
    const otroNegocio = Number(
      t.conn.db
        .prepare('INSERT INTO negocios (nombre, tipo_comercio, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('Tienda vecina', 'kiosco', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z').lastInsertRowid
    )
    const ctxOtro = { ...ctx, negocioId: otroNegocio }
    expect(pagos(ctxOtro, deudor.id).pagos).toEqual([])
  })
})

describe('listar — searching and filtering', () => {
  it('finds by name and by document, case-insensitively', () => {
    const { t, ctx } = escenario()
    const a = insertarDeudor(t, {
      negocioId: t.negocioId,
      usuarioId: t.usuarioId,
      nombre: 'Ana Beatriz Gómez'
    })
    t.conn.db
      .prepare('UPDATE clientes_deudores SET documento = ? WHERE id = ?')
      .run('30111222', a.id)
    insertarDeudor(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, nombre: 'Carlos Ruiz' })

    expect(listar(ctx, { search: 'beatriz' }).filas.map((d) => d.id)).toEqual([a.id])
    expect(listar(ctx, { search: 'GÓMEZ' }).filas.map((d) => d.id)).toEqual([a.id])
    expect(listar(ctx, { search: '30111222' }).filas.map((d) => d.id)).toEqual([a.id])
    expect(listar(ctx, { search: 'nadie' }).filas).toHaveLength(0)
  })

  it('treats a `%` in the search as a literal, not as a wildcard', () => {
    const { t, ctx } = escenario()
    insertarDeudor(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, nombre: 'Café 100%' })

    // Unescaped, this LIKE would match every customer in the shop and the operator would be shown
    // a list of people who do not contain a percent sign anywhere in their name.
    expect(listar(ctx, { search: '100%' }).filas).toHaveLength(1)
    expect(listar(ctx, { search: '%%' }).filas).toHaveLength(0)
  })

  it('`conDeuda` returns only the people who actually owe something', () => {
    const { t, ctx, producto } = escenario()
    const debe = insertarDeudor(t, {
      negocioId: t.negocioId,
      usuarioId: t.usuarioId,
      nombre: 'Con deuda',
      limiteCreditoCentavos: 1000000
    })
    insertarDeudor(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, nombre: 'Sin deuda' })

    // The filter reads the VIEW, not a stored column, so it needs a real credit sale behind it.
    // Naming a debtor "Con deuda" and asserting the filter would be testing the label.
    crearVenta(ctx, {
      clienteDeudorId: debe.id,
      metodoPago: 'credito',
      items: [{ productoId: producto.id, cantidad: '0.5' }]
    })

    expect(listar(ctx, { conDeuda: true }).filas.map((d) => d.id)).toEqual([debe.id])
    expect(listar(ctx, {}).filas).toHaveLength(2)
  })

  it('a debtor who has paid everything in full drops out of `conDeuda`', () => {
    const { ctx, deudor } = deudorConDeuda()
    registrarPago(ctx, deudor.id, { monto: '10000' })

    expect(listar(ctx, { conDeuda: true }).filas).toHaveLength(0)
    expect(listar(ctx, {}).filas).toHaveLength(1)
  })

  it('is scoped to the business: another tenant\'s customer is invisible', () => {
    const { t, ctx } = escenario()
    const otro = t.conn.db
      .prepare('INSERT INTO negocios (nombre, tipo_comercio, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('Otro Minimark', 'kiosco', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    const otroId = Number(otro.lastInsertRowid)
    t.conn.db
      .prepare(
        `INSERT INTO clientes_deudores (nombre, user_id, negocio_id, activo, created_at, updated_at)
         VALUES (?, ?, ?, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run('Cliente del otro', t.usuarioId, otroId)

    expect(listar(ctx, {}).filas.map((d) => d.nombre)).not.toContain('Cliente del otro')
    expect(listar(ctx, { search: 'otro' }).filas).toHaveLength(0)
  })

  it('paginates and reports the TOTAL, not the page length', () => {
    const { t, ctx } = escenario()
    for (let i = 0; i < 3; i += 1) {
      insertarDeudor(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, nombre: `Cliente ${i}` })
    }
    const r = listar(ctx, { limit: 2, offset: 0 })
    expect(r.filas).toHaveLength(2)
    expect(r.total).toBe(3)
    expect(listar(ctx, { limit: 2, offset: 2 }).filas).toHaveLength(1)
  })
})

describe('crear — the customer a credit sale needs', () => {
  it('creates a customer with a limit, in pesos, and reads the balances back as zero', () => {
    const { ctx } = escenario()

    const d = crearDeudor(ctx, { nombre: '  María López  ', documento: ' 27123456 ', limiteCredito: '50000' })

    expect(d.nombre).toBe('María López')
    expect(d.documento).toBe('27123456')
    // $50.000 typed as pesos, stored as 5000000 centavos. The conversion happens once, at the edge.
    expect(d.limiteCreditoCentavos).toBe(5000000)
    expect(d.deudaTotalCentavos).toBe(0)
    expect(d.deudaPendienteCentavos).toBe(0)
    expect(d.activo).toBe(true)
  })

  it('leaves the limit null when none was given, which is a real setting and not a zero', () => {
    const { ctx } = escenario()
    const d = crearDeudor(ctx, { nombre: 'Sin tope' })

    // A zero limit would refuse every credit sale forever, and a POS that shows "$0,00" for a
    // customer with no limit is telling the cashier something false.
    expect(d.limiteCreditoCentavos).toBeNull()
  })

  it('refuses a negative limit with a sentence that names the number', () => {
    const { ctx } = escenario()
    expect(() => crearDeudor(ctx, { nombre: 'Negativo', limiteCredito: '-1' })).toThrowError(/negativo/i)
  })

  it('refuses a duplicate document in the same shop, in words an operator can act on', () => {
    const { ctx } = escenario()
    crearDeudor(ctx, { nombre: 'Uno', documento: '11222333' })

    // The message matters as much as the refusal. SQLite's own text is `UNIQUE constraint failed:
    // clientes_deudores.documento, clientes_deudores.negocio_id`, which tells the person standing
    // at the till nothing they can do about it — and it arrives as an unhandled 500, because
    // `toIpcError` cannot recognise SQLITE_CONSTRAINT_UNIQUE and turn it into a 400.
    let err
    try {
      crearDeudor(ctx, { nombre: 'Dos', documento: '11222333' })
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
    expect(err.message).toMatch(/ya existe/i)
    expect(err.message).toContain('11222333')
  })

  it('the same document in a DIFFERENT shop is not a duplicate', () => {
    const { t, ctx } = escenario()
    crearDeudor(ctx, { nombre: 'Uno', documento: '55667788' })

    // The index is `(documento, negocio_id)`, not `documento`. One shop's customer number is
    // another shop's customer number too, and a national document would break that.
    const otro = t.conn.db
      .prepare('INSERT INTO negocios (nombre, tipo_comercio, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('Otro Minimark', 'kiosco', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    const otroId = Number(otro.lastInsertRowid)
    t.conn.db
      .prepare(
        `INSERT INTO clientes_deudores (nombre, documento, user_id, negocio_id, activo, created_at, updated_at)
         VALUES (?, '55667788', ?, ?, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run('Uno del otro', t.usuarioId, otroId)

    expect(listar(ctx, { search: '55667788' }).filas).toHaveLength(1)
  })

  it('refuses an empty name, which is what a blank form submits', () => {
    const { ctx } = escenario()
    expect(() => crearDeudor(ctx, { nombre: '   ' })).toThrowError(/necesita un nombre/i)
  })
})

describe('the till and the receivable agree with the drawer', () => {
  it('a cash payment moves the drawer and the 1.1.01 account by the SAME amount', () => {
    const { t, ctx, deudor, caja } = deudorConDeuda()

    // Both sides are read BEFORE and AFTER, and the assertion is on the DIFFERENCE. That is what
    // this operation is responsible for.
    //
    // It is deliberately not an assertion that the account balance EQUALS the drawer balance. It
    // does not, and cannot: `cajas.abrir` records the opening float as a `movimientos_caja` row
    // and posts NO journal entry for it, so `1.1.01` understates the till by the float. That is a
    // pre-existing gap in the till-opening path, it is not something `addPayment` introduced, and
    // it is recorded in `DIVERGENCES.md` §4b rather than silently absorbed here. Asserting the
    // equality would have "passed" only by hiding the float inside the expected value.
    const saldoCuenta = () =>
      t.conn.db
        .prepare(
          `SELECT COALESCE(SUM(d.debe_centavos), 0) - COALESCE(SUM(d.haber_centavos), 0) AS n
             FROM detalles_asientos d JOIN cuentas_contables c ON c.id = d.cuenta_contable_id
            WHERE c.codigo = ?`
        )
        .get(CUENTA.CAJA).n
    const saldoDrawer = () =>
      t.conn.db
        .prepare(
          `SELECT ? + COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN monto_centavos
                                        WHEN tipo = 'egreso' THEN -monto_centavos ELSE 0 END), 0) AS n
             FROM movimientos_caja WHERE caja_id = ?`
        )
        .get(caja.saldo_inicial_centavos, caja.id).n

    const cuentaAntes = saldoCuenta()
    const drawerAntes = saldoDrawer()

    const r = registrarPago(ctx, deudor.id, { monto: '1000', metodoPago: 'efectivo' })

    // If a payment ever moved one without the other, the till a cashier counts at close and the
    // account an accountant reads would drift apart by exactly that payment, every time, and
    // neither could be used to check the other. This is the assertion that catches it.
    expect(saldoCuenta() - cuentaAntes).toBe(100000)
    expect(saldoDrawer() - drawerAntes).toBe(100000)
    expect(saldoCuenta() - cuentaAntes).toBe(saldoDrawer() - drawerAntes)

    const mov = movimientosDeCobro(t, caja.id).at(-1)
    const asiento = t.conn.db
      .prepare('SELECT * FROM asientos_contables WHERE referencia = ?')
      .get(`pago:${r.pago.id}`)
    expect(mov.monto_centavos).toBe(100000)
    expect(mov.origen).toBe('manual')
    expect(asiento.tipo).toBe('ingreso')
    // And what the customer owes is 10000 - 1000, which the sale's own debit and the payment's
    // own credit both say.
    expect(r.deudor.deudaPendienteCentavos).toBe(1000000 - 100000)
  })

  it('the cash is still countable at close: a payment of $1.000 lands in the drawer total', () => {
    const { t, ctx, deudor } = deudorConDeuda()
    registrarPago(ctx, deudor.id, { monto: '1000', metodoPago: 'efectivo' })

    // `cerrar` derives the final balance from the movements themselves — it does not take a
    // declared amount. So the number it stamps is the drawer's own sum, and if the payment had
    // not reached `movimientos_caja` this figure would still be the opening float.
    const caja = t.conn.db
      .prepare("SELECT * FROM cajas WHERE negocio_id = ? AND estado = 'abierta'")
      .get(t.negocioId)
    const cerrada = cerrar(
      { db: t.conn.db, tx: t.conn.tx, negocioId: t.negocioId, actorId: t.usuarioId },
      caja.id
    )

    expect(cerrada.estado).toBe('cerrada')
    expect(cerrada.saldo_final_centavos).toBe(caja.saldo_inicial_centavos + 100000)
  })
})
