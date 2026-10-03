import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tienda, ctxDe, insertarProducto, abrirCaja, partidasDeOperacion, saldosAsiento } from './fixtures/tienda.js'
import {
  listar,
  obtener,
  crear,
  actualizar,
  cancelar
} from '../../src/main/db/repositories/compras.repo.js'
import { crear as crearProveedor } from '../../src/main/db/repositories/proveedores.repo.js'
import { crear as crearVenta } from '../../src/main/db/repositories/ventas.repo.js'
import { saldoCaja, cerrar } from '../../src/main/db/repositories/cajas.repo.js'
import { CUENTA } from '../../src/main/db/repositories/cuentas.repo.js'

/**
 * Purchases, over a real shop database, with the ledger and the drawer read back out of it.
 *
 * These are the tests that earn the five claims in `compras.repo.js`'s header. Each headline gets
 * its own test that would fail if the claim were dropped:
 *
 *   1. stock and MOVING AVERAGE, weighted, and a sale's margin frozen at its own moment;
 *   2. cash leaves the drawer and equals `1.1.01` exactly;
 *   3. credit creates a payable in `2.1.01` and leaves the drawer untouched;
 *   4. card posts to `1.1.02` and leaves the drawer untouched;
 *   5. a purchase, a sale and a cancellation post a balanced sequence, and a bad request writes
 *      nothing at all.
 */
describe('compras — goods in, money out or owed', () => {
  let t
  let ctx
  let proveedor
  let queso

  beforeEach(() => {
    t = tienda()
    ctx = ctxDe(t, t.negocioId, t.usuarioId)
    proveedor = crearProveedor(ctx, { nombre: 'Distribuidora del Sur' })
    queso = insertarProducto(t, { negocioId: t.negocioId, usuarioId: t.usuarioId })
  })
  afterEach(() => t.cerrar())

  const linea = (over = {}) => ({
    productoId: queso.id,
    cantidad: '1',
    precioUnitario: '120.00',
    ...over
  })

  /**
   * The NATURAL balance of an account, signed by the account's own type.
   *
   * A debit raises an asset and lowers a liability, so a single sign convention cannot read both.
   * `1.1.01 Caja` is an `activo` and `2.1.01 Proveedores` is a `pasivo`: after a credit purchase the
   * drawer holds $500 and the shop owes $120, and "the balance of Proveedores" is +120, not -120.
   * A helper that reported every account debit-positive would show a payable as a negative number,
   * which is how an accounts-payable balance gets read as a shortfall.
   */
  const saldo = (codigo) =>
    t.conn.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN c.tipo IN ('pasivo', 'ingreso', 'capital')
                                  THEN d.haber_centavos - d.debe_centavos
                                  ELSE d.debe_centavos - d.haber_centavos END), 0) AS saldo
           FROM detalles_asientos d
           JOIN cuentas_contables c ON c.id = d.cuenta_contable_id
          WHERE c.codigo = ? AND d.negocio_id = ?`
      )
      .get(codigo, t.negocioId).saldo

  const stockDe = () => t.conn.db.prepare('SELECT * FROM productos WHERE id = ?').get(queso.id)
  const caja = () => t.conn.db.prepare("SELECT * FROM cajas WHERE negocio_id = ? AND estado = 'abierta'").get(t.negocioId)
  /** By id, so a test can read a till that was CLOSED — `caja()` only finds the open one. */
  const cajaPorId = (id) => t.conn.db.prepare('SELECT * FROM cajas WHERE id = ?').get(id)

  // ---------------------------------------------------------------- stock and the moving average

  it('adds stock, and folds the lot into a WEIGHTED average rather than the last price', () => {
    // The fixture's `Queso artesanal`: 3 kg on the shelf at a cost of $120.00.
    expect(stockDe().stock_milli).toBe(3000)
    expect(stockDe().precio_compra_centavos).toBe(12000)

    const compra = crear(ctx, { proveedorId: proveedor.id, metodoPago: 'tarjeta', items: [linea()] })

    expect(compra.totalCentavos).toBe(12000)
    expect(stockDe().stock_milli).toBe(4000)
    // (3 * 12000 + 1 * 12000) / 4 = 12000. Same price, so this proves nothing about weighting —
    // which is exactly why the next assertion buys at a DIFFERENT price.
    expect(stockDe().precio_compra_centavos).toBe(12000)
  })

  it('moves the average towards a new price, by the fraction that lot is of the pile', () => {
    crear(ctx, { proveedorId: proveedor.id, metodoPago: 'tarjeta', items: [linea({ precioUnitario: '150.00' })] })
    // (3 * 12000 + 1 * 15000) / 4 = 12750, and NOT 15000. The 3 kilos already on the shelf were
    // bought at $120.00 and that fact is not erased by a fourth kilo costing more.
    expect(stockDe().precio_compra_centavos).toBe(12750)
    expect(stockDe().precio_compra_centavos).not.toBe(15000)
  })

  it('buys a fractional quantity of a weighed product, which the web cannot do at all', () => {
    // `compras_detalles.cantidad_milli` is ×1000. The web's `CompraDetalle.cantidad` is an INTEGER,
    // so the web has no way to record 2,5 kg — this is the divergence, and it is a real one.
    const compra = crear(ctx, {
      proveedorId: proveedor.id,
      metodoPago: 'tarjeta',
      items: [linea({ cantidad: '2.5', precioUnitario: '100.00' })]
    })

    expect(compra.detalles[0].cantidadMilli).toBe(2500)
    // 2.5 kg at $100.00/kg is $250.00 exactly, from thousandths and centavos.
    expect(compra.totalCentavos).toBe(25000)
    expect(stockDe().stock_milli).toBe(5500)
    // (3 * 12000 + 2.5 * 10000) / 5.5 = 11090.909... -> 11091, half away from zero.
    expect(stockDe().precio_compra_centavos).toBe(11091)
  })

  it('buys SEVERAL products in one purchase, each with its own average', () => {
    const pan = insertarProducto(t, {
      negocioId: t.negocioId,
      usuarioId: t.usuarioId,
      // `overrides`, not top-level keys: the fixture's signature is
      // `{ negocioId, usuarioId, overrides }`, and passing `stock_milli` beside them is silently
      // ignored — which is how this test once "proved" a cost of 8571 on a product nobody stocked.
      overrides: { nombre: 'Pan de horno', precio_compra_centavos: 5000, stock_milli: 2000 }
    })
    expect(pan.stock_milli).toBe(2000)
    expect(pan.precio_compra_centavos).toBe(5000)

    const compra = crear(ctx, {
      proveedorId: proveedor.id,
      metodoPago: 'tarjeta',
      items: [linea({ cantidad: '2', precioUnitario: '150.00' }), linea({ productoId: pan.id, cantidad: '4', precioUnitario: '60.00' })]
    })

    expect(compra.detalles).toHaveLength(2)
    expect(compra.totalCentavos).toBe(30000 + 24000)
    // 2 * 15000 + 3 * 12000 = 66000 over 5 -> 13200.  4 * 6000 + 2 * 5000 = 34000 over 6 -> 5667.
    expect(stockDe().precio_compra_centavos).toBe(13200)
    expect(t.conn.db.prepare('SELECT * FROM productos WHERE id = ?').get(pan.id).precio_compra_centavos).toBe(5667)
  })

  it('leaves a past sale margin exactly as it was reported, when a later purchase raises the cost', () => {
    abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, saldoInicialCentavos: 50000 })
    // A REAL sale, through the real repository: the 3 kg at the $120.00 cost, sold at the product's
    // own $200.00 price. Its margin is $80.00/kg and its CMV is 3 * 12000 = 36000.
    const { venta } = crearVenta(ctx, {
      items: [{ productoId: queso.id, cantidad: '3' }],
      metodoPago: 'efectivo',
      montoRecibido: 700
    })
    const costoVendido = t.conn.db
      .prepare('SELECT costo_unitario_centavos FROM ventas_detalles WHERE venta_id = ?')
      .get(venta.id)
    expect(costoVendido.costo_unitario_centavos).toBe(12000)
    expect(partidasDeOperacion(t, t.negocioId, `venta:${venta.id}`).find((p) => p.codigo === CUENTA.CMV).debe).toBe(36000)

    // Now restock the same product at a much higher price. The sale emptied the shelf, so the
    // average is the new lot's price outright — the shelf no longer holds anything bought at 12000.
    crear(ctx, { proveedorId: proveedor.id, metodoPago: 'tarjeta', items: [linea({ cantidad: '5', precioUnitario: '200.00' })] })
    expect(stockDe().precio_compra_centavos).toBe(20000)

    // The historical sale is untouched: same cost line, same CMV. The purchase moved the FUTURE's
    // margin and left the past one exactly as it was reported, because the sale snapshotted the
    // cost it used. Without `ventas_detalles.costo_unitario_centavos` this purchase would have
    // rewritten the shop's already-reported profit.
    const despues = t.conn.db
      .prepare('SELECT costo_unitario_centavos FROM ventas_detalles WHERE venta_id = ?')
      .get(venta.id)
    expect(despues.costo_unitario_centavos).toBe(12000)
    expect(partidasDeOperacion(t, t.negocioId, `venta:${venta.id}`).find((p) => p.codigo === CUENTA.CMV).debe).toBe(36000)
  })

  // ------------------------------------------------------------------------- the three payments

  it('cash: leaves the drawer, and Caja equals the till to the centavo', () => {
    abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, saldoInicialCentavos: 50000 })
    const antes = caja()
    expect(saldoCaja(antes)).toBe(50000)

    const compra = crear(ctx, { proveedorId: proveedor.id, metodoPago: 'efectivo', items: [linea()] })

    expect(compra.estado).toBe('completada')
    expect(compra.metodoPago).toBe('efectivo')
    // The drawer moved by exactly the purchase, and the account agrees with the drawer.
    expect(saldoCaja(caja())).toBe(50000 - 12000)
    expect(saldo(CUENTA.CAJA)).toBe(50000 - 12000)
    expect(saldo(CUENTA.CAJA)).toBe(saldoCaja(caja()))
    // And the movement is traceable to the purchase, through the frozen schema's own vocabulary.
    const mov = t.conn.db
      .prepare("SELECT * FROM movimientos_caja WHERE origen = 'compra' AND referencia = ?")
      .get(`compra:${compra.id}`)
    expect(mov.tipo).toBe('egreso')
    expect(mov.monto_centavos).toBe(12000)
    expect(mov.saldo_anterior_centavos).toBe(50000)
    expect(mov.saldo_nuevo_centavos).toBe(38000)
  })

  it('cash without an open till is refused, and writes nothing', () => {
    // No `abrirCaja` in this test, deliberately.
    expect(() => crear(ctx, { proveedorId: proveedor.id, metodoPago: 'efectivo', items: [linea()] })).toThrow(/caja abierta/)
    expect(t.conn.db.prepare('SELECT COUNT(*) AS n FROM compras').get().n).toBe(0)
    expect(stockDe().stock_milli).toBe(3000)
  })

  it('credit: creates a payable in 2.1.01 and does NOT touch the drawer', () => {
    abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, saldoInicialCentavos: 50000 })

    const compra = crear(ctx, { proveedorId: proveedor.id, metodoPago: 'credito', items: [linea()] })

    // The goods arrived and the shop now OWES the supplier, which is a `pendiente` purchase: the
    // word finally means what it says. The web records every purchase as `completada` and has no
    // payable at all.
    expect(compra.estado).toBe('pendiente')
    expect(saldo(CUENTA.PROVEEDORES)).toBe(12000)
    expect(saldo(CUENTA.CAJA)).toBe(50000)
    expect(saldoCaja(caja())).toBe(50000)
    // No drawer movement at all, and none for credit in any purchase.
    expect(t.conn.db.prepare("SELECT COUNT(*) AS n FROM movimientos_caja WHERE origen = 'compra'").get().n).toBe(0)
    // And the payable is visible from the supplier's side, derived from the purchases.
    expect(obtener(ctx, compra.id).totalCentavos).toBe(12000)
  })

  it('card: posts to the bank and does NOT touch the drawer', () => {
    abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, saldoInicialCentavos: 50000 })

    const compra = crear(ctx, { proveedorId: proveedor.id, metodoPago: 'tarjeta', items: [linea()] })

    expect(compra.estado).toBe('completada')
    expect(saldo(CUENTA.BANCO)).toBe(-12000)
    expect(saldo(CUENTA.CAJA)).toBe(50000)
    expect(saldoCaja(caja())).toBe(50000)
    expect(saldo(CUENTA.PROVEEDORES)).toBe(0)
    expect(t.conn.db.prepare("SELECT COUNT(*) AS n FROM movimientos_caja WHERE origen = 'compra'").get().n).toBe(0)
  })

  it('credits the exact account each method names, and debits inventory every time', () => {
    abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, saldoInicialCentavos: 50000 })
    for (const [metodo, credito] of [
      ['efectivo', CUENTA.CAJA],
      ['tarjeta', CUENTA.BANCO],
      ['credito', CUENTA.PROVEEDORES]
    ]) {
      const c = crearProveedor(ctx, { nombre: `Prov ${metodo}` })
      const compra = crear(ctx, { proveedorId: c.id, metodoPago: metodo, items: [linea()] })
      const partidas = partidasDeOperacion(t, t.negocioId, `compra:${compra.id}`)

      expect(partidas).toHaveLength(2)
      const mercaderias = partidas.find((p) => p.codigo === CUENTA.MERCADERIAS)
      const contra = partidas.find((p) => p.codigo === credito)
      expect(mercaderias.debe).toBe(12000)
      expect(mercaderias.haber).toBe(0)
      expect(contra.haber).toBe(12000)
      expect(contra.debe).toBe(0)
      // THE invariant, from the database's own arithmetic.
      const saldos = saldosAsiento(t.conn, compra.asiento.id)
      expect(saldos.debe).toBe(saldos.haber)
    }
  })

  // ------------------------------------------------------------------------------ the refusals

  it('refuses a payment method this build does not model, rather than defaulting to cash', () => {
    abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, saldoInicialCentavos: 50000 })
    for (const metodo of ['transferencia', 'mixto', '', null, 'EFECTIVO ']) {
      if (metodo === 'EFECTIVO ') {
        // Case and whitespace are NORMALISED, so this one is accepted.
        expect(() => crear(ctx, { proveedorId: proveedor.id, metodoPago: metodo, items: [linea()] })).not.toThrow()
        continue
      }
      expect(() => crear(ctx, { proveedorId: proveedor.id, metodoPago: metodo, items: [linea()] })).toThrow()
    }
    expect(t.conn.db.prepare("SELECT COUNT(*) AS n FROM compras WHERE estado <> 'cancelada'").get().n).toBe(1)
  })

  it('writes NOTHING when a line is bad, because it all happens in one transaction', () => {
    const antes = { compras: 0, stock: stockDe().stock_milli, costo: stockDe().precio_compra_centavos }

    // The second line names a product that does not exist. The first line is perfectly valid and
    // has already been applied by the time this is noticed.
    expect(() =>
      crear(ctx, {
        proveedorId: proveedor.id,
        metodoPago: 'tarjeta',
        items: [linea(), linea({ productoId: 999999 })]
      })
    ).toThrow(/no existe/)

    const despues = stockDe()
    expect(t.conn.db.prepare('SELECT COUNT(*) AS n FROM compras').get().n).toBe(antes.compras)
    expect(despues.stock_milli).toBe(antes.stock)
    expect(despues.precio_compra_centavos).toBe(antes.costo)
    // And no journal entry survived the rollback.
    expect(t.conn.db.prepare('SELECT COUNT(*) AS n FROM asientos_contables').get().n).toBe(0)
    // Scoped to the PURCHASE, and it used not to need scoping: `proveedores.repo.js` started writing
    // its own `auditoria` row when a supplier is created, so a bare `COUNT(*)` sees 1 from the
    // `beforeEach`'s supplier and the rollback assertion silently stopped meaning anything. What
    // matters here is that the failed purchase left no trace of ITS OWN.
    expect(
      t.conn.db
        .prepare(`SELECT COUNT(*) AS n FROM auditoria WHERE tabla IN ('compras', 'compras_detalles')`)
        .get().n
    ).toBe(0)
  })

  it('refuses an empty purchase, a zero-quantity line and a zero-price line', () => {
    const base = { proveedorId: proveedor.id, metodoPago: 'tarjeta' }
    expect(() => crear(ctx, { ...base, items: [] })).toThrow(/al menos una línea/)
    expect(() => crear(ctx, { ...base, items: [linea({ cantidad: '0' })] })).toThrow()
    expect(() => crear(ctx, { ...base, items: [linea({ cantidad: '-2' })] })).toThrow()
    expect(() => crear(ctx, { ...base, items: [linea({ precioUnitario: '0' })] })).toThrow(/mayor a cero/)
    expect(t.conn.db.prepare('SELECT COUNT(*) AS n FROM compras').get().n).toBe(0)
  })

  it('refuses a purchase with no supplier, an unknown one, and an inactive one', () => {
    const base = { metodoPago: 'tarjeta', items: [linea()] }
    expect(() => crear(ctx, { ...base })).toThrow(/necesita un proveedor/)
    expect(() => crear(ctx, { ...base, proveedorId: 999999 })).toThrow(/no existe/)
    actualizarProveedorInactivo()
    expect(() => crear(ctx, { ...base, proveedorId: proveedor.id })).toThrow(/inactivo/)
  })

  const actualizarProveedorInactivo = () =>
    t.conn.db.prepare('UPDATE proveedores SET activo = 0 WHERE id = ?').run(proveedor.id)

  it('ignores a total the client tried to dictate', () => {
    const compra = crear(ctx, {
      proveedorId: proveedor.id,
      metodoPago: 'tarjeta',
      totalCentavos: 1,
      subtotalCentavos: 1,
      items: [linea()]
    })
    expect(compra.totalCentavos).toBe(12000)
    expect(partidasDeOperacion(t, t.negocioId, `compra:${compra.id}`).find((p) => p.codigo === CUENTA.MERCADERIAS).debe).toBe(12000)
  })

  // ------------------------------------------------------------------- edit, and what is frozen

  it('edits the folio and the notes, and refuses to re-cost a purchase that already landed', () => {
    const compra = crear(ctx, { proveedorId: proveedor.id, metodoPago: 'tarjeta', items: [linea()] })

    const editada = actualizar(ctx, compra.id, { folio: 'FAC-0001-234', observaciones: 'Traído en camioneta' })
    expect(editada.folio).toBe('FAC-0001-234')
    expect(editada.observaciones).toBe('Traído en camioneta')
    expect(editada.totalCentavos).toBe(12000)

    // The web runs `compra.update(req.body)`, which will rewrite `total_centavos` on a purchase
    // that already moved the stock, already left the drawer and already posted an entry.
    for (const prohibido of [{ totalCentavos: 1 }, { total: 1 }, { estado: 'completada' }, { items: [] }, { metodoPago: 'efectivo' }]) {
      expect(() => actualizar(ctx, compra.id, prohibido)).toThrow(/no se puede cambiar/)
    }
    expect(obtener(ctx, compra.id).totalCentavos).toBe(12000)
    expect(stockDe().stock_milli).toBe(4000)
  })

  // -------------------------------------------------------------------------------- cancelling

  it('cancels: stock, cost, entry and drawer all go back', () => {
    abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, saldoInicialCentavos: 50000 })
    const compra = crear(ctx, { proveedorId: proveedor.id, metodoPago: 'efectivo', items: [linea({ cantidad: '2', precioUnitario: '150.00' })] })
    expect(stockDe().stock_milli).toBe(5000)
    expect(saldoCaja(caja())).toBe(50000 - 30000)

    const cancelada = cancelar(ctx, compra.id)

    expect(cancelada.estado).toBe('cancelada')
    // The stock and the cost are back to the state the `auditoria` row recorded.
    expect(stockDe().stock_milli).toBe(3000)
    expect(stockDe().precio_compra_centavos).toBe(12000)
    // The money is back in the drawer, and Caja agrees with the till again.
    expect(saldoCaja(caja())).toBe(50000)
    expect(saldo(CUENTA.CAJA)).toBe(50000)
    // The original entry and its mirror BOTH balance on their own, and together they leave nothing
    // behind. Netting debe against haber across the pair is not the assertion — each entry balances
    // by itself, and what has to cancel out is each ACCOUNT's net position.
    const entradas = t.conn.db
      .prepare("SELECT id FROM asientos_contables WHERE referencia = ? ORDER BY id ASC")
      .all(`compra:${compra.id}`)
    expect(entradas).toHaveLength(2)
    for (const asiento of entradas) {
      const s = saldosAsiento(t.conn, asiento.id)
      expect(s.debe).toBe(s.haber)
      expect(s.debe).toBe(30000)
    }
    expect(saldo(CUENTA.MERCADERIAS)).toBe(0)
    expect(saldo(CUENTA.CAJA)).toBe(50000)
  })

  it('cancels a credit purchase without inventing a drawer movement for it', () => {
    abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, saldoInicialCentavos: 50000 })
    const compra = crear(ctx, { proveedorId: proveedor.id, metodoPago: 'credito', items: [linea()] })
    expect(saldo(CUENTA.PROVEEDORES)).toBe(12000)

    cancelar(ctx, compra.id)

    // The payable is gone, because the purchase that created it is gone.
    expect(saldo(CUENTA.PROVEEDORES)).toBe(0)
    // The drawer never moved and did not start moving on the way out.
    expect(saldoCaja(caja())).toBe(50000)
    expect(t.conn.db.prepare("SELECT COUNT(*) AS n FROM movimientos_caja WHERE origen = 'compra'").get().n).toBe(0)
    expect(stockDe().stock_milli).toBe(3000)
  })

  it('refuses to cancel a purchase a LATER purchase already folded a cost into', () => {
    const primera = crear(ctx, { proveedorId: proveedor.id, metodoPago: 'tarjeta', items: [linea({ precioUnitario: '150.00' })] })
    const segunda = crear(ctx, { proveedorId: proveedor.id, metodoPago: 'tarjeta', items: [linea({ precioUnitario: '300.00' })] })
    // The average now carries both lots; undoing the first one has no answer that is also true of
    // the second, so it is refused and the operator is told to work backwards.
    expect(() => cancelar(ctx, primera.id)).toThrow(/orden inverso/)
    expect(obtener(ctx, primera.id).estado).toBe('completada')

    // Cancelling the LAST one first works, and then the first becomes reversible — which is the
    // workflow the refusal message points at.
    cancelar(ctx, segunda.id)
    expect(stockDe().precio_compra_centavos).toBe(12750)
    expect(() => cancelar(ctx, primera.id)).not.toThrow()
    expect(stockDe().precio_compra_centavos).toBe(12000)
  })

  it('refuses to cancel a purchase whose recorded cost no longer matches the product', () => {
    const compra = crear(ctx, { proveedorId: proveedor.id, metodoPago: 'tarjeta', items: [linea()] })
    // Something moved the cost behind the repository's back.
    t.conn.db.prepare('UPDATE productos SET precio_compra_centavos = 99999 WHERE id = ?').run(queso.id)

    expect(() => cancelar(ctx, compra.id)).toThrow(/cambió desde esta compra/)
    expect(obtener(ctx, compra.id).estado).toBe('completada')
    expect(stockDe().precio_compra_centavos).toBe(99999)
  })

  it('refuses to cancel twice, and leaves a cancelled purchase uneditable', () => {
    const compra = crear(ctx, { proveedorId: proveedor.id, metodoPago: 'tarjeta', items: [linea()] })
    cancelar(ctx, compra.id)

    expect(() => cancelar(ctx, compra.id)).toThrow(/ya está cancelada/)
    expect(() => actualizar(ctx, compra.id, { folio: 'OTRA' })).toThrow(/cancelada/)
  })

  // ------------------------------------------------------------------------ listing and tenancy

  it('lists by folio and by supplier name, and filters by state', () => {
    // Each purchase buys a DIFFERENT product, so cancelling any one of them is reversible. Using
    // one product three times would make the middle purchase legitimately non-reversible — the
    // guard working, not a listing bug — and the test would be asserting the wrong thing.
    const tres = [1, 2, 3].map((n) =>
      insertarProducto(t, {
        negocioId: t.negocioId,
        usuarioId: t.usuarioId,
        overrides: { nombre: `Producto ${n}`, stock_milli: 1000, precio_compra_centavos: 1000 }
      })
    )
    const a = crear(ctx, { proveedorId: proveedor.id, metodoPago: 'credito', items: [linea({ productoId: tres[0].id })] })
    const b = crear(ctx, { proveedorId: proveedor.id, metodoPago: 'tarjeta', items: [linea({ productoId: tres[1].id })] })
    const otro = crearProveedor(ctx, { nombre: 'Frutos del Norte' })
    const c = crear(ctx, { proveedorId: otro.id, metodoPago: 'tarjeta', items: [linea({ productoId: tres[2].id })] })
    cancelar(ctx, b.id)

    expect(listar(ctx, {}).total).toBe(3)
    expect(listar(ctx, { estado: 'pendiente' }).total).toBe(1)
    expect(listar(ctx, { estado: 'cancelada' }).total).toBe(1)
    expect(listar(ctx, { search: a.folio.toLowerCase() }).total).toBe(1)
    expect(listar(ctx, { search: 'frutos' }).total).toBe(1)
    expect(listar(ctx, { search: 'distribuidora' }).total).toBe(2)
    expect(listar(ctx, { proveedorId: otro.id }).total).toBe(1)
    expect(() => listar(ctx, { estado: 'inventada' })).toThrow(/desconocido/)

    // The list reports the method it derived, and a cancelled purchase reports none.
    const filas = listar(ctx, {}).filas
    expect(filas.find((f) => f.id === a.id).metodoPago).toBe('credito')
    expect(filas.find((f) => f.id === c.id).metodoPago).toBe('tarjeta')
    expect(filas.find((f) => f.id === b.id).metodoPago).toBeNull()
  })

  it('scopes purchases to the business, so one shop cannot read or cancel another one', () => {
    const compra = crear(ctx, { proveedorId: proveedor.id, metodoPago: 'tarjeta', items: [linea()] })
    const otroNegocio = Number(
      t.conn.db
        .prepare(`INSERT INTO negocios (nombre, ruc, direccion, configuracion, activo)
                  VALUES ('Otra Tienda', '20999999999', 'Calle 1', '{}', 1)`)
        .run().lastInsertRowid
    )
    const ajeno = { ...ctx, negocioId: otroNegocio }

    expect(listar(ajeno, {}).total).toBe(0)
    expect(() => obtener(ajeno, compra.id)).toThrow(/no existe/)
    expect(() => cancelar(ajeno, compra.id)).toThrow(/no existe/)
    expect(() => actualizar(ajeno, compra.id, { folio: 'X' })).toThrow(/no existe/)
    expect(obtener(ctx, compra.id).estado).toBe('completada')
  })

  it('keeps a purchase with no unique folio from colliding, and accepts a folio the shop has', () => {
    // The web generates `CMP-${Date.now()}`, a timestamp: two purchases in the same millisecond
    // share a folio, and a folio is the number a supplier quotes on the phone.
    const primero = crear(ctx, { proveedorId: proveedor.id, metodoPago: 'tarjeta', items: [linea()] })
    const segundo = crear(ctx, { proveedorId: proveedor.id, metodoPago: 'tarjeta', items: [linea()] })
    expect(primero.folio).not.toBe(segundo.folio)

    const conFolio = crear(ctx, { proveedorId: proveedor.id, metodoPago: 'tarjeta', folio: 'FAC-9999', items: [linea()] })
    expect(conFolio.folio).toBe('FAC-9999')
    expect(listar(ctx, { search: 'fac-9999' }).total).toBe(1)
  })

  /**
   * A cash purchase cancelled after the till closes.
   *
   * This is the one that would have shipped a permanent hole. The earlier draft asked for the active
   * till and moved on when there was none, so the reversal entry posted, `1.1.01 Caja` was credited,
   * the purchase was marked `cancelada` — and the money was never handed back. The ledger said the
   * cash returned while the drawer said it did not, and from then on the till's own sum could not
   * reproduce `1.1.01`. Nothing in the UI would ever show it: both screens would agree the purchase
   * was cancelled.
   */
  it('refuses to cancel a cash purchase when the till is closed, instead of losing the money', () => {
    const abierta = abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, saldoInicialCentavos: 50000 })
    const compra = crear(ctx, { proveedorId: proveedor.id, metodoPago: 'efectivo', items: [linea()] })
    cerrar(ctx, abierta.id)

    expect(() => cancelar(ctx, compra.id)).toThrow(/caja abierta/i)

    // The refusal has to be total. A purchase left `completada` with its stock still on the shelf
    // and no entry reversed is a coherent state to come back to; one left half-reversed is not.
    expect(obtener(ctx, compra.id).estado).toBe('completada')
    expect(saldo(CUENTA.CAJA)).toBe(38000)
    expect(saldoCaja(cajaPorId(abierta.id))).toBe(38000)
  })

  it('cancels a cash purchase once a till is open again, and the drawer comes back to where it was', () => {
    const abierta = abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, saldoInicialCentavos: 50000 })
    const compra = crear(ctx, { proveedorId: proveedor.id, metodoPago: 'efectivo', items: [linea()] })
    cerrar(ctx, abierta.id)
    const nueva = abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, saldoInicialCentavos: 50000 })

    cancelar(ctx, compra.id)

    // The interesting number is not any one of these three, it is that they RECONCILE. The account
    // is one `1.1.01` for the whole business and both tills debited it, so it reads $1.000. The
    // $120 left the first drawer and came back into the second, so the drawers read $380 and $620.
    // The first drawer keeps the money it was short — it cannot be credited, it is closed and its
    // count is a fact — and the account nets the two events to zero. What must hold is that the
    // closed drawer plus the open one equals the account, which is the property the silent-skip
    // bug broke and the property a shop reconciles on.
    expect(saldo(CUENTA.CAJA)).toBe(100000)
    expect(saldoCaja(cajaPorId(abierta.id))).toBe(38000)
    expect(saldoCaja(cajaPorId(nueva.id))).toBe(62000)
    expect(saldoCaja(cajaPorId(abierta.id)) + saldoCaja(cajaPorId(nueva.id))).toBe(saldo(CUENTA.CAJA))
  })

  /**
   * A hand-corrected stock count.
   *
   * The cost was already checked, and the stock was not. A shop that counts stock and finds it wrong
   * corrects it by hand, and cancelling an old purchase would then have restored the snapshot over
   * that correction without a word — the count would be silently erased. A refusal the operator can
   * act on beats a quiet overwrite, exactly as it does for the cost.
   */
  it('refuses to cancel a purchase whose stock was corrected by hand, and leaves the count alone', () => {
    const compra = crear(ctx, { proveedorId: proveedor.id, metodoPago: 'tarjeta', items: [linea()] })
    ctx.db
      .prepare('UPDATE productos SET stock_milli = 7777 WHERE id = ? AND negocio_id = ?')
      .run(queso.id, t.negocioId)

    expect(() => cancelar(ctx, compra.id)).toThrow(/stock/i)

    expect(obtener(ctx, compra.id).estado).toBe('completada')
    expect(ctx.db.prepare('SELECT stock_milli FROM productos WHERE id = ?').get(queso.id).stock_milli).toBe(7777)
  })

  /**
   * A line whose product no longer exists.
   *
   * NOT TESTED, and the reason is worth more than a test would be:
   * `compras_detalles.producto_id` is declared `REFERENCES productos (id) ON DELETE RESTRICT`, and
   * `productos` has no `deleted_at` column to be soft-deleted through. A product a purchase line
   * points at therefore cannot be removed at all — the database refuses before this code runs, and
   * the first version of this test failed with `FOREIGN KEY constraint failed`, which is the schema
   * doing its job.
   *
   * So `COMPRA_PRODUCTO_FALTA` is defence in depth, not a reachable branch. The guard is kept
   * because the alternative the old code took — `if (producto)`, skip the line, and still mark the
   * purchase cancelled — is a silent partial reversal that a rollback cannot catch, and that is
   * worth being unreachable rather than merely unlikely. But it is not the kind of claim this
   * suite makes elsewhere, so it gets no test pretending otherwise.
   */
  it('cannot have a purchase line without its product, because the schema forbids it', () => {
    crear(ctx, { proveedorId: proveedor.id, metodoPago: 'tarjeta', items: [linea()] })
    expect(() =>
      t.conn.db.prepare('DELETE FROM productos WHERE id = ?').run(queso.id)
    ).toThrow(/FOREIGN KEY/i)
  })
})
