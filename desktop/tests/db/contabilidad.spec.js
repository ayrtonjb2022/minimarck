import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tienda, ctxDe } from './fixtures/tienda.js'
import {
  actualizarCuenta,
  actualizarDeuda,
  balance,
  crearAsiento,
  crearCuenta,
  crearDeuda,
  dashboard,
  eliminarAsiento,
  eliminarCuenta,
  listarAsientos,
  listarCuentas,
  listarDeudas,
  obtenerAsiento,
  registrarPagoDeuda
} from '../../src/main/db/repositories/contabilidad.repo.js'

/**
 * `contabilidad.*` — the fifteen operations, against a real SQLite file.
 *
 * ── WHAT IS WORTH PINNING HERE, AND WHAT IS NOT ───────────────────────────────────────────────
 *
 * The interesting claims are not "a row was inserted". They are the ones where a plausible
 * implementation is WRONG, and each test below names the bug it prevents:
 *
 *   - An unbalanced entry must be REFUSED, before the first INSERT. A ledger that accepts one is
 *     permanently wrong and there is no sweep job that fixes it later.
 *   - A partida that moves BOTH sides can still satisfy `SUM(debe) = SUM(haber)` while claiming the
 *     same peso was spent twice, so it is refused separately.
 *   - Paying more than is owed must be refused: the balance would go negative and every figure
 *     derived from it — percentage paid, "is it settled" — becomes nonsense.
 *   - A settled debt must NOT be reopenable as active. This one is not hypothetical: it was a real
 *     defect in this repository, and the test found it.
 *   - An account with movements must not be deletable, because `balanceGeneral` groups over
 *     `cuentas_contables` and deleting one would remove its sums from the trial balance while its
 *     lines stayed behind — the ledger would stop balancing against itself and the report would
 *     look fine.
 *
 * ── WHY THE FIXTURE AND NOT MOCKS ─────────────────────────────────────────────────────────────
 *
 * Same reason as every other spec in `tests/db/`: the invariants here are enforced by PART being in
 * the same transaction as the rest, by SQLite's CHECKs, and by a UNIQUE index. A mock would test
 * this file's own arithmetic back at itself. `ctxDe` hands over the real `{ db, tx, negocioId,
 * actorId }` the IPC layer builds.
 */

let t
let ctx

beforeEach(() => {
  t = tienda()
  ctx = ctxDe(t, t.negocioId, t.usuarioId)
})

afterEach(() => {
  t.cerrar()
})

/** Two accounts of the seeded chart, named by code so no test carries a row id. */
const cuenta = (codigo) => listarCuentas(ctx).find((c) => c.codigo === codigo)

/**
 * The error a call threw, with `{ code, status, message }` intact.
 *
 * `migrate.spec.js:29` states the convention this follows: assert on `IpcError.code`, never on the
 * message. The message is free to be reworded, and a message match can be satisfied by the WRONG
 * error — which is not hypothetical here, because `eliminarCuenta` raises two refusals that both
 * talk about the same account and only one of them is the one a given test is about.
 */
const capturar = (fn) => {
  let err = null
  try {
    fn()
  } catch (e) {
    err = e
  }
  expect(err, `expected a throw, got ${err === null ? 'no error at all' : 'nothing'}`).not.toBeNull()
  return err
}

describe('el plan de cuentas', () => {
  it('se crea solo la primera vez que se mira, y trae las 24 del plan', () => {
    // The chart is created lazily by whichever flow needs it (`asegurarPlan`), so a shop that has
    // never sold anything has an EMPTY chart. This screen is where somebody would look before
    // selling, so looking has to produce the real plan rather than an empty table.
    const cuentas = listarCuentas(ctx)
    expect(cuentas.length).toBeGreaterThanOrEqual(24)
    expect(cuentas.map((c) => c.codigo)).toContain('1.1.01')
    expect(cuentas.map((c) => c.codigo)).toContain('4.1.01')
  })

  it('el saldo viene FIRMADO por tipo, no calculado por el llamador', () => {
    // An asset grows on the debit side and a liability on the credit side, so the same
    // `SUM(debe) - SUM(haber)` is wrong for half the chart. The sign comes from `saldoDeTipo`, which
    // main reads through; a screen that subtracted on its own would show a loan as a negative asset.
    const { id: caja } = cuenta('1.1.01')
    const { id: prestamo } = cuenta('2.2.02')
    crearAsiento(ctx, {
      fecha: '2026-10-01',
      descripcion: 'Préstamo cobrado en efectivo',
      tipo: 'apertura',
      partidas: [
        { cuentaId: caja, debe: '1000.00' },
        { cuentaId: prestamo, haber: '1000.00' }
      ]
    })

    const activo = listarCuentas(ctx).find((c) => c.codigo === '1.1.01')
    const pasivo = listarCuentas(ctx).find((c) => c.codigo === '2.2.02')
    expect(activo.saldoCentavos).toBe(100000)
    // A liability is POSITIVE when owed: it is money the shop has and must give back.
    expect(pasivo.saldoCentavos).toBe(100000)
  })

  it('refusa un código repetido y un tipo que el esquema no permite', () => {
    crearCuenta(ctx, { codigo: '6.1.01', nombre: 'Prueba', tipo: 'gasto' })
    expect(() => crearCuenta(ctx, { codigo: '6.1.01', nombre: 'Otra', tipo: 'gasto' })).toThrow(
      /ya existe/
    )
    expect(() => crearCuenta(ctx, { codigo: '6.1.02', nombre: 'X', tipo: 'inventado' })).toThrow(
      /Tipo de cuenta inválido/
    )
  })

  it('no deja que una cuenta sea su propia madre, ni por un ciclo de dos', () => {
    const madre = crearCuenta(ctx, { codigo: '6.2.01', nombre: 'Madre', tipo: 'gasto' })
    const hija = crearCuenta(ctx, { codigo: '6.2.02', nombre: 'Hija', tipo: 'gasto', parentId: madre.id })
    expect(() => actualizarCuenta(ctx, madre.id, { parentId: hija.id })).toThrow(/depende de esta cuenta/)
    expect(() => actualizarCuenta(ctx, madre.id, { parentId: madre.id })).toThrow(/su propia cuenta padre/)
  })

  it('NO borra una cuenta con movimientos, y lo dice con el número', () => {
    // The database would refuse this anyway (`detalles_asientos` is RESTRICT on the account), with a
    // constraint error nobody can act on. The check turns it into a 409 that names how many lines.
    const { id: caja } = cuenta('1.1.01')
    const { id: capital } = cuenta('3.1.01')
    crearAsiento(ctx, {
      descripcion: 'Aporte',
      tipo: 'apertura',
      partidas: [
        { cuentaId: caja, debe: '100.00' },
        { cuentaId: capital, haber: '100.00' }
      ]
    })
    // `caja` IS the id — the destructure above took `id` out of the row, so `caja.id` is
    // `undefined` on a number. Passing that never reached the guard under test: it died six lines
    // earlier at `assertId`, which meant this negative control was GREEN for the wrong reason and
    // the real `CUENTA_CON_MOVIMIENTOS` refusal was untested. Every sibling below passes the bare id.
    expect(() => eliminarCuenta(ctx, caja)).toThrow(/movimiento\(s\) en el libro mayor/)
  })

  it('CUENTA_CON_HIJAS: NO borra una cuenta que agrupa otras, y la hija sobrevive intacta', () => {
    // DIVERGENCES entry 20 claims BOTH `CUENTA_CON_MOVIMIENTOS` and `CUENTA_CON_HIJAS`. The first
    // half had a test; this is the second half, which had none.
    //
    // WHY THIS ONE IS DIFFERENT, AND WHY IT NEEDS ITS OWN TEST. The movements guard has the
    // DATABASE behind it: `detalles_asientos.cuenta_contable_id` is `ON DELETE RESTRICT`
    // (`001_init.sql:435`), so even with the check deleted the delete would fail. This guard has
    // NOTHING behind it — `cuentas_contables.parent_id` is `ON DELETE SET NULL` (`001_init.sql:383`)
    // and `connection.js:214` sets `foreign_keys=ON`, so if the check were ever removed the DELETE
    // WOULD SUCCEED and SQLite would silently re-parent the children to NULL. The chart would then
    // show a set of accounts that used to be under a heading and now float free, and NOTHING would
    // have failed: no constraint, no exception, no red suite. That is why the second assertion
    // below is about `parent_id` and not about the row merely existing.
    const madre = crearCuenta(ctx, { codigo: '6.4.01', nombre: 'Grupo', tipo: 'gasto' })
    const hija = crearCuenta(ctx, {
      codigo: '6.4.02',
      nombre: 'Hija del grupo',
      tipo: 'gasto',
      parentId: madre.id
    })

    // The parent has NO movements, so the guard that fires cannot be the movements one — and the
    // code is asserted rather than the message, per `migrate.spec.js:29` ("assert on `IpcError.code`,
    // never on the message"), because `CUENTA_CON_MOVIMIENTOS` and `CUENTA_CON_HIJAS` are different
    // errors and a message match could not tell them apart.
    const err = capturar(() => eliminarCuenta(ctx, madre.id))
    expect(err.code).toBe('CUENTA_CON_HIJAS')
    // The refusal has to be ACTUALLY actionable, not just a code: an operator who is told only
    // "cannot delete" has no next step, so the count of what has to be reassigned is in the text.
    expect(err.message).toMatch(/1 cuenta\(s\)/)
    expect(err.status).toBe(409)

    const madreViva = t.conn.db
      .prepare('SELECT id FROM cuentas_contables WHERE id = ? AND negocio_id = ?')
      .get(madre.id, t.negocioId)
    expect(madreViva, 'the parent must not have been deleted').toBeTruthy()

    const hijaViva = t.conn.db
      .prepare('SELECT id, parent_id FROM cuentas_contables WHERE id = ? AND negocio_id = ?')
      .get(hija.id, t.negocioId)
    expect(hijaViva, 'the child must not have been deleted').toBeTruthy()
    // THE LOAD-BEARING ASSERTION. If the guard ever stops working, the child row is still here —
    // `SET NULL` KEEPS the row — it is merely orphaned. `toBeTruthy()` above passes in that broken
    // world; only this line notices. Measured with the guard disabled: the delete returns
    // `{eliminada: true}` and the child is left at `parent_id = null`.
    expect(hijaViva.parent_id, 'the child was silently re-parented to NULL').toBe(madre.id)
  })

  it('SÍ borra una cuenta que nadie usó', () => {
    const nueva = crearCuenta(ctx, { codigo: '6.3.01', nombre: 'Sin uso', tipo: 'gasto' })
    expect(eliminarCuenta(ctx, nueva.id).eliminada).toBe(true)
  })
})

describe('el libro diario', () => {
  it('escribe un asiento balanceado y lo devuelve con sus partidas', () => {
    const a = crearAsiento(ctx, {
      fecha: '2026-10-02',
      descripcion: 'Aporte del dueño',
      tipo: 'apertura',
      partidas: [
        { cuentaId: cuenta('1.1.01').id, debe: '5000.00' },
        { cuentaId: cuenta('3.1.01').id, haber: '5000.00' }
      ]
    })
    expect(a.id).toBeGreaterThan(0)
    expect(a.totalDebeCentavos).toBe(500000)
    expect(a.totalHaberCentavos).toBe(500000)
    expect(a.balanceado).toBe(true)
    expect(a.detalles).toHaveLength(2)
    expect(a.detalles.every((d) => d.codigo)).toBe(true)
  })

  it('REFUSA un asiento desbalanceado, y no escribe nada', () => {
    const antes = listarAsientos(ctx).total
    expect(() =>
      crearAsiento(ctx, {
        descripcion: 'Desbalanceado',
        tipo: 'ajuste',
        partidas: [
          { cuentaId: cuenta('1.1.01').id, debe: '100.00' },
          { cuentaId: cuenta('4.1.01').id, haber: '50.00' }
        ]
      })
    ).toThrow(/desbalanceado/)
    // The refusal is before the first INSERT, so the ledger is untouched. A half-written entry is
    // worse than a refused one: it is permanent and nothing sweeps it later.
    expect(listarAsientos(ctx).total).toBe(antes)
  })

  it('REFUSA una partida que mueve los dos lados', () => {
    // `SUM(debe) = SUM(haber)` can still hold while a row claims the same peso was spent and
    // received twice, which is a lie the balance check cannot see.
    expect(() =>
      crearAsiento(ctx, {
        descripcion: 'Partida doble',
        tipo: 'ajuste',
        partidas: [
          { cuentaId: cuenta('1.1.01').id, debe: '100.00', haber: '100.00' },
          { cuentaId: cuenta('4.1.01').id, debe: '100.00' }
        ]
      })
    ).toThrow(/mueve UN lado/)
  })

  it('REFUSA un asiento de una sola partida por su FORMA', () => {
    // One line cannot balance unless it is zero, and zero is not an entry. Refusing it as
    // "desbalanceado" would be true and useless: the person typed one line.
    expect(() =>
      crearAsiento(ctx, {
        descripcion: 'Una sola',
        tipo: 'ajuste',
        partidas: [{ cuentaId: cuenta('1.1.01').id, debe: '100.00' }]
      })
    ).toThrow(/al menos dos partidas/)
  })

  it('las partidas en cero se descartan, y un asiento todo en cero se refusa', () => {
    // A genuinely free, no-cost item moves nothing, so an entry with zeros in it is a row that has
    // to be explained at every future audit for no accounting meaning.
    expect(() =>
      crearAsiento(ctx, {
        descripcion: 'Todo en cero',
        tipo: 'ajuste',
        partidas: [
          { cuentaId: cuenta('1.1.01').id, debe: '0' },
          { cuentaId: cuenta('4.1.01').id, haber: '0' }
        ]
      })
    ).toThrow(/cero/)
  })

  it('un asiento escrito por la app NO se puede borrar; uno a mano sí', () => {
    // Every machine-written entry carries a `referencia`. Deleting one would leave the sale without
    // its journal row — the exact state `cuentas.repo.js` exists to end.
    const sistema = crearAsiento(ctx, {
      descripcion: 'De una venta',
      tipo: 'ingreso',
      referencia: 'venta:99',
      partidas: [
        { cuentaId: cuenta('1.1.01').id, debe: '10.00' },
        { cuentaId: cuenta('4.1.01').id, haber: '10.00' }
      ]
    })
    expect(() => eliminarAsiento(ctx, sistema.id)).toThrow(/lo escribió la app/)

    const manual = crearAsiento(ctx, {
      descripcion: 'A mano',
      tipo: 'ajuste',
      partidas: [
        { cuentaId: cuenta('1.1.01').id, debe: '10.00' },
        { cuentaId: cuenta('4.1.01').id, haber: '10.00' }
      ]
    })
    expect(eliminarAsiento(ctx, manual.id).eliminado).toBe(true)
    // The lines go with the header (`ON DELETE CASCADE`), so the ledger cannot be left with orphans.
    expect(
      t.conn.db.prepare('SELECT COUNT(*) AS n FROM detalles_asientos WHERE asiento_contable_id = ?').get(manual.id).n
    ).toBe(0)
  })

  it('el detalle ordena el debe antes que el haber, como se lee un asiento', () => {
    const a = crearAsiento(ctx, {
      descripcion: 'Orden',
      tipo: 'ajuste',
      partidas: [
        { cuentaId: cuenta('4.1.01').id, haber: '10.00' },
        { cuentaId: cuenta('1.1.01').id, debe: '10.00' }
      ]
    })
    const detalle = obtenerAsiento(ctx, a.id)
    expect(detalle.detalles[0].debeCentavos).toBe(1000)
    expect(detalle.detalles[1].haberCentavos).toBe(1000)
  })
})

describe('las deudas del negocio', () => {
  it('nace con el saldo igual al monto original, nunca tomado del llamador', () => {
    // A form that could type the remaining balance would create a debt born half-paid, which is a
    // state only a payment can produce.
    const d = crearDeuda(ctx, {
      nombre: 'Préstamo',
      tipo: 'prestamo_bancario',
      montoOriginal: '120000.00',
      fechaInicio: '2026-10-01'
    })
    expect(d.saldoPendienteCentavos).toBe(d.montoOriginalCentavos)
    expect(d.porcentajePagado).toBe(0)
    expect(d.estado).toBe('activo')
  })

  it('un pago baja el saldo EXACTAMENTE y avanza la cuota', () => {
    const d = crearDeuda(ctx, {
      nombre: 'Préstamo',
      montoOriginal: '120000.00',
      cuotasTotales: 12,
      fechaInicio: '2026-10-01'
    })
    const r = registrarPagoDeuda(ctx, {
      deudaId: d.id,
      monto: '20000.00',
      metodoPago: 'transferencia',
      numeroCuota: 1
    })
    expect(r.deuda.saldoPendienteCentavos).toBe(10000000)
    expect(r.deuda.cuotasPagadas).toBe(1)
    expect(r.deuda.estado).toBe('activo')
    expect(r.deuda.porcentajePagado).toBe(16)
  })

  it('el saldo lo mueve el PAGO, no el formulario de edición', () => {
    const d = crearDeuda(ctx, { nombre: 'P', montoOriginal: '1000.00', fechaInicio: '2026-10-01' })
    actualizarDeuda(ctx, d.id, { nombre: 'P renombrada', saldoPendienteCentavos: 0 })
    expect(listarDeudas(ctx).filas[0].saldoPendienteCentavos).toBe(100000)
  })

  it('REFUSA un pago que excede el saldo, y lo dice con el número', () => {
    const d = crearDeuda(ctx, { nombre: 'P', montoOriginal: '500.00', fechaInicio: '2026-10-01' })
    expect(() => registrarPagoDeuda(ctx, { deudaId: d.id, monto: '999.00' })).toThrow(/supera el saldo/)
  })

  it('pagar todo deja la deuda PAGADA sola', () => {
    const d = crearDeuda(ctx, { nombre: 'P', montoOriginal: '500.00', fechaInicio: '2026-10-01' })
    const r = registrarPagoDeuda(ctx, { deudaId: d.id, monto: '500.00' })
    expect(r.deuda.saldoPendienteCentavos).toBe(0)
    expect(r.deuda.estado).toBe('pagado')
  })

  it('NO deja marcar pagada una deuda con saldo, ni reabrir una saldada', () => {
    // Both directions, because both are states the ledger cannot explain. The second one was a real
    // defect in this repository: a settled debt parked back in the "what do I have to pay" bucket
    // is a row the owner chases forever, with a zero next to it.
    const conSaldo = crearDeuda(ctx, { nombre: 'A', montoOriginal: '500.00', fechaInicio: '2026-10-01' })
    expect(() => actualizarDeuda(ctx, conSaldo.id, { estado: 'pagado' })).toThrow(/pendiente/)

    const saldada = crearDeuda(ctx, { nombre: 'B', montoOriginal: '500.00', fechaInicio: '2026-10-01' })
    registrarPagoDeuda(ctx, { deudaId: saldada.id, monto: '500.00' })
    expect(() => actualizarDeuda(ctx, saldada.id, { estado: 'activo' })).toThrow(/ya figura como pagada/)
  })

  it('la lista pone las impagas primero, que es lo que hay que pagar', () => {
    const pagada = crearDeuda(ctx, { nombre: 'Z pagada', montoOriginal: '100.00', fechaInicio: '2026-10-01' })
    registrarPagoDeuda(ctx, { deudaId: pagada.id, monto: '100.00' })
    crearDeuda(ctx, { nombre: 'A activa', montoOriginal: '100.00', fechaInicio: '2026-10-01' })
    expect(listarDeudas(ctx).filas[0].nombre).toBe('A activa')
  })
})

describe('el balance', () => {
  it('cuadra siempre, porque cada asiento se rechaza si no balancea', () => {
    crearAsiento(ctx, {
      descripcion: 'Aporte',
      tipo: 'apertura',
      partidas: [
        { cuentaId: cuenta('1.1.01').id, debe: '5000.00' },
        { cuentaId: cuenta('3.1.01').id, haber: '5000.00' }
      ]
    })
    const b = balance(ctx)
    expect(b.cuadra).toBe(true)
    expect(b.totalDebeCentavos).toBe(b.totalHaberCentavos)
    expect(b.activoCentavos).toBe(500000)
    expect(b.capitalCentavos).toBe(500000)
    expect(b.diferenciaCentavos).toBe(0)
  })

  it('la ecuación contable cierra: activo = pasivo + capital + resultado', () => {
    crearAsiento(ctx, {
      descripcion: 'Préstamo y aporte',
      tipo: 'apertura',
      partidas: [
        { cuentaId: cuenta('1.1.01').id, debe: '8000.00' },
        { cuentaId: cuenta('2.2.02').id, haber: '3000.00' },
        { cuentaId: cuenta('3.1.01').id, haber: '5000.00' }
      ]
    })
    const b = balance(ctx)
    expect(b.activoCentavos).toBe(800000)
    expect(b.pasivoCentavos).toBe(300000)
    expect(b.capitalCentavos).toBe(500000)
    // The screen shows the same three-line check; asserting it here means a change that breaks the
    // equation fails in the data layer rather than on a screen nobody rendered in the suite.
    expect(b.activoCentavos).toBe(b.pasivoCentavos + b.capitalCentavos + b.resultadoCentavos)
  })

  it('`conSaldo` deja sólo las cuentas que se movieron', () => {
    crearAsiento(ctx, {
      descripcion: 'Aporte',
      tipo: 'apertura',
      partidas: [
        { cuentaId: cuenta('1.1.01').id, debe: '100.00' },
        { cuentaId: cuenta('3.1.01').id, haber: '100.00' }
      ]
    })
    expect(balance(ctx, { conSaldo: true }).cuentas.length).toBeLessThan(balance(ctx).cuentas.length)
    expect(balance(ctx, { conSaldo: true }).cuentas.length).toBeGreaterThan(0)
  })
})

describe('el panel contable', () => {
  it('lee los mismos números que el balance, en una sola llamada', () => {
    crearAsiento(ctx, {
      descripcion: 'Aporte',
      tipo: 'apertura',
      partidas: [
        { cuentaId: cuenta('1.1.01').id, debe: '5000.00' },
        { cuentaId: cuenta('3.1.01').id, haber: '5000.00' }
      ]
    })
    const d = dashboard(ctx)
    const b = balance(ctx)
    // THE POINT OF THE PANEL: it cannot disagree with the balance screen, because it is the same
    // sums read through the same functions.
    expect(d.activoCentavos).toBe(b.activoCentavos)
    expect(d.pasivoCentavos).toBe(b.pasivoCentavos)
    expect(d.capitalCentavos).toBe(b.capitalCentavos)
    expect(d.cuadra).toBe(b.cuadra)
    expect(d.patrimonioCentavos).toBe(b.capitalCentavos + b.resultadoCentavos)
  })

  it('cuenta las deudas abiertas y su saldo pendiente', () => {
    const a = crearDeuda(ctx, { nombre: 'A', montoOriginal: '1000.00', fechaInicio: '2026-10-01' })
    crearDeuda(ctx, { nombre: 'B', montoOriginal: '500.00', fechaInicio: '2026-10-01' })
    registrarPagoDeuda(ctx, { deudaId: a.id, monto: '1000.00' })
    const d = dashboard(ctx)
    expect(d.deudasTotal).toBe(2)
    expect(d.deudasAbiertas).toBe(1)
    expect(d.deudasPendientesCentavos).toBe(50000)
  })
})
