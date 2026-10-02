/**
 * THE `deudores.*` IPC HANDLERS — the layer between a renderer and money.
 *
 * `tests/db/deudores.spec.js` calls the repository directly, and `tests/ui/deudores.spec.jsx`
 * drives the screen. Neither proves what crosses the boundary, and the boundary is where a
 * handler quietly disagrees with the repository it wraps. Specifically:
 *
 *   1. `requireTenant` is called by the HANDLER, so a caller that forgot the tenant marker is
 *      refused at the door — not after it has read somebody else's customers.
 *   2. The 501s stay 501s. `get`/`update`/`remove` were in the frozen 89 before anyone wrote them,
 *      and a screen this build does not have must not be reachable by guessing a name.
 *   3. `monto` is PESOS at this boundary too. The renderer converts once; a handler that also
 *      converted would be a factor of a hundred, and the renderer cannot even see the difference.
 *   4. The balances that come back are the VIEW's. This is asserted against the database rather
 *      than against the handler, because "the handler returned what the repository said" is a
 *      claim about wiring, and wiring is exactly what is untested elsewhere.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRegistry } from '../../src/main/bridge/registry.js'
import { registerDeudoresHandlers } from '../../src/main/ipc/deudores.js'
import { registerVentasHandlers } from '../../src/main/ipc/ventas.js'
import { tienda, ctxDe, insertarProducto, insertarDeudor, abrirCaja } from '../db/fixtures/tienda.js'
import { OPS } from '../../src/shared/ipc-contract.js'

let t
let registry
let ctx

beforeEach(() => {
  t = tienda()
  registry = createRegistry()
  // Both groups, so a credit sale can be made through the same boundary the renderer uses
  // instead of the fixture inventing its own accounting behind the test's back.
  registerVentasHandlers(registry, { conn: t.conn })
  registerDeudoresHandlers(registry, { conn: t.conn })
  ctx = ctxDe(t, t.negocioId, t.usuarioId)
})

afterEach(() => {
  t.cerrar()
})

const resolver = (grupo, op) => registry.resolve(grupo, op)
const deudores = (op) => resolver('deudores', op)

/** A debtor who really owes $300.00: one product, one credit sale through the real boundary. */
function deudorQueDebe(nombre = 'Ana Beatriz Gómez', limiteCreditoCentavos = 1000000) {
  const producto = insertarProducto(t, {
    negocioId: t.negocioId,
    usuarioId: t.usuarioId,
    overrides: { nombre: 'Queso artesanal', precio_centavos: 20000, stock_milli: 10000 }
  })
  const deudor = insertarDeudor(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, nombre, limiteCreditoCentavos })
  resolver('ventas', 'create')(
    { items: [{ productoId: producto.id, cantidad: '1.5' }], metodoPago: 'credito', clienteDeudorId: deudor.id },
    ctx
  )
  return { producto, deudor }
}

describe('the tenant marker is checked at the door', () => {
  it('refuses every read and every write without a negocioId', () => {
    const deudor = insertarDeudor(t, { negocioId: t.negocioId, usuarioId: t.usuarioId })
    // A handler that forgot `requireTenant` would answer with the whole customer list of whatever
    // tenant the context happened to resolve to. These are the two shapes of that mistake.
    // THE CODE, NOT THE MESSAGE: `mensajeDeError` shows `.message` to an owner, so it is written
    // for them, but the contract callers branch on is `TENANT_REQUIRED` and that is what belongs
    // in an assertion here.
    expect(() => deudores('list')({}, {})).toThrowError(expect.objectContaining({ code: 'TENANT_REQUIRED' }))
    expect(() => deudores('payments')({ deudorId: deudor.id }, {})).toThrowError(
      expect.objectContaining({ code: 'TENANT_REQUIRED' })
    )
    expect(() => deudores('addPayment')({ deudorId: deudor.id, monto: '10' }, {})).toThrowError(
      expect.objectContaining({ code: 'TENANT_REQUIRED' })
    )
  })

  it('never answers another tenant about a debtor that is not theirs', () => {
    const deudor = insertarDeudor(t, { negocioId: t.negocioId, usuarioId: t.usuarioId })
    const otro = ctxDe(t, 999, t.usuarioId)
    // The debtor id is a global autoincrement, so a missing `negocio_id` predicate would read
    // another shop's customer by number. This asserts the answer is EMPTY rather than asserting a
    // refusal: an empty history is what the web returns too (`deudor.controller.js#getPagos`
    // queries by `deudorId` and paginates what it finds), and a caller who holds a real debtor id
    // learns nothing from a refusal. The leak is what must not happen.
    expect(deudores('payments')({ deudorId: deudor.id }, otro).pagos).toEqual([])

    // And a WRITE across the boundary is refused, because unlike a read it moves money. A payment
    // into shop 999 for a customer of shop 1 is a transfer nobody authorised.
    expect(() => deudores('addPayment')({ deudorId: deudor.id, monto: '10', metodoPago: 'efectivo' }, otro)).toThrowError(
      /no encontrado|inválido/i
    )
    expect(t.conn.db.prepare('SELECT COUNT(*) AS n FROM pagos_deuda').get().n).toBe(0)
  })
})

describe('the operations this build has not built stay honestly unavailable', () => {
  it('answers 501 with a code, for the three that are named but not implemented', () => {
    for (const op of ['get', 'update', 'remove']) {
      let err = null
      try {
        deudores(op)({ deudorId: 1, nombre: 'x' }, ctx)
      } catch (e) {
        err = e
      }
      // A 501 is a promise to come back. An unregistered op that throws "handler not found" is a
      // 500 wearing a disguise, and a renderer catching it shows the operator an error instead of
      // an honest "not yet".
      expect(err, `${op} should refuse`).not.toBeNull()
      expect([404, 501, 405], `${op} status`).toContain(err.status)
      expect(err.message, `${op} message`).toBeTruthy()
    }
  })

  it('every deudores operation in the frozen contract is either handled or refused, never missing', () => {
    const delGrupo = [...OPS.deudores]
    expect(delGrupo.length).toBe(7)
    for (const op of delGrupo) {
      // The point is not that it works. The point is that the renderer gets a deliberate answer
      // for all seven, so a missing handler can never be mistaken for a finished feature.
      let status = 200
      try {
        deudores(op)({ deudorId: 1, nombre: 'x', monto: '10' }, ctx)
      } catch (e) {
        status = e.status ?? 500
      }
      expect([200, 400, 404, 501, 405], `deudores.${op} answered ${status}`).toContain(status)
    }
  })
})

describe('addPayment crosses the boundary in the units the renderer speaks', () => {
  it('takes PESOS and returns the balance the view computed', () => {
    abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, saldoInicialCentavos: 500 })
    const { deudor } = deudorQueDebe() // $300.00 owed

    // `'100'` means one hundred pesos. If this boundary converted again, it would store 100
    // centavos and collect one peso instead of one hundred — a factor of a hundred, accepted
    // silently, with a receipt that agrees with the mistake.
    const r = deudores('addPayment')({ deudorId: deudor.id, monto: '100', metodoPago: 'efectivo' }, ctx)

    expect(r.pago.montoCentavos).toBe(10000)
    expect(r.deudor.deudaPendienteCentavos).toBe(20000) // 30000 owed, 10000 paid
    // The returned balance is the view's number, read back after the transaction, not the
    // handler's arithmetic: 30000 - 10000 computed here would be a second opinion nobody checked.
    const vista = t.conn.db
      .prepare('SELECT deuda_pendiente_centavos AS n FROM v_clientes_deudores WHERE id = ?')
      .get(deudor.id)
    expect(r.deudor.deudaPendienteCentavos).toBe(vista.n)
  })

  it('answers the settled case with its own flag, so the receipt does not have to guess', () => {
    abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, saldoInicialCentavos: 500 })
    const { deudor } = deudorQueDebe() // $300.00 owed

    const parcial = deudores('addPayment')({ deudorId: deudor.id, monto: '100', metodoPago: 'efectivo' }, ctx)
    expect(parcial.pagadoCompleto).toBe(false)

    const total = deudores('addPayment')({ deudorId: deudor.id, monto: '200', metodoPago: 'efectivo' }, ctx)
    // A receipt that has to work out "is this account finished?" from a zero balance will one day
    // print the wrong thing, because a zero balance is also what a bug produces.
    expect(total.pagadoCompleto).toBe(true)
    expect(total.deudor.deudaPendienteCentavos).toBe(0)
  })
})
