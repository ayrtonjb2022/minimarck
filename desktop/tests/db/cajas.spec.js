import { describe, it, expect, afterEach } from 'vitest'
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
import { tienda, ctxDe, abrirCaja, insertarProducto } from './fixtures/tienda.js'

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