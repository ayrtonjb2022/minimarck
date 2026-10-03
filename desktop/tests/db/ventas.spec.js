import { describe, it, expect, afterEach } from 'vitest'
import { crear, cancelar, obtener, listar } from '../../src/main/db/repositories/ventas.repo.js'
import { cerrar, saldoCaja } from '../../src/main/db/repositories/cajas.repo.js'
import { balanceAsiento, balanceGeneral, CUENTA } from '../../src/main/db/repositories/cuentas.repo.js'
import { tienda, ctxDe, insertarProducto, abrirCaja, insertarDeudor, partidasDe, partidasDeOperacion } from './fixtures/tienda.js'

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

/**
 * The sale repository, on a REAL migrated and seeded database.
 *
 * What these tests prove, and what they refuse to fake:
 *
 *   - ATOMICITY with a real failure injected mid-transaction (a trigger that aborts the audit
 *     row, the LAST write of the sale). A mock proves that a mock throws; this proves that the
 *     header, the lines, the stock decrement, the till movement, the plan of accounts and the
 *     journal entries all disappear together.
 *   - DOUBLE-ENTRY IDENTITY asked of the DATABASE (`balanceAsiento` is a SUM over the rows),
 *     for a sale, a credit sale, and a cancellation that nets the ledger to zero.
 *   - A HALF-KILO sale: 500 milli of a $2.000/kg product is exactly 10000 centavos, and the
 *     stock that left the shelf is exactly 500 milli, not 0 or 1.
 *   - The stock guard lives in the `WHERE` clause; a sale that would take stock negative
 *     writes NOTHING, including the first line that would have matched.
 *   - Idempotency: one key, one sale, one stock decrement.
 *
 * The fixture copies one template database per test (see `fixtures/tienda.js`): every test here
 * starts from the same migrated and seeded shop, and SQLite is never mocked.
 *
 * MONEY INPUTS are pesos, exactly what the POS sends (`200` = $200 = 20000 centavos); the
 * repositories convert with `toCents`. Assertions on the response are centavos.
 */

const stores = []
afterEach(() => {
  while (stores.length > 0) stores.pop().cerrar()
})

/** A real shop with one product (Queso, $2.000/kg, costo $1.200/kg, 21% IVA, 3 kg stock). */
function escenario({ conCaja = true, stockMilli = 3000 } = {}) {
  const t = tienda()
  stores.push(t)
  const ctx = ctxDe(t, t.negocioId, t.usuarioId)
  const producto = insertarProducto(t, {
    negocioId: t.negocioId,
    usuarioId: t.usuarioId,
    overrides: { stock_milli: stockMilli }
  })
  const caja = conCaja ? abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId }) : null
  return { t, ctx, producto, caja }
}

function contar(t, tabla, negocioId) {
  return t.conn.db.prepare(`SELECT COUNT(*) AS n FROM ${tabla} WHERE negocio_id = ?`).get(negocioId).n
}

/** `ventas_detalles` has no tenant column; the tenant is the sale's. */
function contarDetalles(t, negocioId) {
  return t.conn.db
    .prepare(
      `SELECT COUNT(*) AS n FROM ventas_detalles d JOIN ventas v ON v.id = d.venta_id WHERE v.negocio_id = ?`
    )
    .get(negocioId).n
}

function movimientoDe(t, cajaId, tipo) {
  return t.conn.db
    .prepare(
      `SELECT * FROM movimientos_caja WHERE caja_id = ? AND tipo = ? ORDER BY id DESC LIMIT 1`
    )
    .get(cajaId, tipo)
}

describe('crear — the sale', () => {
  it('sells half a kilo exactly, and writes the drawer, the ledger and the trail', () => {
    const { t, ctx, producto, caja } = escenario()

    const r = crear(ctx, {
      items: [{ productoId: producto.id, cantidad: '0.5' }],
      metodoPago: 'efectivo',
      montoRecibido: 200
    })

    // ---- the header -------------------------------------------------------
    expect(r.duplicado).toBe(false)
    expect(r.venta.folio).toMatch(/^V-[0-9a-f-]{36}$/)
    expect(r.venta.estado).toBe('completada')
    expect(r.venta.metodoPago).toBe('efectivo')
    // total === subtotal: IVA is EXTRACTED, never added (MATH-6)
    expect(r.venta.subtotalCentavos).toBe(10000)
    expect(r.venta.totalCentavos).toBe(10000)
    // 10000 * 21 / 121 = 1735.54 -> half-away-from-zero rounds to 1736
    expect(r.venta.ivaCentavos).toBe(1736)
    expect(r.venta.montoRecibidoCentavos).toBe(20000)
    expect(r.venta.montoCambioCentavos).toBe(10000)
    expect(r.venta.cajaId).toBe(caja.id)
    expect(r.venta.detalles).toHaveLength(1)
    expect(r.venta.detalles[0].cantidadMilli).toBe(500)
    expect(r.venta.detalles[0].precioUnitarioCentavos).toBe(20000)
    expect(r.venta.detalles[0].subtotalCentavos).toBe(10000)

    // ---- the stock, atomically ---------------------------------------------
    const despues = t.conn.db.prepare('SELECT stock_milli FROM productos WHERE id = ?').get(producto.id)
    expect(despues.stock_milli).toBe(2500) // 3000 - 500, exactly half a kilo

    // ---- the drawer ---------------------------------------------------------
    const cajaDespues = t.conn.db.prepare('SELECT * FROM cajas WHERE id = ?').get(caja.id)
    // The float is NOT in total_ingresos (see `abrir`): the totals only carry cash events.
    expect(cajaDespues.total_ingresos_centavos).toBe(10000)
    expect(cajaDespues.total_egresos_centavos).toBe(0)
    const mov = movimientoDe(t, caja.id, 'ingreso')
    expect(mov.concepto).toBe(`Venta ${r.venta.folio}`)
    expect(mov.monto_centavos).toBe(10000)
    expect(mov.origen).toBe('venta')
    expect(mov.venta_id).toBe(r.venta.id)
    // The running chain: APERTURA 0 -> 50000, this sale 50000 -> 60000.
    expect(mov.saldo_anterior_centavos).toBe(50000)
    expect(mov.saldo_nuevo_centavos).toBe(60000)
    // The APERTURA plus this sale. Counted before, because the point is "this sale added exactly
    // one movement", and a hardcoded total breaks every time a legitimate movement type appears.
    expect(contar(t, 'movimientos_caja', t.negocioId)).toBe(2)

    // ---- the ledger ---------------------------------------------------------
    // Scoped to THIS SALE's entries. The till opening posts its own `Caja`/`Capital` entry, so the
    // shop's ledger is no longer only about the sale — and `1.1.01` now carries a line from both
    // operations, which an unscoped `Object.fromEntries` map would have collapsed to one.
    const asientos = t.conn.db
      .prepare(
        `SELECT * FROM asientos_contables WHERE negocio_id = ? AND referencia = ? ORDER BY id`
      )
      .all(t.negocioId, `venta:${r.venta.id}`)
    // TWO entries — revenue (12a) and cost (12b) — each independently balanced.
    expect(asientos).toHaveLength(2)
    for (const a of asientos) {
      const b = balanceAsiento(t.conn.db, a.id)
      expect(b.balanceado).toBe(true)
      expect(b.debe).toBe(b.haber)
    }
    const partidas = partidasDeOperacion(t, t.negocioId, `venta:${r.venta.id}`)
    const porCuenta = Object.fromEntries(partidas.map((p) => [p.codigo, p]))
    expect(partidas).toHaveLength(4)
    // revenue entry: the drawer receives the money, Ventas earns it
    expect(porCuenta['1.1.01'].debe).toBe(10000)
    expect(porCuenta['1.1.01'].haber).toBe(0)
    expect(porCuenta['4.1.01'].debe).toBe(0)
    expect(porCuenta['4.1.01'].haber).toBe(10000)
    // cost entry: CMV consumed 500 g at the recorded cost, mercaderías gave it up
    expect(porCuenta['5.1.01'].debe).toBe(6000) // 12000 * 500 / 1000, exact
    expect(porCuenta['5.1.01'].haber).toBe(0)
    expect(porCuenta['1.2.01'].debe).toBe(0)
    expect(porCuenta['1.2.01'].haber).toBe(6000)

    // ---- THE BOOKS BALANCE --------------------------------------------------
    // The whole point of journalling the opening float: the cash the shop holds on the books is the
    // cash in the drawer, to the centavo, with a sale in between. `50000` float + `10000` sale.
    expect(saldoCuenta(t, CUENTA.CAJA)).toBe(60000)
    expect(saldoCuenta(t, CUENTA.CAJA)).toBe(saldoCaja(cajaDespues))

    // ---- the trail ----------------------------------------------------------
    const audit = t.conn.db
      .prepare(
        `SELECT * FROM auditoria WHERE negocio_id = ? AND accion = 'CREATE' AND tabla = 'ventas'`
      )
      .get(t.negocioId)
    expect(audit).toBeTruthy()
    expect(audit.registro_id).toBe(r.venta.id)
    expect(JSON.parse(audit.valores_nuevos).folio).toBe(r.venta.folio)
  })

  it('sells 1 kg and 3 g as exactly one thousand three milli', () => {
    const { t, ctx, producto } = escenario()

    const r = crear(ctx, {
      items: [
        { productoId: producto.id, cantidad: '1' },
        { productoId: producto.id, cantidad: '0.003' }
      ],
      metodoPago: 'efectivo',
      montoRecibido: 300 // $300 >= $200.60
    })

    // 20000 * (1000 + 3) / 1000 = 20060 centavos — the scale never saw a float.
    expect(r.venta.totalCentavos).toBe(20060)
    expect(r.venta.detalles.map((d) => d.cantidadMilli)).toEqual([1000, 3])
    const despues = t.conn.db.prepare('SELECT stock_milli FROM productos WHERE id = ?').get(producto.id)
    expect(despues.stock_milli).toBe(3000 - 1003)
  })

  it('REFUSES a cash sale with no open till, in words, and writes nothing at all', () => {
    // This test used to assert the opposite, and the comment said "same as the web". It was
    // faithful and it was wrong: the sale was written, the stock came off the shelf, the journal
    // was posted, `caja_id` was left NULL and no `movimientos_caja` row existed. The goods were
    // gone and the cash was in nobody's drawer, with no error anywhere to say so. Matching the
    // web is the right instinct; copying a defect because the original had it is not, and a till
    // is the one place where "close enough" costs real money.
    const { t, ctx, producto } = escenario({ conCaja: false })

    let err = null
    try {
      crear(ctx, {
        items: [{ productoId: producto.id, cantidad: '1' }],
        metodoPago: 'efectivo',
        montoRecibido: 200
      })
    } catch (e) {
      err = e
    }

    // A refusal a human can act on, and no leaked constraint name.
    expect(err?.code).toBe('CAJA_ABIERTA_REQUERIDA')
    expect(err?.status).toBe(409)
    expect(err?.message).toMatch(/caja/i)
    expect(String(err?.message ?? '')).not.toMatch(/SQLITE/)

    // And the half that matters: the transaction rolled back. No sale, no stock gone, no
    // journal, no drawer row. Not "corrected later" — none of it happened.
    expect(contar(t, 'ventas', t.negocioId)).toBe(0)
    expect(contar(t, 'movimientos_caja', t.negocioId)).toBe(0)
    expect(contar(t, 'asientos_contables', t.negocioId)).toBe(0)
    const stock = t.conn.db.prepare('SELECT stock_milli FROM productos WHERE id = ?').get(producto.id)
    expect(stock.stock_milli).toBe(3000)
  })

  it('still allows a CREDIT sale with no open till, because credit moves no cash', () => {
    // The guard is scoped to the methods that touch the drawer. A credit sale posts a receivable
    // and no money, so refusing it for want of a cash drawer would block the one sale a shop can
    // still make after the register is closed for the night.
    const { t, ctx, producto } = escenario({ conCaja: false })
    const deudor = insertarDeudor(t, { negocioId: t.negocioId, usuarioId: t.usuarioId })

    const r = crear(ctx, {
      items: [{ productoId: producto.id, cantidad: '1' }],
      metodoPago: 'credito',
      clienteDeudorId: deudor.id
    })

    expect(r.venta.cajaId).toBeNull()
    expect(contar(t, 'movimientos_caja', t.negocioId)).toBe(0)
    expect(r.venta.totalCentavos).toBe(20000)
    expect(contar(t, 'ventas', t.negocioId)).toBe(1)
  })

  it('refuses to oversell, and the refusal writes NOTHING', () => {
    const { t, ctx, producto, caja } = escenario({ stockMilli: 3000 })

    const antes = t.conn.db.prepare('SELECT stock_milli FROM productos WHERE id = ?').get(producto.id)
    // Counted BEFORE the refusal, because "the refusal wrote nothing" is a claim about a DELTA.
    // The scenario opened a till, and the opening float is journalised, so the ledger already held
    // the float's own entry before the sale was even attempted. Asserting an absolute zero here
    // would assert that the till was never opened, which is a different statement.
    const asientosAntes = contar(t, 'asientos_contables', t.negocioId)
    const partidasAntes = contar(t, 'detalles_asientos', t.negocioId)
    const movsAntes = contar(t, 'movimientos_caja', t.negocioId)
    expect(asientosAntes).toBe(1) // the float's Caja/Capital entry, and nothing else

    let err = null
    try {
      crear(ctx, { items: [{ productoId: producto.id, cantidad: '3.5' }], metodoPago: 'efectivo' })
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe('STOCK_INSUFICIENTE')
    expect(err?.status).toBe(400)

    // the whole sale rolled back: no header, no lines, no drawer, no ledger, no trail
    expect(contar(t, 'ventas', t.negocioId)).toBe(0)
    expect(contarDetalles(t, t.negocioId)).toBe(0)
    expect(contar(t, 'movimientos_caja', t.negocioId)).toBe(movsAntes)
    expect(contar(t, 'asientos_contables', t.negocioId)).toBe(asientosAntes)
    expect(contar(t, 'detalles_asientos', t.negocioId)).toBe(partidasAntes)
    expect(contar(t, 'auditoria', t.negocioId)).toBe(0)
    const despues = t.conn.db.prepare('SELECT stock_milli, updated_at FROM productos WHERE id = ?').get(producto.id)
    expect(despues.stock_milli).toBe(antes.stock_milli)

    // ---- the two-line case, the one that proves the FIRST decrement rolled back ----
    // Two lines of 2 kg each against 3 kg: the first line decrements, the second fails, and the
    // first decrement must be gone. A sale that only half-writes is the exact defect this file
    // exists to make impossible.
    let err2 = null
    try {
      crear(ctx, {
        items: [
          { productoId: producto.id, cantidad: '2' },
          { productoId: producto.id, cantidad: '2' }
        ],
        metodoPago: 'efectivo'
      })
    } catch (e) {
      err2 = e
    }
    expect(err2?.code).toBe('STOCK_INSUFICIENTE')
    const final = t.conn.db.prepare('SELECT stock_milli FROM productos WHERE id = ?').get(producto.id)
    expect(final.stock_milli).toBe(3000)
    expect(contar(t, 'ventas', t.negocioId)).toBe(0)
  })

  it('rolls back EVERYTHING when a failure fires after the stock and the ledger were written', () => {
    const { t, ctx, producto, caja } = escenario()

    // Baselines taken BEFORE the sale. This scenario opens a till, and opening a till now posts the
    // float's own journal entry, so the shop's ledger is NOT empty when the sale starts. The
    // rollback's claim is that the SALE left nothing behind, which is a delta — so the deltas are
    // what get asserted. The one absolute that survives is `cuentas_contables`: the sale inserts the
    // plan itself, and here the plan is pre-existing because the till needed it, so the assertion
    // is that the sale did not add a SINGLE account on top.
    const movsAntes = contar(t, 'movimientos_caja', t.negocioId)
    const cuentasAntes = contar(t, 'cuentas_contables', t.negocioId)
    const asientosAntes = contar(t, 'asientos_contables', t.negocioId)
    const partidasAntes = contar(t, 'detalles_asientos', t.negocioId)
    expect(cuentasAntes).toBeGreaterThan(0) // the till opening grew the plan already

    // The injection: the last write of the sale transaction is the audit row, so a trigger that
    // aborts on it fires AFTER the header, the lines, the stock decrement, the till movement,
    // the plan of accounts and both journal entries are already written. RAISE(ROLLBACK) unwinds
    // the whole explicit transaction from inside SQLite — no mocks, no test-only branches.
    t.conn.db.exec(`
      CREATE TRIGGER inyectar_falla_auditoria AFTER INSERT ON auditoria
      WHEN NEW.tabla = 'ventas' AND NEW.accion = 'CREATE'
      BEGIN
        SELECT RAISE(ROLLBACK, 'INYECTADO: el registro de auditoría falla');
      END
    `)

    let err = null
    try {
      crear(ctx, { items: [{ productoId: producto.id, cantidad: '0.5' }], metodoPago: 'efectivo' })
    } catch (e) {
      err = e
    }
    expect(String(err?.message)).toContain('INYECTADO')

    // NOTHING of the sale survived. In particular: the stock already decremented and the movement
    // already recorded are both gone.
    expect(contar(t, 'ventas', t.negocioId)).toBe(0)
    expect(contarDetalles(t, t.negocioId)).toBe(0)
    expect(contar(t, 'movimientos_caja', t.negocioId)).toBe(movsAntes) // APERTURA only
    expect(contar(t, 'cuentas_contables', t.negocioId)).toBe(cuentasAntes)
    expect(contar(t, 'asientos_contables', t.negocioId)).toBe(asientosAntes)
    expect(contar(t, 'detalles_asientos', t.negocioId)).toBe(partidasAntes)
    expect(contar(t, 'auditoria', t.negocioId)).toBe(0)
    const despues = t.conn.db.prepare('SELECT stock_milli FROM productos WHERE id = ?').get(producto.id)
    expect(despues.stock_milli).toBe(3000)
    const cajaDespues = t.conn.db.prepare('SELECT total_ingresos_centavos FROM cajas WHERE id = ?').get(caja.id)
    expect(cajaDespues.total_ingresos_centavos).toBe(0)
    // And the books still agree with the drawer after the rollback: float in, float out, nothing
    // half-written on either side.
    expect(saldoCuenta(t, CUENTA.CAJA)).toBe(50000)
    expect(saldoCuenta(t, CUENTA.CAJA)).toBe(caja.saldo_inicial_centavos)
  })

  it('sells once per idempotency key, however many times it is retried', () => {
    const { t, ctx, producto } = escenario()

    const movsAntes = contar(t, 'movimientos_caja', t.negocioId)
    const asientosAntes = contar(t, 'asientos_contables', t.negocioId)
    const partidasAntes = contar(t, 'detalles_asientos', t.negocioId)

    const cuerpo = {
      items: [{ productoId: producto.id, cantidad: '0.5' }],
      metodoPago: 'efectivo',
      idempotencyKey: 'clave-venta-1'
    }

    const primera = crear(ctx, cuerpo)
    expect(primera.duplicado).toBe(false)

    // A retry after a network failure must not sell twice. The second call is answered by the
    // pre-transaction SELECT, the fast path the real renderer takes on every retry.
    const segunda = crear(ctx, cuerpo)
    expect(segunda.duplicado).toBe(true)
    expect(segunda.venta.id).toBe(primera.venta.id)

    // Exactly ONE of everything, counted from the pre-sale baseline. The baseline is not zero: the
    // scenario opened a till and the float is journalled, so "the retry wrote nothing" is a delta
    // and only a delta.
    expect(contar(t, 'ventas', t.negocioId)).toBe(1)
    expect(contarDetalles(t, t.negocioId)).toBe(1)
    expect(contar(t, 'movimientos_caja', t.negocioId)).toBe(movsAntes + 1) // exactly one ingreso
    expect(contar(t, 'asientos_contables', t.negocioId)).toBe(asientosAntes + 2) // revenue + cost
    expect(contar(t, 'detalles_asientos', t.negocioId)).toBe(partidasAntes + 4)
    expect(contar(t, 'auditoria', t.negocioId)).toBe(1)
    const stock = t.conn.db.prepare('SELECT stock_milli FROM productos WHERE id = ?').get(producto.id)
    expect(stock.stock_milli).toBe(2500) // decremented exactly once
  })

  it('refuses what the web refuses, with the web’s words', () => {
    const { t, ctx, producto } = escenario()

    const dispara = (cuerpo) => {
      try {
        crear(ctx, cuerpo)
        return null
      } catch (e) {
        return e
      }
    }

    const base = { items: [{ productoId: producto.id, cantidad: '1' }] }

    const mixto = dispara({ ...base, metodoPago: 'mixto' })
    expect(mixto?.code).toBe('VENTA_MIXTO_NO_SOPORTADO')
    expect(mixto?.message).toBe('Método mixto requiere desglose efectivo/crédito, aún no soportado')

    const descuento = dispara({ ...base, descuento: 500 })
    expect(descuento?.code).toBe('VENTA_DESCUENTO_NO_SOPORTADO')
    expect(descuento?.message).toBe('Descuento aún no soportado')

    // ...but a blank discount is an absent discount, and the sale goes through.
    const conBlanco = dispara({ ...base, descuento: '', montoRecibido: 200 })
    expect(conBlanco).toBeNull()

    const metodo = dispara({ ...base, metodoPago: 'cheque' })
    expect(metodo?.code).toBe('VENTA_METODO_INVALIDO')

    const sinItems = dispara({ ...base, items: [] })
    expect(sinItems?.code).toBe('VENTA_SIN_ITEMS')

    const corto = dispara({ ...base, montoRecibido: 50 }) // $50 < $200
    expect(corto?.code).toBe('VENTA_MONTO_INSUFICIENTE')

    const creditoSinDeudor = dispara({ ...base, metodoPago: 'credito' })
    expect(creditoSinDeudor?.code).toBe('VENTA_CREDITO_SIN_DEUDOR')

    // zero is below one milli — a thousandth is the atomic quantity — and a fourth decimal is a
    // unit mistake no scale can make.
    const cero = dispara({ items: [{ productoId: producto.id, cantidad: '0' }] })
    expect(cero?.code).toBe('VENTA_CANTIDAD_INVALIDA')
    const cuartaDecimal = dispara({ items: [{ productoId: producto.id, cantidad: '0.0001' }] })
    expect(cuartaDecimal?.code).toBe('VENTA_CANTIDAD_INVALIDA')
    expect(cuartaDecimal?.message).toContain('Cantidad inválida')
  })

  it('posts a credit sale to the receivable, with no drawer event and no balance written', () => {
    const { t, ctx, producto } = escenario({ conCaja: false })
    const deudor = insertarDeudor(t, { negocioId: t.negocioId, usuarioId: t.usuarioId })

    const r = crear(ctx, {
      items: [{ productoId: producto.id, cantidad: '1.5' }],
      metodoPago: 'credito',
      clienteDeudorId: deudor.id
    })

    expect(r.venta.totalCentavos).toBe(30000)
    expect(r.venta.cajaId).toBeNull()
    expect(r.venta.montoRecibidoCentavos).toBeNull()
    expect(r.venta.montoCambioCentavos).toBeNull()
    expect(r.advertenciaLimite).toBeUndefined() // 30000 < límite 100000
    expect(contar(t, 'movimientos_caja', t.negocioId)).toBe(0) // no cash left the drawer

    // the receivable is real and it is the 1.3.01 debit, not a cached balance column
    const partidas = partidasDe(t, t.negocioId)
    const porCuenta = Object.fromEntries(partidas.map((p) => [p.codigo, p]))
    expect(partidas).toHaveLength(4)
    expect(porCuenta['1.3.01'].debe).toBe(30000)
    expect(porCuenta['4.1.01'].haber).toBe(30000)
    expect(porCuenta['5.1.01'].debe).toBe(18000) // 12000 * 1.5
    expect(porCuenta['1.2.01'].haber).toBe(18000)

    const notas = t.conn.db
      .prepare('SELECT notas FROM clientes_deudores WHERE id = ?')
      .get(deudor.id)
    expect(notas.notas).toContain(`Venta ${r.venta.folio}`)
    expect(notas.notas).toContain('1500 x Queso artesanal = 30000 centavos')
  })

  it('warns when a credit sale crosses the debtor’s limit, without refusing it', () => {
    const { t, ctx, producto } = escenario({ conCaja: false })
    const deudor = insertarDeudor(t, {
      negocioId: t.negocioId,
      usuarioId: t.usuarioId,
      limiteCreditoCentavos: 20000
    })

    const r = crear(ctx, {
      items: [{ productoId: producto.id, cantidad: '1.5' }],
      metodoPago: 'credito',
      clienteDeudorId: deudor.id
    })

    expect(r.venta.totalCentavos).toBe(30000) // sold
    expect(r.advertenciaLimite).toContain('supera el límite de crédito')
  })

  /**
   * THE WARNING HAS TO SEE WHAT THE DEBTOR ALREADY OWES, and this is the test for the arithmetic
   * that decides it.
   *
   * A debtor on a $100.000 limit already $90.000 deep buys $15.000. The resulting debt is
   * $105.000 and the limit is crossed, so the cashier must be told. The old check compared
   * `total > limite` on its own — $15.000 < $100.000 — and said nothing, which is a warning that
   * is wrong in the only direction that costs money.
   *
   * It is also the test for the DOUBLE COUNT that the naive fix introduces. The check runs after
   * `INSERT INTO ventas`, and the view it reads sums the credit sales, so the row just inserted is
   * ALREADY in the number it returns. Adding `total` to that figure counts the ticket twice: the
   * same customer buying the same $15.000 would be warned about $120.000 of debt instead of
   * $105.000, and a cashier who sees that number stops trusting the warning entirely.
   *
   * The message carries both figures so the operator can check the arithmetic themselves, and both
   * are asserted here because a message that reports the wrong "deuda actual" is as useless as no
   * message.
   */
  it('warns from the RESULTING debt, and counts the new ticket exactly once', () => {
    // 10 kg on the shelf for four sales of 1,5 kg. The stock guard is real and it would have
    // stopped the fourth sale with "Stock insuficiente" — a refusal about the shelf, arriving in
    // the middle of a test about credit limits, which is how a warning test gets misread as a
    // ledger failure.
    const { t, ctx, producto } = escenario({ conCaja: false, stockMilli: 10000 })
    // $1.000 limit on a product that sells at $200/kg in 1,5 kg lines: $300 a ticket, so three
    // tickets land at $900 — under the limit — and the fourth crosses it.
    const deudor = insertarDeudor(t, {
      negocioId: t.negocioId,
      usuarioId: t.usuarioId,
      limiteCreditoCentavos: 100000
    })

    // $300 of credit three times over: $900 owed, $100 under the limit.
    for (let i = 0; i < 3; i += 1) {
      const r = crear(ctx, {
        items: [{ productoId: producto.id, cantidad: '1.5' }],
        metodoPago: 'credito',
        clienteDeudorId: deudor.id
      })
      // None of these crosses the limit on its own, which is the whole point.
      expect(r.advertenciaLimite).toBeUndefined()
    }
    expect(
      t.conn.db.prepare('SELECT deuda_pendiente_centavos AS n FROM v_clientes_deudores WHERE id = ?').get(deudor.id).n
    ).toBe(90000)

    // And the fourth one crosses it: 900 + 300 = 1200 > 1000.
    const r = crear(ctx, {
      items: [{ productoId: producto.id, cantidad: '1.5' }],
      metodoPago: 'credito',
      clienteDeudorId: deudor.id
    })

    expect(r.venta.totalCentavos).toBe(30000)
    expect(r.advertenciaLimite).toContain('supera el límite de crédito')
    // $900 before, $1.200 after. NOT $1.500, which is what `pendiente + total` would print.
    expect(r.advertenciaLimite).toContain('Deuda actual: 90000')
    expect(r.advertenciaLimite).toContain('con esta venta: 120000')
    // The sale is recorded either way: the limit warns, it does not refuse.
    expect(r.venta.estado).toBe('completada')
    expect(
      t.conn.db.prepare('SELECT deuda_pendiente_centavos AS n FROM v_clientes_deudores WHERE id = ?').get(deudor.id).n
    ).toBe(120000)
  })

  it('a debtor with no limit is never warned about a limit', () => {
    const { t, ctx, producto } = escenario({ conCaja: false })
    const deudor = t.conn.db
      .prepare(
        `INSERT INTO clientes_deudores (nombre, limite_credito_centavos, user_id, negocio_id, activo, created_at, updated_at)
         VALUES ('Sin tope', NULL, ?, ?, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(t.usuarioId, t.negocioId)

    const r = crear(ctx, {
      items: [{ productoId: producto.id, cantidad: '1.5' }],
      metodoPago: 'credito',
      clienteDeudorId: Number(deudor.lastInsertRowid)
    })

    // "No limit" is a real setting, and a null read as zero would warn on the very first sale.
    expect(r.advertenciaLimite).toBeUndefined()
  })
})

describe('cancelar — putting a sale back', () => {
  it('returns the stock, mirrors the ledger to zero, and counts the reversal in the drawer', () => {
    const { t, ctx, producto, caja } = escenario()
    const r = crear(ctx, {
      items: [{ productoId: producto.id, cantidad: '0.5' }],
      metodoPago: 'efectivo',
      montoRecibido: 200
    })

    const res = cancelar(ctx, r.venta.id, { motivo: 'El cliente devolvió el queso' })

    // ---- the sale is a receipt, not a lie ------------------------------------
    expect(res.venta.estado).toBe('cancelada')
    expect(res.venta.observaciones).toContain('ANULADA: El cliente devolvió el queso')
    expect(res.movimientosStock).toEqual([{ productoId: producto.id, cantidadMilli: 500 }])
    const stock = t.conn.db.prepare('SELECT stock_milli FROM productos WHERE id = ?').get(producto.id)
    expect(stock.stock_milli).toBe(3000) // back to the shelf, exactly

    // ---- the drawer: a NEW egreso, and the totals still equal the movement sum --------
    const egreso = movimientoDe(t, caja.id, 'egreso')
    expect(egreso.concepto).toBe(`Anulación venta ${r.venta.folio}`)
    expect(egreso.monto_centavos).toBe(10000)
    expect(egreso.saldo_anterior_centavos).toBe(60000) // the chain goes ... -> 60000
    expect(egreso.saldo_nuevo_centavos).toBe(50000)    // -> 50000, back to the float
    const cajaDespues = t.conn.db.prepare('SELECT * FROM cajas WHERE id = ?').get(caja.id)
    expect(cajaDespues.total_ingresos_centavos).toBe(10000) // the sale still counts
    expect(cajaDespues.total_egresos_centavos).toBe(10000)  // the reversal is its own event
    expect(contar(t, 'movimientos_caja', t.negocioId)).toBe(3)

    // ---- the ledger nets to ZERO: every account, every entry -----------------------
    // Scoped to THIS SALE's entries. The whole-ledger version of this assertion used to be the
    // right one, and silently stopped being the right one the moment the till opening posted its
    // own entry: `Caja` and `Capital` now carry a balanced but NON-ZERO balance (the float is
    // still in the drawer), so "every account nets to zero" became false for reasons that have
    // nothing to do with the cancellation. The property being tested is that the sale and its
    // reversal cancel EACH OTHER, and that is a statement about the sale's entries alone.
    const asientos = t.conn.db
      .prepare(
        `SELECT id FROM asientos_contables
          WHERE negocio_id = ? AND referencia = ? ORDER BY id`
      )
      .all(t.negocioId, `venta:${r.venta.id}`)
    expect(asientos).toHaveLength(4) // Venta, CMV, Reversa ventas, Reversa CMV
    for (const a of asientos) {
      const b = balanceAsiento(t.conn.db, a.id)
      expect(b.balanceado).toBe(true)
    }
    for (const g of balanceGeneral(t.conn.db, t.negocioId, [`venta:${r.venta.id}`])) {
      expect(g.debe).toBe(g.haber) // per-account identity, sale + reversal only
    }

    // And the WHOLE ledger still balances, float included: the opening float is a balanced entry
    // of its own, so it adds nothing to the net either way.
    let neto = 0
    for (const g of balanceGeneral(t.conn.db, t.negocioId)) {
      neto += g.debe - g.haber
    }
    expect(neto).toBe(0)

    // The books and the drawer agree once more: the sale was taken and given back, so the till is
    // exactly the float it started with.
    expect(saldoCuenta(t, CUENTA.CAJA)).toBe(saldoCaja(cajaDespues))
    expect(saldoCuenta(t, CUENTA.CAJA)).toBe(caja.saldo_inicial_centavos)

    // ---- the trail ----------------------------------------------------------------
    const audit = t.conn.db
      .prepare(
        `SELECT * FROM auditoria WHERE negocio_id = ? AND accion = 'UPDATE' AND tabla = 'ventas'`
      )
      .get(t.negocioId)
    expect(audit).toBeTruthy()
    expect(JSON.parse(audit.valores_anteriores).estado).toBe('completada')
    expect(JSON.parse(audit.valores_nuevos).estado).toBe('cancelada')
  })

  it('refuses to cancel twice, so the stock is never returned twice', () => {
    const { t, ctx, producto } = escenario()
    const r = crear(ctx, {
      items: [{ productoId: producto.id, cantidad: '0.5' }],
      metodoPago: 'efectivo',
      montoRecibido: 200
    })

    cancelar(ctx, r.venta.id)
    let err = null
    try {
      cancelar(ctx, r.venta.id)
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe('VENTA_YA_CANCELADA')

    const stock = t.conn.db.prepare('SELECT stock_milli FROM productos WHERE id = ?').get(producto.id)
    expect(stock.stock_milli).toBe(3000) // not 3500
    expect(contar(t, 'movimientos_caja', t.negocioId)).toBe(3)
  })

  it('returns the stock but not the drawer event when the till was closed in between', () => {
    const { t, ctx, producto, caja } = escenario()
    const r = crear(ctx, {
      items: [{ productoId: producto.id, cantidad: '0.5' }],
      metodoPago: 'efectivo',
      montoRecibido: 200
    })
    cerrar(ctx, caja.id)

    const res = cancelar(ctx, r.venta.id)
    expect(res.movimientosStock).toEqual([{ productoId: producto.id, cantidadMilli: 500 }])

    // no drawer reversal: the movement would claim cash flowed out of a closed register
    expect(contar(t, 'movimientos_caja', t.negocioId)).toBe(2) // APERTURA + ingreso, nothing new
    const cajaDespues = t.conn.db.prepare('SELECT total_egresos_centavos FROM cajas WHERE id = ?').get(caja.id)
    expect(cajaDespues.total_egresos_centavos).toBe(0)
  })

  it('cancellation is as atomic as the sale: an injected failure rolls the whole reversal back', () => {
    const { t, ctx, producto, caja } = escenario()
    const r = crear(ctx, {
      items: [{ productoId: producto.id, cantidad: '0.5' }],
      metodoPago: 'efectivo',
      montoRecibido: 200
    })

    // After the SALE, before the cancellation: the exact state the reversal must leave untouched.
    // Not zero — the scenario opened a till and the float is journalled, so this is a delta.
    const movsTrasVenta = contar(t, 'movimientos_caja', t.negocioId)
    const asientosTrasVenta = contar(t, 'asientos_contables', t.negocioId)

    // The last write of `cancelar` is its audit row too — same trap, same proof.
    t.conn.db.exec(`
      CREATE TRIGGER inyectar_falla_anulacion AFTER INSERT ON auditoria
      WHEN NEW.tabla = 'ventas' AND NEW.accion = 'UPDATE'
      BEGIN
        SELECT RAISE(ROLLBACK, 'INYECTADO: el registro de anulación falla');
      END
    `)

    let err = null
    try {
      cancelar(ctx, r.venta.id)
    } catch (e) {
      err = e
    }
    expect(String(err?.message)).toContain('INYECTADO')

    // the reversal vanished whole: stock still short, the ledger still holds only the sale's own
    // entries, the sale still open. Counted from the post-sale state, which already includes the
    // till opening's journalled float.
    const stock = t.conn.db.prepare('SELECT stock_milli FROM productos WHERE id = ?').get(producto.id)
    expect(stock.stock_milli).toBe(2500)
    expect(contar(t, 'asientos_contables', t.negocioId)).toBe(asientosTrasVenta)
    expect(contar(t, 'movimientos_caja', t.negocioId)).toBe(movsTrasVenta)
    const venta = t.conn.db.prepare('SELECT estado FROM ventas WHERE id = ?').get(r.venta.id)
    expect(venta.estado).toBe('completada')
    // The books still agree with the drawer after the failed reversal — float plus the sale.
    expect(saldoCuenta(t, CUENTA.CAJA)).toBe(60000)
  })
})

describe('obtener y listar — reading sales back', () => {
  it('scopes every read to the business that owns the sale', () => {
    const { t, ctx, producto } = escenario()
    const r = crear(ctx, {
      items: [{ productoId: producto.id, cantidad: '1' }],
      metodoPago: 'efectivo',
      montoRecibido: 200
    })

    // a second tenant asking for the same id gets a 404, not the sale
    let err = null
    try {
      obtener(t.conn.db, t.negocioId + 999, r.venta.id)
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe('VENTA_NO_ENCONTRADA')
    expect(err?.status).toBe(404)

    const lista = listar(t.conn.db, t.negocioId + 999)
    expect(lista.total).toBe(0)
    expect(lista.filas).toHaveLength(0)

    const propia = obtener(t.conn.db, t.negocioId, r.venta.id)
    expect(propia.folio).toBe(r.venta.folio)
    expect(propia.detalles[0].cantidadMilli).toBe(1000)
  })
})