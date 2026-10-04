import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  abrir,
  cerrar,
  obtener,
  listar,
  saldoGeneral,
  desglose,
  registrarMovimiento,
  saldoCaja
} from '../../src/main/db/repositories/cajas.repo.js'
import { crear } from '../../src/main/db/repositories/ventas.repo.js'
import { registrarPago } from '../../src/main/db/repositories/deudores.repo.js'
import { cajaActiva } from '../../src/main/db/repositories/cajas.repo.js'
import { balanceAsiento, CUENTA } from '../../src/main/db/repositories/cuentas.repo.js'
import { hoyLocal } from '../../src/main/db/reportes/fechas.js'
import { tienda, ctxDe, abrirCaja, insertarProducto, insertarDeudor } from './fixtures/tienda.js'

/**
 * The till (design D.5, spec CAJA-1..4), on REAL sqlite.
 *
 * The facts these tests pin down, because each one is a place a till either stays honest or
 * quietly isn't:
 *
 *   - THE FLOAT IS NOT INCOME. `abrir` records the APERTURA movement but never counts it toward
 *     `total_ingresos`, exactly like the web (`caja.controller.js:40-62`), because the close
 *     formula is `saldo_inicial + total_ingresos - total_egresos` (line 107) and counting the
 *     float twice would make a drawer opened with $500 read $1000.
 *   - Every movement carries the drawer's running balance, and the chain is contiguous.
 *   - One open register per business — the application check for the message, the partial unique
 *     index `ux_cajas_abierta` for the guarantee.
 *   - The till is closed by whoever opened it, with the balance its OWN movements produce.
 *   - A cash COUNT is not allowed to overwrite that balance: the gap between the count and the
 *     movements is a cash event, so it is written as a `caja_cierre` movement AND posted to
 *     `5.4.02` / `4.2.02` — which is what makes `1.1.01 Caja` equal the money in the drawer.
 *   - A NEGATIVE balance cannot be closed: the schema's `saldo_final_centavos >= 0` CHECK and the
 *     schema's own note that a negative register is "a real state a shop can reach" contradict
 *     each other (header section 7 of `001_init.sql`), so `cerrar` reports the number and refuses
 *     — the migration that reconciles the two belongs to the schema owner. See `DIVERGENCES.md`.
 */

const stores = []
afterEach(() => {
  while (stores.length > 0) stores.pop().cerrar()
})

function tumbar({ conCaja = true } = {}) {
  const t = tienda()
  stores.push(t)
  const ctx = ctxDe(t, t.negocioId, t.usuarioId)
  const caja = conCaja ? abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId }) : null
  return { t, ctx, caja }
}

function movimientosDe(t, cajaId) {
  return t.conn.db
    .prepare('SELECT * FROM movimientos_caja WHERE caja_id = ? ORDER BY id ASC')
    .all(cajaId)
}

/** One account's balance, straight from the database: `debe - haber` in centavos. */
function saldoCuenta(t, codigo) {
  return t.conn.db
    .prepare(
      `SELECT COALESCE(SUM(d.debe_centavos), 0) - COALESCE(SUM(d.haber_centavos), 0) AS n
         FROM detalles_asientos d JOIN cuentas_contables c ON c.id = d.cuenta_contable_id
        WHERE c.codigo = ? AND c.negocio_id = ?`
    )
    .get(codigo, t.negocioId).n
}

describe('abrir — opening the drawer', () => {
  it('opens with the float recorded but NOT counted as income', () => {
    const { t, ctx, caja } = tumbar()

    expect(caja.estado).toBe('abierta')
    expect(caja.saldo_inicial_centavos).toBe(50000) // the fixture thinks in centavos
    // THE parity fact: the float is in its own movement, not in the totals.
    expect(caja.total_ingresos_centavos).toBe(0)
    expect(caja.total_egresos_centavos).toBe(0)
    expect(saldoCaja(caja)).toBe(50000)

    const movs = movimientosDe(t, caja.id)
    expect(movs).toHaveLength(1)
    expect(movs[0].tipo).toBe('ingreso')
    expect(movs[0].concepto).toBe('APERTURA DE CAJA')
    expect(movs[0].monto_centavos).toBe(50000)
    expect(movs[0].saldo_anterior_centavos).toBe(0)
    expect(movs[0].saldo_nuevo_centavos).toBe(50000)
    expect(movs[0].origen).toBe('caja_apertura')
    expect(movs[0].referencia).toBe(`caja:${caja.id}`)
  })

  it('the drawer and the books say the SAME number the moment the till opens', () => {
    const { t, ctx, caja } = tumbar()

    // THE invariant, and the reason the float is journaled at all: the number a cashier counts in
    // the drawer and the `Caja` balance an accountant reads are one number, available in two
    // places so they can check each other. While the float was unposted they differed by exactly
    // the float, and no test said so.
    expect(saldoCuenta(t, CUENTA.CAJA)).toBe(saldoCaja(caja))
    expect(saldoCuenta(t, CUENTA.CAJA)).toBe(50000)
    expect(saldoCuenta(t, CUENTA.CAPITAL)).toBe(-50000)
  })

  it('the float is journalled as an owner contribution, inside the opening transaction', () => {
    const { t, caja } = tumbar()

    const lineas = t.conn.db
      .prepare(
        `SELECT c.codigo, c.tipo, d.debe_centavos, d.haber_centavos
           FROM detalles_asientos d
           JOIN cuentas_contables c ON c.id = d.cuenta_contable_id
           JOIN asientos_contables a ON a.id = d.asiento_contable_id
          WHERE a.referencia = ?`
      )
      .all(`caja:${caja.id}`)

    // Cash in, capital out. Not revenue: the shop has sold nothing yet.
    expect(lineas).toHaveLength(2)
    const cajaLine = lineas.find((l) => l.codigo === CUENTA.CAJA)
    const capitalLine = lineas.find((l) => l.codigo === CUENTA.CAPITAL)
    expect([cajaLine.debe_centavos, cajaLine.haber_centavos]).toEqual([50000, 0])
    expect([capitalLine.debe_centavos, capitalLine.haber_centavos]).toEqual([0, 50000])
    expect(capitalLine.tipo).toBe('capital')

    // Balanced, read back from the database rather than from the arrays the code built.
    const asientoId = t.conn.db
      .prepare('SELECT id FROM asientos_contables WHERE referencia = ?')
      .get(`caja:${caja.id}`).id
    expect(balanceAsiento(t.conn.db, asientoId)).toMatchObject({ debe: 50000, haber: 50000, balanceado: true })
    expect(
      t.conn.db.prepare('SELECT tipo FROM asientos_contables WHERE id = ?').get(asientoId).tipo
    ).toBe('apertura')
  })

  it('a failed opening leaves NEITHER the till NOR a journal entry behind', () => {
    const t = tienda()
    stores.push(t)
    const ctx = ctxDe(t, t.negocioId, t.usuarioId)

    // A float in the drawer with its entry rolled back is worse than the gap this replaced: the
    // drawer total would look right, the books would not explain it, and nothing would show the
    // difference until someone reconciled. So the two must be atomic — proven by breaking one.
    const reventado = {
      ...ctx,
      db: new Proxy(ctx.db, {
        get(alvo, prop) {
          if (prop === 'prepare') {
            return (sql) => {
              const st = ctx.db.prepare(sql)
              if (!/INSERT INTO asientos_contables/.test(sql)) return st
              return new Proxy(st, {
                get(s, p) {
                  if (p === 'run') {
                    return () => {
                      throw new Error('FALLO INYECTADO: el asiento no se pudo escribir')
                    }
                  }
                  return typeof s[p] === 'function' ? s[p].bind(s) : s[p]
                }
              })
            }
          }
          return typeof alvo[prop] === 'function' ? alvo[prop].bind(alvo) : alvo[prop]
        }
      })
    }

    expect(() => abrir(reventado, { saldoInicial: '500' })).toThrow(/FALLO INYECTADO/)
    expect(t.conn.db.prepare("SELECT COUNT(*) AS n FROM cajas WHERE negocio_id = ?").get(t.negocioId).n).toBe(0)
    expect(t.conn.db.prepare("SELECT COUNT(*) AS n FROM movimientos_caja WHERE negocio_id = ?").get(t.negocioId).n).toBe(0)
    expect(t.conn.db.prepare("SELECT COUNT(*) AS n FROM asientos_contables WHERE negocio_id = ?").get(t.negocioId).n).toBe(0)
  })

  it('opens with no float and writes no movement — there was no cash event', () => {
    const { t } = tumbar({ conCaja: false })
    const caja = abrirCaja(t, {
      negocioId: t.negocioId,
      usuarioId: t.usuarioId,
      saldoInicialCentavos: 0
    })

    expect(caja.saldo_inicial_centavos).toBe(0)
    // The web writes a zero movement here (`monto: saldoInicial || 0`) and the schema REFUSES
    // `monto_centavos < 1`; the desktop records nothing, which is the same truth in fewer rows.
    expect(movimientosDe(t, caja.id)).toHaveLength(0)
    expect(caja.total_ingresos_centavos).toBe(0)
    // And a zero float posts no journal entry either — no cash event, no entry. A shop that opens
    // an empty till must not be forced to grow a chart of accounts in order to say nothing.
    expect(saldoCuenta(t, CUENTA.CAJA)).toBe(0)
    expect(
      t.conn.db
        .prepare('SELECT COUNT(*) AS n FROM asientos_contables WHERE referencia = ?')
        .get(`caja:${caja.id}`).n
    ).toBe(0)
    // The till is still open and still usable: opening with nothing in it is legal.
    expect(caja.estado).toBe('abierta')
  })

  it('refuses a second open till with an actionable message', () => {
    const { t } = tumbar()

    let err = null
    try {
      abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId })
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe('CAJA_ABIERTA')
    expect(err?.status).toBe(400)
    expect(err?.message).toContain('Ya existe una caja abierta')
  })

  it('the open-register invariant is a schema backstop, not just a friendly check', () => {
    const { t } = tumbar()

    // A writer that never read the app's check loses on the partial unique index — the database
    // owns the invariant even against a second process that skipped the SELECT.
    let err = null
    try {
      t.conn.db
        .prepare(
          `INSERT INTO cajas
             (fecha_apertura, saldo_inicial_centavos, total_ingresos_centavos, total_egresos_centavos,
              estado, user_id, usuario_apertura, negocio_id, created_at, updated_at)
           VALUES (datetime('now'), 0, 0, 0, 'abierta', ?, ?, ?, datetime('now'), datetime('now'))`
        )
        .run(t.usuarioId, t.usuarioId, t.negocioId)
    } catch (e) {
      err = e
    }
    // the code shape has changed across better-sqlite3 versions, and SQLite names the offending
    // COLUMN (never the index) in constraint messages — `cajas.negocio_id` is unique exactly once,
    // in exactly `ux_cajas_abierta`, so it is the identifier that proves WHICH invariant fired
    expect(['SQLITE_CONSTRAINT_UNIQUE', 'ERR_SQLITE_ERROR']).toContain(err?.code)
    expect(String(err?.message)).toContain('cajas.negocio_id')
  })

  it('refuses a negative float', () => {
    const { t, ctx } = tumbar({ conCaja: false })
    let err = null
    try {
      abrir(ctx, { saldoInicial: -1000 })
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe('CAJA_SALDO_INICIAL_NEGATIVO')
  })
})

describe('cerrar — closing the drawer', () => {
  it('closes onto the balance its own movements produced', () => {
    const { t, ctx, caja } = tumbar()
    // a $100 sale: 0 -> 50000 -> 60000
    const producto = insertarProducto(t, { negocioId: t.negocioId, usuarioId: t.usuarioId })
    crear(ctx, {
      items: [{ productoId: producto.id, cantidad: '0.5' }],
      metodoPago: 'efectivo',
      montoRecibido: 200
    })

    const cerrada = cerrar(ctx, caja.id, { observaciones: 'Cierre del día' })

    expect(cerrada.estado).toBe('cerrada')
    expect(cerrada.saldo_final_centavos).toBe(60000) // the web's formula, not a typed number
    expect(cerrada.fecha_cierre).toBeTruthy()
    expect(cerrada.usuario_cierre).toBe(t.usuarioId)
    expect(cerrada.observaciones).toBe('Cierre del día')
    // closing is NOT a movement (web parity: `cerrarCaja` only updates the row)
    expect(movimientosDe(t, caja.id)).toHaveLength(2) // APERTURA + ingreso venta
  })

  it('refuses to close a till that belongs to a different operator', () => {
    const { t, ctx, caja } = tumbar()

    let err = null
    try {
      cerrar({ ...ctx, actorId: t.usuarioId + 999 }, caja.id)
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe('CAJA_NO_SUYA')
    expect(err?.status).toBe(403)
  })

  it('refuses to close a till twice', () => {
    const { t, ctx, caja } = tumbar()
    cerrar(ctx, caja.id)

    let err = null
    try {
      cerrar(ctx, caja.id)
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe('CAJA_YA_CERRADA')
  })

  it('refuses to close a negative register, and says what to do instead', () => {
    const { t, ctx, caja } = tumbar()

    // Draw 60 000 centavos more than the drawer holds: a real state (header section 7 of
    // 001_init.sql says so), reproduced through the same movement path the app uses.
    registrarMovimiento(ctx, {
      caja,
      tipo: 'egreso',
      concepto: 'Compra de bolsas para el local',
      montoCentavos: 60000,
      origen: 'manual'
    })
    // the truth lives in the DRAWER row, not in the snapshot the movement call received
    const enRojo = t.conn.db.prepare('SELECT * FROM cajas WHERE id = ?').get(caja.id)
    expect(saldoCaja(enRojo)).toBe(-10000)

    let err = null
    try {
      cerrar(ctx, caja.id)
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe('CAJA_SALDO_NEGATIVO')
    expect(err?.status).toBe(409)
    expect(err?.message).toContain('cajaMovimientos.create')

    // the till is still open and still in the red — the refusal did not corrupt it
    const viva = t.conn.db.prepare('SELECT * FROM cajas WHERE id = ?').get(caja.id)
    expect(viva.estado).toBe('abierta')
    expect(saldoCaja(viva)).toBe(-10000)
  })
})

/**
 * The cash count (arqueo): the number a person counts in the drawer, and what happens when it does
 * not match what the movements say.
 *
 * The claim every test here defends is a single sentence: after a close, `1.1.01 Caja` in the
 * ledger equals the money physically in the drawer. A till that closes onto a typed figure without
 * a movement behind it breaks that sentence — the drawer and the books stop being the same money,
 * and every report built on the books becomes quietly wrong.
 */
describe('cerrar con conteo — counting the cash, and what the difference does', () => {
  /**
   * A shop with a 500,00 float, a 100,00 cash sale and a 20,00 expense: the movements say
   * 50000 + 10000 - 2000 = 58000. Returns the pieces so each test can count something different.
   */
  function diaConVentasYGasto() {
    const { t, ctx, caja } = tumbar()
    const producto = insertarProducto(t, { negocioId: t.negocioId, usuarioId: t.usuarioId })
    crear(ctx, {
      items: [{ productoId: producto.id, cantidad: '0.5' }],
      metodoPago: 'efectivo',
      montoRecibido: 200
    })
    registrarMovimiento(ctx, {
      caja,
      tipo: 'egreso',
      concepto: 'Bolsas para el local',
      montoCentavos: 2000,
      origen: 'manual'
    })
    return { t, ctx, caja, esperado: 58000 }
  }

  it('a count that MATCHES closes with no difference and writes no extra movement', () => {
    const { t, ctx, caja, esperado } = diaConVentasYGasto()
    const antes = movimientosDe(t, caja.id).length

    const cerrada = cerrar(ctx, caja.id, { conteo: '580.00' })

    expect(cerrada.saldo_final_centavos).toBe(esperado)
    expect(cerrada.monto_contado_centavos).toBe(esperado)
    expect(cerrada.diferencia_centavos).toBe(0)
    // A drawer that matches has had no cash event, so no row and no entry: `registrarMovimiento`
    // refuses `monto_centavos < 1` and an empty entry would be a lie in the other direction.
    expect(movimientosDe(t, caja.id)).toHaveLength(antes)
    expect(saldoCuenta(t, '1.1.01')).toBe(esperado)
  })

  it('a SHORT count books the missing cash as a faltante, and the ledger ends at the real amount', () => {
    const { t, ctx, caja, esperado } = diaConVentasYGasto()

    const cerrada = cerrar(ctx, caja.id, { conteo: '575.00' })

    // the count is what the till finally held
    expect(cerrada.saldo_final_centavos).toBe(57500)
    expect(cerrada.monto_contado_centavos).toBe(57500)
    // and the difference is stored SIGNED, negative meaning short
    expect(cerrada.diferencia_centavos).toBe(-500)

    // the difference is a MOVEMENT, so the drawer has a readable history
    const movs = movimientosDe(t, caja.id)
    const arqueo = movs.find((m) => m.origen === 'caja_cierre')
    expect(arqueo.tipo).toBe('egreso')
    expect(arqueo.monto_centavos).toBe(500)
    // ...and its running balance lands exactly on the counted cash
    expect(arqueo.saldo_nuevo_centavos).toBe(57500)

    // THE HEADLINE: the ledger's cash account is the money in the drawer.
    expect(saldoCuenta(t, '1.1.01')).toBe(57500)
    // the loss is its own line in the income statement, not dissolved into `5.4.01`
    expect(saldoCuenta(t, '5.4.02')).toBe(500)
    expect(saldoCuenta(t, '5.4.01')).toBe(2000) // the manual expense, untouched
  })

  it('an OVER count books the extra cash as a sobrante, and the ledger ends at the real amount', () => {
    const { t, ctx, caja } = diaConVentasYGasto()

    const cerrada = cerrar(ctx, caja.id, { conteo: '585.00' })

    expect(cerrada.saldo_final_centavos).toBe(58500)
    expect(cerrada.diferencia_centavos).toBe(500)

    const arqueo = movimientosDe(t, caja.id).find((m) => m.origen === 'caja_cierre')
    expect(arqueo.tipo).toBe('ingreso')
    expect(arqueo.monto_centavos).toBe(500)
    expect(arqueo.saldo_nuevo_centavos).toBe(58500)

    expect(saldoCuenta(t, '1.1.01')).toBe(58500)
    // `saldoCuenta` is debe-minus-haber, and an income account carries a CREDIT, so the
    // sobrante shows up negative here. Reading it as a negative expense would be the bug.
    expect(saldoCuenta(t, '4.2.02')).toBe(-500)
  })

  it('the difference entry is double entry: the whole ledger still balances', () => {
    const { t, ctx, caja } = diaConVentasYGasto()
    const antesDePrueba = t.conn.db
      .prepare(
        `SELECT COALESCE(SUM(d.debe_centavos), 0) - COALESCE(SUM(d.haber_centavos), 0) AS n
           FROM detalles_asientos d WHERE d.negocio_id = ?`
      )
      .get(t.negocioId).n
    expect(antesDePrueba).toBe(0)

    cerrar(ctx, caja.id, { conteo: '575.00' })

    // A debit and a credit of equal size are the only thing that makes double entry double entry,
    // so this is asserted over EVERY account rather than only the two the test cares about.
    const despues = t.conn.db
      .prepare(
        `SELECT COALESCE(SUM(d.debe_centavos), 0) - COALESCE(SUM(d.haber_centavos), 0) AS n
           FROM detalles_asientos d WHERE d.negocio_id = ?`
      )
      .get(t.negocioId).n
    expect(despues).toBe(0)

    // ...and the entry is named `ingreso`/`egreso`, not `cierre`: `asientos_contables.tipo` is
    // CHECK-constrained and `cierre` is not one of the four words it allows.
    const entry = t.conn.db
      .prepare("SELECT * FROM asientos_contables WHERE referencia LIKE 'caja-movimiento:%' ORDER BY id DESC LIMIT 1")
      .get()
    expect(entry.tipo).toBe('egreso')
    expect(entry.monto_total_centavos).toBe(500)
  })

  it('NO count is not a count of zero: the till closes on its movements and both columns stay NULL', () => {
    const { t, ctx, caja, esperado } = diaConVentasYGasto()

    const cerrada = cerrar(ctx, caja.id)

    expect(cerrada.saldo_final_centavos).toBe(esperado)
    expect(cerrada.monto_contado_centavos).toBeNull()
    expect(cerrada.diferencia_centavos).toBeNull()
    expect(movimientosDe(t, caja.id).some((m) => m.origen === 'caja_cierre')).toBe(false)
    expect(saldoCuenta(t, '1.1.01')).toBe(esperado)
  })

  it('a count of ZERO is a real count, and books the whole drawer as a faltante', () => {
    // The `?? 0` / `|| 0` trap, stated as a test: a drawer counted at zero is empty, and an
    // operator who counted nothing is not the same operator who found nothing.
    const { t, ctx, caja } = tumbar()

    const cerrada = cerrar(ctx, caja.id, { conteo: 0 })

    expect(cerrada.monto_contado_centavos).toBe(0)
    expect(cerrada.diferencia_centavos).toBe(-50000)
    expect(cerrada.saldo_final_centavos).toBe(0)
    expect(saldoCuenta(t, '1.1.01')).toBe(0)
    expect(saldoCuenta(t, '5.4.02')).toBe(50000)
  })

  it('refuses a negative count with an actionable code instead of a bare CHECK failure', () => {
    const { t, ctx, caja } = tumbar()

    let err = null
    try {
      cerrar(ctx, caja.id, { conteo: '-50.00' })
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe('CAJA_CONTEO_NEGATIVO')
    expect(err?.status).toBe(400)

    // the refusal left the till open and untouched
    const viva = t.conn.db.prepare('SELECT * FROM cajas WHERE id = ?').get(caja.id)
    expect(viva.estado).toBe('abierta')
    expect(viva.monto_contado_centavos).toBeNull()
  })

  it('attributes the close to the SESSION operator, and a different one still cannot close it', () => {
    const { t, ctx, caja } = diaConVentasYGasto()

    // a renderer-supplied user id is not a thing `cerrar` accepts at all — the only actor is
    // `ctx.actorId`, which the session builds. So the id in the row is the session's.
    const cerrada = cerrar(ctx, caja.id, { conteo: '575.00' })
    expect(cerrada.usuario_cierre).toBe(ctx.actorId)
    expect(cerrada.usuario_cierre).toBe(t.usuarioId)

    const arqueo = movimientosDe(t, caja.id).find((m) => m.origen === 'caja_cierre')
    expect(arqueo.user_id).toBe(ctx.actorId)

    const entrada = t.conn.db
      .prepare("SELECT * FROM asientos_contables WHERE referencia LIKE 'caja-movimiento:%' ORDER BY id DESC LIMIT 1")
      .get()
    expect(entrada.user_id).toBe(ctx.actorId)
  })

  it('a close after 21:00 local is stamped with the true instant and reads back as the right day', () => {
    // 2026-10-04 21:47 in Argentina (UTC-3) is 2026-10-05 00:47 UTC. This is the hour where
    // SQLite's `date('now')` returns TOMORROW, which is how a till closed at night ends up filed
    // under the next day. `cerrar` must write the real instant and let the reports' own offset
    // conversion find the day.
    const instante = Date.parse('2026-10-04T21:47:00.000-03:00')

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(instante)
    try {
      const { ctx, caja } = tumbar()
      const cerrada = cerrar(ctx, caja.id, { conteo: '490.00' })

      // the instant is exact — nothing rounded it to a day or truncated an offset
      expect(Date.parse(cerrada.fecha_cierre)).toBe(instante)
      // and the calendar day an operator means is the 4th, not the 5th. -180 is Argentina's
      // fixed offset, passed explicitly so the assertion does not depend on the host's timezone.
      expect(hoyLocal(new Date(cerrada.fecha_cierre), -180)).toBe('2026-10-04')
    } finally {
      vi.useRealTimers()
    }
  })

  it('grows the two difference accounts add-only, and rewrites no existing one', () => {
    const { t, ctx, caja } = tumbar()
    cerrar(ctx, caja.id, { conteo: '450.00' })

    const codigos = t.conn.db
      .prepare('SELECT codigo, tipo FROM cuentas_contables WHERE negocio_id = ? ORDER BY codigo')
      .all(t.negocioId)
      .map((c) => `${c.codigo}:${c.tipo}`)

    expect(codigos).toContain('5.4.02:gasto')
    expect(codigos).toContain('4.2.02:ingreso')
    // the accounts that were already there kept their code AND their type
    expect(codigos).toContain('1.1.01:activo')
    expect(codigos).toContain('5.4.01:gasto')
    expect(codigos).toContain('4.2.01:ingreso')
  })
})

describe('registrarMovimiento — every movement carries the running balance', () => {
  it('skips a zero movement instead of writing a row the schema would refuse', () => {
    const { t, ctx, caja } = tumbar()
    const r = registrarMovimiento(ctx, {
      caja,
      tipo: 'ingreso',
      concepto: 'Nada pasó',
      montoCentavos: 0,
      origen: 'manual'
    })
    expect(r).toBeNull()
    expect(movimientosDe(t, caja.id)).toHaveLength(1) // just the APERTURA
  })

  it('chains the balance through ingreso and egreso without ever losing a centavo', () => {
    const { t, ctx, caja } = tumbar()
    registrarMovimiento(ctx, {
      caja,
      tipo: 'ingreso',
      concepto: 'Venta de prueba',
      montoCentavos: 12345,
      origen: 'manual'
    })
    registrarMovimiento(ctx, {
      caja,
      tipo: 'egreso',
      concepto: 'Pago de flete',
      montoCentavos: 345,
      origen: 'manual'
    })

    const movs = movimientosDe(t, caja.id)
    expect(movs.map((m) => [m.tipo, m.saldo_anterior_centavos, m.saldo_nuevo_centavos])).toEqual([
      ['ingreso', 0, 50000],       // APERTURA
      ['ingreso', 50000, 62345],   // +12345
      ['egreso', 62345, 62000]     // -345
    ])
    expect(movs[2].origen).toBe('manual')
    expect(movs[2].venta_id).toBeNull()
  })
})

/**
 * A whole day, in one test, because the properties above are only meaningful in sequence: a till
 * that counts correctly in isolation is not a till that counts correctly after a credit sale and a
 * debtor payment have passed through it.
 */
describe('un día completo — float, ventas, un pago, un gasto, conteo y apertura del día siguiente', () => {
  it('reconciles a full day and lets the next one start', () => {
    const { t, ctx, caja } = tumbar()
    // 9 kg: the day below sells 3,5 kg (0,5 + 1,5 + 1,5) and the fixture's 3 kg default is not
    // enough. A stock error here would be a real refusal, not a flaky test.
    const producto = insertarProducto(t, {
      negocioId: t.negocioId,
      usuarioId: t.usuarioId,
      overrides: { nombre: 'Queso artesanal', precio_centavos: 20000, precio_compra_centavos: 12000, stock_milli: 9000 }
    })
    const deudor = insertarDeudor(t, { negocioId: t.negocioId, usuarioId: t.usuarioId })

    // 1. cash
    crear(ctx, {
      items: [{ productoId: producto.id, cantidad: '0.5' }],
      metodoPago: 'efectivo',
      montoRecibido: 200
    })
    // 2. weighed, out of the same pesable product
    crear(ctx, {
      items: [{ productoId: producto.id, cantidad: '1.5' }],
      metodoPago: 'efectivo',
      montoRecibido: 600
    })
    // 3. credit — the shelf price is 200,00/kg, so this books 30.000 of REVENUE and NOTHING in the
    //    drawer. A till test that only ever sells cash would never notice a credit sale wrongly
    //    counted as cash, which is the mistake this line exists to catch.
    crear(ctx, {
      items: [{ productoId: producto.id, cantidad: '1.5' }],
      metodoPago: 'credito',
      clienteDeudorId: Number(deudor.id)
    })
    // 4. the debtor pays that same 300,00 in cash, which DOES enter the drawer
    registrarPago(ctx, deudor.id, { monto: '300.00', metodoPago: 'efectivo' })
    // 5. the owner's expense
    registrarMovimiento(ctx, {
      caja,
      tipo: 'egreso',
      concepto: 'Bolsa de hielo',
      montoCentavos: 3000,
      origen: 'manual'
    })

    // float 50.000 + cash 10.000 (0,5 kg) + weighed 30.000 (1,5 kg) + payment 30.000 − gasto 3.000
    const esperado = 50000 + 10000 + 30000 + 30000 - 3000
    expect(saldoCaja(t.conn.db.prepare('SELECT * FROM cajas WHERE id = ?').get(caja.id))).toBe(esperado)

    // the count matches, so the close writes no difference at all
    const cerrada = cerrar(ctx, caja.id, { conteo: '1170.00' })
    expect(cerrada.diferencia_centavos).toBe(0)
    expect(cerrada.saldo_final_centavos).toBe(esperado)

    // the drawer and the books agree at the end of the day
    expect(saldoCuenta(t, '1.1.01')).toBe(esperado)
    // and the credit sale WAS revenue, even though it never touched the drawer: 10.000 + 30.000 + 30.000.
    // NEGATIVE, because `saldoCuenta` is `debe − haber`: an asset reads positive and an income reads
    // negative. That sign is not a typo to be "fixed" — it is what lets a trial balance sum to zero.
    expect(saldoCuenta(t, '4.1.01')).toBe(-70000)
    // nothing went to a count-difference account, because there was no difference
    expect(saldoCuenta(t, '5.4.02')).toBe(0)
    expect(saldoCuenta(t, '4.2.02')).toBe(0)

    // ---- the next day -----------------------------------------------------------------------
    // Opening after a close is the half of the feature that has to work, because a till the shop
    // cannot reopen is a shop that cannot trade tomorrow. This is the `ux_cajas_abierta` invariant
    // being RELEASED, not tightened.
    // `abrir` runs its `saldoInicial` through `toCents`, so a bare number is PESOS — 100,00 here.
// (The fixture helper `abrirCaja` takes centavos directly, which is the trap.)
    const manana = abrir(ctx, { saldoInicial: '100.00' })
    expect(manana.estado).toBe('abierta')
    expect(cajaActiva(t.conn.db, t.negocioId).id).toBe(manana.id)
    expect(manana.id).not.toBe(caja.id)

    // and the shop's cash is yesterday's closing drawer plus today's float — kept as TWO figures, so
    // a report can say what yesterday left and what today started with instead of one number that
    // silently absorbed both
    const g = saldoGeneral(t.conn.db, t.negocioId)
    expect(g.saldoCerradas).toBe(esperado)
    expect(g.cajasCerradas).toBe(1)
    expect(g.saldoAbierta).toBe(10000)
    expect(g.tieneCajaAbierta).toBe(true)
  })
})

describe('obtener, listar, saldoGeneral, desglose — reading the till', () => {
  it('obtener returns the live balance and its movements; listar is newest first with a filter', () => {
    const { t, ctx, caja } = tumbar()

    const v = obtener(t.conn.db, t.negocioId, caja.id)
    expect(v.saldoActualCentavos).toBe(50000)
    expect(v.movimientos).toHaveLength(1)

    const lista = listar(t.conn.db, t.negocioId)
    expect(lista.total).toBe(1)
    expect(lista.filas[0].id).toBe(caja.id)
    expect(lista.filas[0].saldoActualCentavos).toBe(50000)

    const cerradas = listar(t.conn.db, t.negocioId, { estado: 'cerrada' })
    expect(cerradas.total).toBe(0)
  })

  it('saldoGeneral adds the closed tills’ final figures to the open one’s live balance', () => {
    const { t, ctx, caja } = tumbar()
    const producto = insertarProducto(t, { negocioId: t.negocioId, usuarioId: t.usuarioId })
    crear(ctx, {
      items: [{ productoId: producto.id, cantidad: '0.5' }],
      metodoPago: 'efectivo',
      montoRecibido: 200
    })
    const primera = cerrar(ctx, caja.id) // final: 60000

    const segunda = abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, saldoInicialCentavos: 20000 })

    const g = saldoGeneral(t.conn.db, t.negocioId)
    expect(g.saldoCerradas).toBe(60000)
    expect(g.cajasCerradas).toBe(1)
    expect(g.saldoAbierta).toBe(20000)
    expect(g.tieneCajaAbierta).toBe(true)
    expect(g.cajaAbiertaId).toBe(segunda.id)
    expect(g.saldoGeneral).toBe(80000)
    expect(primera.saldo_final_centavos).toBe(60000)
  })

  it('desglose counts the day’s sales by method, including same-day credit sales', () => {
    const { t, ctx, caja } = tumbar()
    const producto = insertarProducto(t, { negocioId: t.negocioId, usuarioId: t.usuarioId })
    const deudorId = t.conn.db
      .prepare(
        `INSERT INTO clientes_deudores (nombre, user_id, negocio_id, created_at, updated_at)
         VALUES ('María González', ?, ?, datetime('now'), datetime('now'))`
      )
      .run(t.usuarioId, t.negocioId).lastInsertRowid

    crear(ctx, {
      items: [{ productoId: producto.id, cantidad: '0.5' }],
      metodoPago: 'efectivo',
      montoRecibido: 200
    })
    crear(ctx, {
      items: [{ productoId: producto.id, cantidad: '0.5' }],
      metodoPago: 'tarjeta'
    })
    crear(ctx, {
      items: [{ productoId: producto.id, cantidad: '1.5' }],
      metodoPago: 'credito',
      clienteDeudorId: Number(deudorId)
    })

    const d = desglose(t.conn.db, t.negocioId, caja.id)
    expect(d.desglose.efectivo).toBe(10000)
    expect(d.desglose.tarjeta).toBe(10000)
    expect(d.desglose.credito).toBe(30000)
    expect(d.cantidades.efectivo).toBe(1)
    expect(d.cantidades.credito).toBe(1)
    expect(d.totalVentas).toBe(50000)
  })
})