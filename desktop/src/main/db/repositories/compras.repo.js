import { IpcError } from '../../bridge/errors.js'
import { requireTenant } from '../seed.js'
import { assertCents, toCents } from '../../../shared/money.js'
import { assertMilli, costoPromedioCentavos, lineTotalCentavos, toMilli } from '../../../shared/qty.js'
import { asentar, asegurarPlan, CUENTA } from './cuentas.repo.js'
import { cajaActiva, registrarMovimiento } from './cajas.repo.js'
import { randomUUID } from 'node:crypto'

/**
 * Purchases: goods arriving, what they cost, where the money came from, and what the shop owes.
 *
 * WHAT THE WEB DOES, because it is the behaviour authority and this repository departs from it
 * deliberately in five places. The web's `compra.create` increments `productos.stock` and, if
 * `retirarDeCaja` is set, writes a drawer movement. That is all it does. So:
 *
 *   1. NO COST IS EVER UPDATED. The web leaves `precio_compra_centavos` at whatever the catalogue
 *      was seeded with, and then `ventas.controller.js` computes cost of goods sold from that same
 *      stale column. Every margin the web has ever reported is a margin against a purchase price
 *      the shop may have stopped buying at years ago. Here every purchase folds its lot into a
 *      MOVING AVERAGE (§ below), and a sale snapshots the cost it actually used.
 *   2. NO JOURNAL ENTRY. The web posts no accounting for a purchase at all: the stock appears, the
 *      cash leaves the drawer, and no account moves. Every entry in the web's ledger is a sale, so
 *      the inventory account and the payable to suppliers do not exist there. Here a purchase posts
 *      one balanced entry, always, in the same transaction as the stock.
 *   3. NO PAYMENT METHOD, AND THEREFORE NO PAYABLE. The web has a boolean, `retirarDeCaja`. A
 *      supplier's purchase paid by card, paid in cash and owed to the supplier are the same two
 *      states in the web, and the third one does not exist. Here the choice is a real method and a
 *      credit purchase creates a real liability.
 *   4. NO TRACE OF WHICH RECEIPT MOVED WHICH PRODUCT. Here each line writes an `auditoria` row
 *      carrying the product's stock and cost before and after, which is what makes `cancelar` able
 *      to reverse a purchase exactly (§ below) and what answers "why does this product cost that".
 *   5. CANCELLING LEAVES THE MONEY OUT. The web's `compra.cancel` reverses the stock and stops. The
 *      drawer movement from the original purchase is never touched, so cancelling a cash purchase
 *      removes the goods and keeps the cash. Here cancelling reverses all of it.
 *
 * WHY THE PAYMENT METHOD IS NOT A COLUMN. `compras` in the frozen schema has no `metodo_pago`, and
 * a migration is not available to this build — so the method is not a column here either, and none
 * is invented in `observaciones`, where a reportable business fact would be unreadable. The method
 * is instead DERIVED from the entry the purchase posted: the account it credited says how it was
 * paid. `1.1.01` is cash, `1.1.02` is card, `2.1.01` is credit. That is not a workaround, it is
 * better than a column: the payment method cannot drift away from the accounting, because it IS
 * the accounting. `estado` then carries the lifecycle, and `pendiente` is given its real meaning —
 * a purchase the shop has not paid for yet, which is exactly what a credit purchase is.
 *
 * WHY A MOVING AVERAGE AND NOT THE LAST PRICE. `productos.precio_compra_centavos` answers "what
 * does a unit of this cost me on average, right now", and a shop that restocks the same goods buys
 * the same goods at several prices. Overwriting the cost with each new lot's price values the whole
 * shelf at the price of the last crate and reports a margin nobody earned. `costoPromedioCentavos`
 * in `shared/qty.js` does the weighted arithmetic in `BigInt` and names its rounding.
 *
 * WHY A HISTORICAL SALE'S MARGIN DOES NOT MOVE. `ventas_detalles.costo_unitario_centavos` is
 * written at the moment of the sale, so restocking at a higher price changes future margins and
 * leaves every past one exactly as it was reported. Without that column a purchase would silently
 * rewrite the shop's profit history, which is the one thing a number people have already acted on
 * must never do.
 */
const CUENTA_POR_METODO = Object.freeze({
  efectivo: CUENTA.CAJA,
  tarjeta: CUENTA.BANCO,
  credito: CUENTA.PROVEEDORES
})

/** The three ways a purchase is paid for. No `mixto`, no `transferencia`, and the reason is in §L. */
const METODOS = Object.freeze(['efectivo', 'tarjeta', 'credito'])

/**
 * `C-<uuid>`, inside the schema's `TEXT` for `folio`.
 *
 * The web generates `CMP-${Date.now()}`, which is a TIMESTAMP: two purchases registered in the
 * same millisecond share a folio, and a folio is the number a supplier quotes on the phone. The
 * uuid costs the same and cannot collide. A folio the operator supplies is accepted, because a
 * paper purchase already has one, and it is the reference the shop will search by.
 */
function nuevoFolio() {
  return `C-${randomUUID()}`
}

/** Purchases, newest first, filterable the way the web's list screen filters. */
export function listar(ctx, { search = '', estado, proveedorId, limit = 50, offset = 0 } = {}) {
  requireTenant(ctx.negocioId)

  const cond = ['c.negocio_id = ?', 'c.deleted_at IS NULL']
  const args = [ctx.negocioId]

  const q = search === null || search === undefined ? '' : String(search).trim()
  if (q !== '') {
    // The folio and the supplier's name, because those are the two things an operator has in
    // hand: a number off a paper receipt, or a supplier they are trying to reconcile with.
    cond.push("(c.folio LIKE ? ESCAPE '\\' OR pr.nombre LIKE ? ESCAPE '\\')")
    const patron = `%${escaparLike(q.toLowerCase())}%`
    args.push(patron, patron)
  }
  if (estado !== undefined && estado !== null && estado !== '') {
    if (!['pendiente', 'completada', 'cancelada'].includes(estado)) {
      throw new IpcError('COMPRA_ESTADO_INVALIDO', 400, `Estado de compra desconocido: ${JSON.stringify(estado)}`)
    }
    cond.push('c.estado = ?')
    args.push(estado)
  }
  if (proveedorId !== undefined && proveedorId !== null && proveedorId !== '') {
    cond.push('c.proveedor_id = ?')
    args.push(assertId(proveedorId, 'proveedor'))
  }
  const where = cond.join(' AND ')

  const total = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM compras c
         LEFT JOIN proveedores pr ON pr.id = c.proveedor_id
        WHERE ${where}`
    )
    .get(...args).n
  const filas = ctx.db
    .prepare(
      `SELECT c.*, pr.nombre AS proveedor_nombre
         FROM compras c
         LEFT JOIN proveedores pr ON pr.id = c.proveedor_id
        WHERE ${where}
        ORDER BY c.fecha DESC, c.id DESC
        LIMIT ? OFFSET ?`
    )
    .all(...args, limit, offset)

  return {
    filas: filas.map((row) => ({ ...mapCompra(row), metodoPago: metodoDeCompra(ctx, row) })),
    total
  }
}

/**
 * One purchase with its lines, its accounting entry and its drawer movement.
 *
 * The payment method and the entry are read back from what was actually posted rather than echoed
 * from the request, so this screen cannot claim a purchase was paid in cash when the ledger says
 * the payable took it.
 */
export function obtener(ctx, id) {
  requireTenant(ctx.negocioId)
  const cid = assertId(id, 'compra')

  const row = ctx.db
    .prepare(
      `SELECT c.*, pr.nombre AS proveedor_nombre
         FROM compras c
         LEFT JOIN proveedores pr ON pr.id = c.proveedor_id
        WHERE c.id = ? AND c.negocio_id = ? AND c.deleted_at IS NULL`
    )
    .get(cid, ctx.negocioId)
  if (!row) {
    throw new IpcError('COMPRA_NO_ENCONTRADA', 404, 'La compra no existe en este negocio')
  }

  const detalles = ctx.db
    .prepare(
      `SELECT d.*, p.nombre AS producto_nombre, p.unidad_medida
         FROM compras_detalles d
         LEFT JOIN productos p ON p.id = d.producto_id
        WHERE d.compra_id = ?
        ORDER BY d.id ASC`
    )
    .all(cid)

  return {
    ...mapCompra(row),
    metodoPago: metodoDeCompra(ctx, row),
    detalles: detalles.map((d) => ({
      id: d.id,
      productoId: d.producto_id,
      productoNombre: d.producto_nombre,
      unidadMedida: d.unidad_medida,
      cantidadMilli: d.cantidad_milli,
      precioUnitarioCentavos: d.precio_unitario_centavos,
      subtotalCentavos: d.subtotal_centavos
    })),
    asiento: asientoDeCompra(ctx, cid),
    movimientoCaja: movimientoDeCompra(ctx, cid)
  }
}

/**
 * Register a purchase: goods in, cost folded in, money moved or owed, all in ONE transaction.
 *
 * Nothing here trusts the request. The total is computed from the lines, the lines' totals are
 * computed from price and quantity, the average cost is computed from what the product actually
 * holds, and the account is chosen from the method. A client that sends `totalCentavos: 1` for a
 * $400 purchase gets a purchase of whatever its lines add up to, because the number the client sent
 * is not in the INSERT.
 *
 * The whole thing is one `ctx.tx`. A purchase that moved the stock but not the money is a shop
 * whose books and shelf disagree, and a transaction is the only thing that can promise they were
 * written together.
 */
export function crear(ctx, body) {
  requireTenant(ctx.negocioId)
  if (!ctx.actorId) {
    throw new IpcError('ACTOR_REQUERIDO', 401, 'La operación necesita un usuario en sesión')
  }
  if (!body || typeof body !== 'object') {
    throw new IpcError('COMPRA_CUERPO_INVALIDO', 400, 'La compra debe enviar un cuerpo de petición')
  }

  const metodoPago = metodoDe(body.metodoPago)
  const items = leerItems(body.items ?? body.detalles)
  const folio = texto(body.folio) ?? nuevoFolio()
  const observaciones = texto(body.observaciones)

  // The money, computed here and not accepted from the request.
  const subtotal = items.reduce((s, l) => s + l.subtotalCentavos, 0)
  const iva = assertCents(items.reduce((s, l) => s + l.ivaCentavos, 0), 'IVA de la compra')
  const total = assertCents(subtotal + iva, 'total de la compra')
  if (total < 1) {
    throw new IpcError('COMPRA_TOTAL_CERO', 400, 'Una compra por $0 no se puede registrar')
  }

  const ts = new Date().toISOString()
  // `efectivo` and `tarjeta` are paid at the counter: `completada`. `credito` is not money yet, and
  // `pendiente` is the word that says so — the same word a supplier's unpaid invoice deserves.
  const estado = metodoPago === 'credito' ? 'pendiente' : 'completada'

  return ctx.tx(() => {
    const proveedorId = resolverProveedor(ctx, body.proveedorId)

    // A cash purchase needs an open till, and it is checked BEFORE anything is written so the
    // refusal costs nothing. The web checks it too, but after creating the rows.
    const caja = metodoPago === 'efectivo' ? cajaActiva(ctx.db, ctx.negocioId) : null
    if (metodoPago === 'efectivo' && !caja) {
      throw new IpcError(
        'CAJA_ABIERTA_REQUERIDA',
        409,
        'No hay caja abierta: una compra en efectivo necesita una caja para sacar el dinero'
      )
    }

    const info = ctx.db
      .prepare(
        `INSERT INTO compras
           (folio, fecha, subtotal_centavos, iva_centavos, descuento_centavos, total_centavos,
            estado, observaciones, proveedor_id, user_id, negocio_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(folio, ts, subtotal, iva, total, estado, observaciones, proveedorId,
           ctx.actorId, ctx.negocioId, ts, ts)
    const compraId = Number(info.lastInsertRowid)

    // ---- the goods, the stock and the cost -------------------------------------------------
    // Every line's before/after goes into `auditoria`. That is the trace, and it is also what
    // makes `cancelar` able to put the cost back exactly instead of guessing at it.
    for (const item of items) {
      const producto = ctx.db
        .prepare('SELECT * FROM productos WHERE id = ? AND negocio_id = ?')
        .get(item.productoId, ctx.negocioId)
      if (!producto) {
        throw new IpcError('PRODUCTO_NO_ENCONTRADO', 404, `El producto ${item.productoId} no existe en este negocio`)
      }
      if (producto.activo === 0) {
        throw new IpcError('PRODUCTO_INACTIVO', 409, `El producto ${producto.nombre} está inactivo`)
      }

      const stockAntes = assertMilli(producto.stock_milli, `stock de ${producto.nombre}`)
      const costoAntes = assertCents(producto.precio_compra_centavos, `costo de ${producto.nombre}`)
      const stockDespues = assertMilli(stockAntes + item.cantidadMilli, `stock de ${producto.nombre}`)
      // The ONE place the average is written. Half away from zero, in BigInt, named in qty.js.
      const costoDespues = costoPromedioCentavos(stockAntes, costoAntes, item.cantidadMilli, item.precioUnitarioCentavos, {
        label: `costo de ${producto.nombre}`
      })

      const detalle = ctx.db
        .prepare(
          `INSERT INTO compras_detalles
             (cantidad_milli, precio_unitario_centavos, subtotal_centavos, compra_id, producto_id,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(item.cantidadMilli, item.precioUnitarioCentavos, item.subtotalCentavos, compraId, item.productoId, ts, ts)
      const detalleId = Number(detalle.lastInsertRowid)

      ctx.db
        .prepare('UPDATE productos SET stock_milli = ?, precio_compra_centavos = ?, updated_at = ? WHERE id = ? AND negocio_id = ?')
        .run(stockDespues, costoDespues, ts, item.productoId, ctx.negocioId)

      // The traceable stock movement. `movimientos_stock` does not exist in the frozen schema and
      // is not invented here; `auditoria` is the table that DOES exist, and this is the question it
      // answers: which receipt added this many units, at this price, moving the cost from here to
      // there. Queryable by product, by purchase, and by date.
      ctx.db
        .prepare(
          `INSERT INTO auditoria
             (tabla, registro_id, accion, valores_anteriores, valores_nuevos, user_id, negocio_id, created_at, updated_at)
           VALUES ('compras_detalles', ?, 'CREATE', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          detalleId,
          JSON.stringify({ stockMilli: stockAntes, costoCompraCentavos: costoAntes }),
          JSON.stringify({
            stockMilli: stockDespues,
            costoCompraCentavos: costoDespues,
            cantidadMilli: item.cantidadMilli,
            precioUnitarioCentavos: item.precioUnitarioCentavos,
            subtotalCentavos: item.subtotalCentavos,
            compraId,
            folio
          }),
          ctx.actorId,
          ctx.negocioId,
          ts,
          ts
        )
    }

    // ---- the ledger -----------------------------------------------------------------------
    const cuentas = asegurarPlan(ctx)
    asentar(ctx, {
      fecha: ts,
      descripcion: `Compra ${folio}`,
      tipo: 'egreso',
      referencia: `compra:${compraId}`,
      partidas: [
        // Goods arrive: the inventory account goes up by what they cost.
        { cuentaId: cuentas.get(CUENTA.MERCADERIAS).id, debeCentavos: total, haberCentavos: 0, descripcion: `Mercaderías ${folio}` },
        // And the other side says HOW: cash left the drawer, the bank took it, or the shop now owes
        // the supplier. A credit purchase ends here, with a liability and no drawer movement.
        { cuentaId: cuentas.get(CUENTA_POR_METODO[metodoPago]).id, debeCentavos: 0, haberCentavos: total, descripcion: pagoDescripcion(metodoPago) }
      ]
    })

    // ---- the drawer -----------------------------------------------------------------------
    if (caja) {
      registrarMovimiento(ctx, {
        caja,
        tipo: 'egreso',
        concepto: `COMPRA ${folio}`,
        montoCentavos: total,
        origen: 'compra',
        referencia: `compra:${compraId}`,
        ventaId: null
      })
    }

    ctx.db
      .prepare(
        `INSERT INTO auditoria
           (tabla, registro_id, accion, valores_nuevos, user_id, negocio_id, created_at, updated_at)
         VALUES ('compras', ?, 'CREATE', ?, ?, ?, ?, ?)`
      )
      .run(compraId, JSON.stringify({ folio, totalCentavos: total, metodoPago, estado, proveedorId, lineas: items.length }),
           ctx.actorId, ctx.negocioId, ts, ts)

    // The full row, read back from the database, not the values that were sent to it. The
    // renderer redraws from this, so anything the repository decided — the method, the state, the
    // totals — arrives here as a fact rather than as an echo of the request.
    return obtener(ctx, compraId)
  })
}

/**
 * Edit a purchase's PAPER, never its money.
 *
 * `folio` and `observaciones` only. The web runs `compra.update(req.body)`, which will cheerfully
 * rewrite `total_centavos` on a purchase that already moved the stock, already left the drawer and
 * already posted an entry — leaving three records that disagree and no way to tell which is the
 * lie. Here a purchase whose goods have arrived is not re-costable: correcting the items means
 * cancelling and re-registering, which is the operation that reverses the stock, the cost, the entry
 * and the drawer together.
 *
 * The web's one rule is kept: a cancelled purchase is refused.
 */
export function actualizar(ctx, id, body) {
  requireTenant(ctx.negocioId)
  const cid = assertId(id, 'compra')
  if (!body || typeof body !== 'object') {
    throw new IpcError('COMPRA_CUERPO_INVALIDO', 400, 'La compra debe enviar un cuerpo de petición')
  }

  const cambios = []
  const args = []
  if (body.folio !== undefined) {
    const folio = texto(body.folio)
    if (folio === null) {
      throw new IpcError('COMPRA_FOLIO_INVALIDO', 400, 'El folio de la compra no puede quedar vacío')
    }
    cambios.push('folio = ?')
    args.push(folio)
  }
  if (body.observaciones !== undefined) {
    cambios.push('observaciones = ?')
    args.push(texto(body.observaciones))
  }
  for (const prohibido of ['total', 'totalCentavos', 'subtotal', 'estado', 'items', 'detalles', 'metodoPago']) {
    if (body[prohibido] !== undefined) {
      throw new IpcError(
        'COMPRA_CAMPO_PROTEGIDO',
        409,
        `Una compra registrada no se puede cambiar en "${prohibido}": cancelala y registrala de nuevo`
      )
    }
  }
  if (cambios.length === 0) return obtener(ctx, cid)

  const ts = new Date().toISOString()
  return ctx.tx(() => {
    const compra = ctx.db
      .prepare('SELECT * FROM compras WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL')
      .get(cid, ctx.negocioId)
    if (!compra) {
      throw new IpcError('COMPRA_NO_ENCONTRADA', 404, 'La compra no existe en este negocio')
    }
    if (compra.estado === 'cancelada') {
      throw new IpcError('COMPRA_CANCELADA', 409, 'No se puede modificar una compra cancelada')
    }
    ctx.db
      .prepare(`UPDATE compras SET ${cambios.join(', ')}, updated_at = ? WHERE id = ? AND negocio_id = ?`)
      .run(...args, ts, cid, ctx.negocioId)
    return obtener(ctx, cid)
  })
}

/**
 * Cancel a purchase and put the stock, the cost, the entry and the money back.
 *
 * This is the hardest operation in the file, and the reason is arithmetic rather than bookkeeping:
 * a MOVING AVERAGE CANNOT BE INVERTED FROM THE LOT PRICES. Undoing one lot means replaying every
 * lot after it, and the state before the FIRST lot of a product is not recorded anywhere in the
 * frozen schema — the catalogue's opening stock and cost are whatever the product was created with,
 * and no column holds them.
 *
 * So the reversal is exact when it can be, and refused when it cannot:
 *
 *   - The `auditoria` row written when the line was recorded holds that product's stock and cost
 *     IMMEDIATELY BEFORE this purchase. If no later purchase has touched the same product, that
 *     snapshot is the state to restore, and the reversal is exact.
 *   - If a LATER purchase already folded another lot into the same product, restoring the snapshot
 *     would erase that later lot's effect, and keeping the current cost would leave this lot's
 *     effect in. Neither is right, so the cancellation is refused with a message that says so, and
 *     the operator cancels the later purchase first. Cancelling in reverse chronological order
 *     always works, and that is the order the screen offers them.
 *   - The restore is also checked against what the product costs NOW. If something has changed the
 *     cost since — a later purchase this check did not catch, an edit, a restore — the recorded
 *     snapshot is refused rather than written over the top of a state nobody has explained.
 */
export function cancelar(ctx, id) {
  requireTenant(ctx.negocioId)
  const cid = assertId(id, 'compra')

  return ctx.tx(() => {
    const compra = ctx.db
      .prepare(
        `SELECT c.*, pr.nombre AS proveedor_nombre
           FROM compras c LEFT JOIN proveedores pr ON pr.id = c.proveedor_id
          WHERE c.id = ? AND c.negocio_id = ? AND c.deleted_at IS NULL`
      )
      .get(cid, ctx.negocioId)
    if (!compra) {
      throw new IpcError('COMPRA_NO_ENCONTRADA', 404, 'La compra no existe en este negocio')
    }
    if (compra.estado === 'cancelada') {
      throw new IpcError('COMPRA_YA_CANCELADA', 409, 'La compra ya está cancelada')
    }

    const detalles = ctx.db
      .prepare('SELECT * FROM compras_detalles WHERE compra_id = ? ORDER BY id ASC')
      .all(cid)

    // The check, BEFORE any write: does a later live purchase touch any of these products?
    for (const detalle of detalles) {
      const posterior = ctx.db
        .prepare(
          `SELECT c.folio FROM compras_detalles d
             JOIN compras c ON c.id = d.compra_id
            WHERE d.producto_id = ? AND d.compra_id > ? AND c.negocio_id = ? AND c.estado <> 'cancelada'
            LIMIT 1`
        )
        .get(detalle.producto_id, cid, ctx.negocioId)
      if (posterior) {
        const producto = ctx.db.prepare('SELECT nombre FROM productos WHERE id = ?').get(detalle.producto_id)
        throw new IpcError(
          'COMPRA_NO_REVERSIBLE',
          409,
          `La compra posterior ${posterior.folio} ya actualizó el costo de "${producto?.nombre ?? detalle.producto_id}", ` +
            'así que esta no se puede cancelar sin perder ese ajuste: cancelá las compras en orden inverso'
        )
      }
    }

    const ts = new Date().toISOString()
    const cuentas = asegurarPlan(ctx)
    const metodoPago = metodoDeCompra(ctx, compra)

    // ---- a cash purchase is only refundable into an OPEN drawer ------------------------------
    // This check comes before every write, and it REFUSES rather than skipping. An earlier draft
    // asked for the active till and did nothing when the answer was null — so a cash purchase
    // cancelled after the till closed would post the reversal entry, credit `1.1.01 Caja`, mark
    // the purchase `cancelada`, and never give the money back: the ledger and the drawer would
    // then disagree permanently and the till's own sum could no longer reproduce the account.
    // A closed drawer also cannot prove it is holding anything, which is the same reason
    // `deudores.addPayment` refuses a cash payment outright instead of crediting the account.
    const caja = metodoPago === 'efectivo' ? cajaActiva(ctx.db, ctx.negocioId) : null
    if (metodoPago === 'efectivo' && !caja) {
      throw new IpcError(
        'CAJA_ABIERTA_REQUERIDA',
        409,
        'No hay caja abierta. Abrí una caja antes de anular una compra en efectivo: el dinero tiene que volver a un cajón que exista.'
      )
    }

    // ---- the goods and the cost, restored from the recorded snapshot ------------------------
    // Read and check EVERY line before writing ANY of them. A rollback would cover a throw in the
    // middle of this loop, but reading the whole way first means the operator gets the refusal
    // about the product they are actually looking at, instead of one about whichever line
    // happened to sort first.
    const restauraciones = detalles.map((detalle) => {
      // Pinned to the `CREATE` row on purpose. Cancelling writes a second row for the same
      // `registro_id`, and an `ORDER BY`less `.get()` on two rows is not a contract: picking the
      // `DELETE` row would read the POST-state as the "before" and restore the purchase's own
      // effect, which is not a reversal at all.
      const fila = ctx.db
        .prepare(
          `SELECT valores_anteriores, valores_nuevos FROM auditoria
            WHERE tabla = 'compras_detalles' AND registro_id = ? AND negocio_id = ? AND accion = 'CREATE'`
        )
        .get(detalle.id, ctx.negocioId)
      if (!fila) {
        throw new IpcError(
          'COMPRA_SIN_TRAZA',
          409,
          'La compra no tiene la traza de stock que hace falta para revertirla con exactitud'
        )
      }
      const antes = JSON.parse(fila.valores_anteriores)
      const despues = JSON.parse(fila.valores_nuevos)
      const producto = ctx.db
        .prepare('SELECT * FROM productos WHERE id = ? AND negocio_id = ?')
        .get(detalle.producto_id, ctx.negocioId)

      // A missing product used to fall through a `if (producto)` guard and skip the restore
      // entirely — a partial reversal that still marked the purchase `cancelada`, with its stock
      // never coming back. A rollback cannot catch that, because nothing threw.
      //
      // This is defence in depth and the schema already forbids the state:
      // `compras_detalles.producto_id` is `ON DELETE RESTRICT` and `productos` has no
      // `deleted_at`, so a referenced product cannot be removed. Kept because the failure it
      // replaces is a SILENT one, and a silent partial reversal is worth making unreachable
      // rather than merely unlikely.
      if (!producto) {
        throw new IpcError(
          'COMPRA_PRODUCTO_FALTA',
          409,
          `El producto de la línea ${detalle.id} ya no existe en este negocio, así que su stock no se puede devolver`
        )
      }
      if (producto.precio_compra_centavos !== despues.costoCompraCentavos) {
        // Something moved the cost since this purchase. Writing the snapshot now would silently
        // discard that change, so the cancellation stops and says so.
        throw new IpcError(
          'COMPRA_COSTO_MOVIDO',
          409,
          `El costo de "${producto.nombre}" cambió desde esta compra y no se puede revertir sin perder ese cambio`
        )
      }
      // The cost is checked above, so the stock is checked here for the same reason. A manual
      // stock correction is exactly as real as a manual cost correction, and restoring the
      // snapshot over it would erase the correction without a word.
      if (producto.stock_milli !== despues.stockMilli) {
        throw new IpcError(
          'COMPRA_STOCK_MOVIDO',
          409,
          `El stock de "${producto.nombre}" cambió desde esta compra y no se puede revertir sin perder ese cambio`
        )
      }
      return { detalle, antes, despues, producto }
    })

    for (const { detalle, antes, despues } of restauraciones) {
      ctx.db
        .prepare('UPDATE productos SET stock_milli = ?, precio_compra_centavos = ?, updated_at = ? WHERE id = ? AND negocio_id = ?')
        .run(antes.stockMilli, antes.costoCompraCentavos, ts, detalle.producto_id, ctx.negocioId)
      ctx.db
        .prepare(
          `INSERT INTO auditoria
             (tabla, registro_id, accion, valores_anteriores, valores_nuevos, user_id, negocio_id, created_at, updated_at)
           VALUES ('compras_detalles', ?, 'DELETE', ?, ?, ?, ?, ?, ?)`
        )
        .run(detalle.id,
             JSON.stringify({ stockMilli: despues.stockMilli, costoCompraCentavos: despues.costoCompraCentavos }),
             JSON.stringify({ stockMilli: antes.stockMilli, costoCompraCentavos: antes.costoCompraCentavos, cancelada: true }),
             ctx.actorId, ctx.negocioId, ts, ts)
    }

    // ---- the ledger, mirrored --------------------------------------------------------------
    // The same magnitudes on the other side, not negative amounts: a `debe` cannot be negative
    // here, and a reversed entry reads as a reversed entry in the books rather than as a refund.
    asentar(ctx, {
      fecha: ts,
      descripcion: `Anulación compra ${compra.folio}`,
      tipo: 'egreso',
      referencia: `compra:${cid}`,
      partidas: [
        { cuentaId: cuentas.get(CUENTA_POR_METODO[metodoPago]).id, debeCentavos: compra.total_centavos, haberCentavos: 0, descripcion: `Reversión pago ${metodoPago}` },
        { cuentaId: cuentas.get(CUENTA.MERCADERIAS).id, debeCentavos: 0, haberCentavos: compra.total_centavos, descripcion: `Mercaderías ${compra.folio}` }
      ]
    })

    // ---- the money back into the drawer ------------------------------------------------------
    // Only a purchase that TOOK cash gives it back, into the SAME drawer resolution the check
    // above already made — there is no second question here that could answer differently. A card
    // purchase settled through the bank and a credit purchase that was never paid both leave the
    // drawer exactly as it was, which is the whole point of distinguishing them at the moment of
    // purchase.
    if (caja) {
      registrarMovimiento(ctx, {
        caja,
        tipo: 'ingreso',
        concepto: `ANULACIÓN COMPRA ${compra.folio}`,
        montoCentavos: compra.total_centavos,
        origen: 'compra',
        referencia: `compra-cancel:${cid}`,
        ventaId: null
      })
    }

    ctx.db
      .prepare("UPDATE compras SET estado = 'cancelada', updated_at = ? WHERE id = ? AND negocio_id = ?")
      .run(ts, cid, ctx.negocioId)
    ctx.db
      .prepare(
        `INSERT INTO auditoria
           (tabla, registro_id, accion, valores_anteriores, valores_nuevos, user_id, negocio_id, created_at, updated_at)
         VALUES ('compras', ?, 'DELETE', ?, ?, ?, ?, ?, ?)`
      )
      .run(cid,
           JSON.stringify({ estado: compra.estado, metodoPago }),
           JSON.stringify({ estado: 'cancelada', metodoPago }),
           ctx.actorId, ctx.negocioId, ts, ts)

    return obtener(ctx, cid)
  })
}

/**
 * The lines of a purchase, in the shape the schema stores them.
 *
 * Quantities speak thousandths and money speaks centavos, both as strings, both through the same
 * parsers the sale uses — so a purchase of 2,5 kg at $3.333/kg is read exactly the way a sale of
 * 2,5 kg at the same price is, and the two cannot disagree about what a kilo costs.
 */
function leerItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new IpcError('COMPRA_SIN_ITEMS', 400, 'La compra necesita al menos una línea de producto')
  }
  return items.map((item, i) => {
    const etiqueta = `línea ${i + 1}`
    if (!item || typeof item !== 'object') {
      throw new IpcError('COMPRA_ITEM_INVALIDO', 400, `La ${etiqueta} no es un producto`)
    }
    const productoId = assertId(item.productoId ?? item.producto_id, `producto de la ${etiqueta}`)
    const cantidadMilli = assertMilli(toMilli(item.cantidad, `${etiqueta}: cantidad`), `${etiqueta}: cantidad`)
    const precioUnitarioCentavos = assertCents(
      toCents(item.precioUnitario ?? item.precio_unitario, `${etiqueta}: precio unitario`),
      `${etiqueta}: precio unitario`
    )
    if (precioUnitarioCentavos < 1) {
      // A line at $0 would add stock worth nothing while the journal says the goods cost the
      // purchase's total. The schema would accept it; the books would not balance against it.
      throw new IpcError('COMPRA_PRECIO_CERO', 400, `La ${etiqueta} necesita un precio de compra mayor a cero`)
    }
    // Purchases carry no tax in this build: the web's `Compra` has no per-line IVA either, it
    // stores one header `iva` and never computes it. A purchase invoice's tax is extracted from the
    // supplier's own document, and inventing a rate here would post a liability to nobody.
    const subtotalCentavos = lineTotalCentavos(precioUnitarioCentavos, cantidadMilli, { label: etiqueta })
    return { productoId, cantidadMilli, precioUnitarioCentavos, subtotalCentavos, ivaCentavos: 0 }
  })
}

/** `efectivo`, `tarjeta` or `credito`, and nothing else. `transferencia` and `mixto` are refused. */
function metodoDe(valor) {
  const metodo = valor === null || valor === undefined ? '' : String(valor).trim().toLowerCase()
  if (!METODOS.includes(metodo)) {
    throw new IpcError(
      'COMPRA_METODO_INVALIDO',
      400,
      `Método de pago desconocido: ${JSON.stringify(valor)}. Esta build acepta: ${METODOS.join(', ')}`
    )
  }
  return metodo
}

/**
 * The method a purchase was paid with, READ BACK from the account it credited.
 *
 * For a cancelled purchase the crediting entry has been mirrored by a debit, so the accounts are
 * back where they started and the method reads as cash. That is wrong, and it is why `cancelar`
 * returns the row with the method resolved once, from the ORIGINAL entry, before it is mirrored.
 * This helper is for live purchases.
 */
function metodoDeCompra(ctx, compra) {
  if (compra.estado === 'cancelada') return null
  const codigo = ctx.db
    .prepare(
      `SELECT c.codigo FROM asientos_contables a
         JOIN detalles_asientos d ON d.asiento_contable_id = a.id
         JOIN cuentas_contables c ON c.id = d.cuenta_contable_id
        WHERE a.negocio_id = ? AND a.referencia = ? AND d.haber_centavos > 0
        ORDER BY d.id ASC LIMIT 1`
    )
    .get(ctx.negocioId, `compra:${compra.id}`)?.codigo
  if (codigo === CUENTA.CAJA) return 'efectivo'
  if (codigo === CUENTA.BANCO) return 'tarjeta'
  if (codigo === CUENTA.PROVEEDORES) return 'credito'
  return null
}

/** The purchase's own journal lines, for a detail screen that shows what was posted. */
function asientoDeCompra(ctx, compraId) {
  const asiento = ctx.db
    .prepare("SELECT * FROM asientos_contables WHERE negocio_id = ? AND referencia = ? ORDER BY id ASC LIMIT 1")
    .get(ctx.negocioId, `compra:${compraId}`)
  if (!asiento) return null
  const partidas = ctx.db
    .prepare(
      `SELECT d.debe_centavos AS debe, d.haber_centavos AS haber, d.descripcion, c.codigo, c.nombre
         FROM detalles_asientos d
         JOIN cuentas_contables c ON c.id = d.cuenta_contable_id
        WHERE d.asiento_contable_id = ?
        ORDER BY d.id ASC`
    )
    .all(asiento.id)
  return {
    id: asiento.id,
    fecha: asiento.fecha,
    descripcion: asiento.descripcion,
    tipo: asiento.tipo,
    montoTotalCentavos: asiento.monto_total_centavos,
    partidas
  }
}

/** The drawer movement this purchase caused, if it caused one. Cash only, by construction. */
function movimientoDeCompra(ctx, compraId) {
  // `cajas` has no `nombre` column — the till is identified by its id, and the schema says so, so
  // the movement reports the id and the running balance rather than a label that does not exist.
  const fila = ctx.db
    .prepare(
      `SELECT m.*, c.id AS caja_id, c.fecha_apertura AS caja_fecha_apertura
         FROM movimientos_caja m
         JOIN cajas c ON c.id = m.caja_id
        WHERE m.negocio_id = ? AND m.origen = 'compra' AND m.referencia = ?
        ORDER BY m.id ASC LIMIT 1`
    )
    .get(ctx.negocioId, `compra:${compraId}`)
  if (!fila) return null
  return {
    id: fila.id,
    tipo: fila.tipo,
    concepto: fila.concepto,
    montoCentavos: fila.monto_centavos,
    saldoAnteriorCentavos: fila.saldo_anterior_centavos,
    saldoNuevoCentavos: fila.saldo_nuevo_centavos,
    cajaId: fila.caja_id,
    cajaFechaApertura: fila.caja_fecha_apertura
  }
}

/** A supplier that exists, is not deleted and is active. A purchase cannot be made to a ghost. */
function resolverProveedor(ctx, valor) {
  if (valor === undefined || valor === null || valor === '') {
    throw new IpcError('COMPRA_SIN_PROVEEDOR', 400, 'La compra necesita un proveedor')
  }
  const pid = assertId(valor, 'proveedor')
  const proveedor = ctx.db
    .prepare('SELECT * FROM proveedores WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL')
    .get(pid, ctx.negocioId)
  if (!proveedor) {
    throw new IpcError('PROVEEDOR_NO_ENCONTRADO', 404, 'El proveedor no existe en este negocio')
  }
  if (proveedor.activo === 0) {
    throw new IpcError('PROVEEDOR_INACTIVO', 409, `El proveedor ${proveedor.nombre} está inactivo`)
  }
  return pid
}

/** The wording of the credit side, which is the sentence an accountant reads in the ledger. */
function pagoDescripcion(metodo) {
  if (metodo === 'efectivo') return 'Caja'
  if (metodo === 'tarjeta') return 'Banco'
  return 'Proveedores (Acreedores)'
}

/** snake_case row -> the camelCase shape the web's API returns, which is what a renderer expects. */
function mapCompra(row) {
  if (!row) return null
  return {
    id: row.id,
    folio: row.folio,
    fecha: row.fecha,
    subtotalCentavos: row.subtotal_centavos,
    ivaCentavos: row.iva_centavos,
    descuentoCentavos: row.descuento_centavos,
    totalCentavos: row.total_centavos,
    estado: row.estado,
    observaciones: row.observaciones,
    proveedorId: row.proveedor_id,
    proveedorNombre: row.proveedor_nombre ?? null,
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** A trimmed string, or `null` for absent and blank alike. */
function texto(valor) {
  if (valor === null || valor === undefined) return null
  const t = String(valor).trim()
  return t === '' ? null : t
}

/** A positive row id. A `null` or a 0 is a caller bug, and saying so beats `WHERE id = NULL`. */
function assertId(id, etiqueta) {
  const n = typeof id === 'string' ? Number(id) : id
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new IpcError('ID_INVALIDO', 400, `El id del ${etiqueta} debe ser un entero positivo`)
  }
  return n
}

/** `%`, `_` and `\` typed into a search box are LITERAL characters, not wildcards. */
function escaparLike(texto) {
  return String(texto).replace(/[\\%_]/g, (ch) => `\\${ch}`)
}
