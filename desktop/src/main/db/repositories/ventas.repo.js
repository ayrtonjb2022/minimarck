import { randomUUID } from 'node:crypto'
import { IpcError } from '../../bridge/errors.js'
import { assertCents, extractRate, toCents } from '../../../shared/money.js'
import { QtyError, assertMilli, lineTotalCentavos, toMilli } from '../../../shared/qty.js'
import { requireTenant } from '../seed.js'
import { asentar, asegurarPlan, CUENTA } from './cuentas.repo.js'
import { esViolacionUnicaEn } from '../errores-sqlite.js'
import { cajaActiva, registrarMovimiento } from './cajas.repo.js'

/**
 * Sales, and the stock they move (design §D.5; spec VENTA-1..9).
 *
 * Ported from `backend/src/controllers/venta.controller.js` with four deliberate changes, each
 * of which is a defect the web has and is recorded in `DIVERGENCES.md`:
 *
 *   1. QUANTITIES ARE THOUSANDTHS. The web's `ventas_detalles.cantidad` is an `INTEGER` and the
 *      POS sends a whole number, so 500 g of cheese is stored as 1 unit at a prorated price and
 *      the stock it left is whatever the scale said divided by 1000. The desktop stores
 *      `cantidad_milli` and takes the stock from the real weight. This is the whole reason the
 *      `qty.js` module exists.
 *
 *   2. A SALE WRITES A JOURNAL ENTRY. The web writes none, so a web shop has stock movements and
 *      no ledger.
 *
 *   3. THE DISCOUNT IS REFUSED, not stored. The web already refuses it ("Descuento aún no
 *      soportado") rather than saving a discount it never applies, which is the correct call and
 *      is kept verbatim. The schema HAS `descuento_centavos` on both tables, so the temptation to
 *      quietly write it is real; it stays 0.
 *
 *   4. THE TILL IS OPTIONAL FOR A CREDIT SALE AND REQUIRED TO BE OPEN FOR A CASH ONE, same as
 *      the web: a sale with no open till records no movement and no till total.
 *
 * ATOMICITY IS THE POINT OF THIS FILE. One `ctx.tx()` wraps the sale, its lines, every stock
 * decrement, the till movement, the till total, the journal entries and the audit row. There is
 * no path through it that writes some of them: the transaction either commits all of it or
 * rolls back all of it, including a stock decrement that already succeeded and a journal entry
 * that already balanced. `tests/db/ventas.spec.js` proves this with a real injected failure, not
 * a mock — a mock proves that the test's own `if (broken) throw` works.
 *
 * WHY THE STOCK GUARD IS IN THE `WHERE` CLAUSE AND NOT A `SELECT`:
 * `SELECT stock_milli` then compare then `UPDATE` is correct only when nothing else writes in
 * between, and "nothing else writes in between" is exactly what a cash register cannot promise —
 * two tills on one file, or a laptop lid closed mid-sale. `UPDATE ... WHERE stock_milli >= ?` is
 * decided by the database, inside the write lock `BEGIN IMMEDIATE` already holds, and reports
 * zero affected rows. A stock count can never go negative because the decrement that would have
 * made it negative never matched a row.
 */

/** The web validates payment methods before touching the database, and so does this. */
const METODOS = Object.freeze(['efectivo', 'tarjeta', 'transferencia', 'credito', 'mixto'])

/**
 * Which account RECEIVES the money, per payment method.
 *
 * Derived from the canonical plan and stated here rather than spread across call sites, because
 * the question "does a card sale debit the drawer?" is asked by every report and the answer has
 * to be one answer:
 *
 *   efectivo      -> 1.1.01 Caja                  the drawer the money is in
 *   tarjeta       -> 1.1.02 Banco                 card settlement, not cash on hand
 *   transferencia -> 1.1.02 Banco                 a bank credit, the same account
 *   credito       -> 1.3.01 Clientes (Deudores)   not money yet: a receivable on the customer
 *
 * `mixto` is absent because the web REFUSES it — `metodoPago === 'mixto'` returns 400 with
 * "requiere desglose efectivo/crédito, aún no soportado" — and the POS deliberately does not offer
 * it even though the model ENUM still contains it for compatibility. Following the live code
 * rather than the prose spec is the rule here; the spec's claim that a `mixto` sale "passes
 * validation" is a divergence, not a permission.
 */
const CUENTA_POR_METODO = Object.freeze({
  efectivo: CUENTA.CAJA,
  tarjeta: CUENTA.BANCO,
  transferencia: CUENTA.BANCO,
  credito: CUENTA.CLIENTES
})

/** `V-<uuid>`, 38 characters, inside the schema's `TEXT` for `folio`. The web's own format. */
function nuevoFolio() {
  return `V-${randomUUID()}`
}

/** snake_case row -> the camelCase shape the web's API returns, which is what a renderer expects. */
function mapVenta(row) {
  if (!row) return null
  return {
    id: row.id,
    folio: row.folio,
    fecha: row.fecha,
    subtotalCentavos: row.subtotal_centavos,
    ivaCentavos: row.iva_centavos,
    descuentoCentavos: row.descuento_centavos,
    totalCentavos: row.total_centavos,
    metodoPago: row.metodo_pago,
    estado: row.estado,
    clienteNombre: row.cliente_nombre,
    clienteDocumento: row.cliente_documento,
    observaciones: row.observaciones,
    userId: row.user_id,
    negocioId: row.negocio_id,
    cajaId: row.caja_id,
    deudorId: row.deudor_id,
    montoRecibidoCentavos: row.monto_recibido_centavos,
    montoCambioCentavos: row.monto_cambio_centavos,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapDetalle(row) {
  return {
    id: row.id,
    ventaId: row.venta_id,
    productoId: row.producto_id,
    // Thousandths, because 500 is 500 grams and the caller is told so by the name.
    cantidadMilli: row.cantidad_milli,
    precioUnitarioCentavos: row.precio_unitario_centavos,
    costoUnitarioCentavos: row.costo_unitario_centavos,
    nombreProducto: row.nombre_producto,
    descuentoCentavos: row.descuento_centavos,
    subtotalCentavos: row.subtotal_centavos,
    producto: row.producto_nombre ? { id: row.producto_id, nombre: row.producto_nombre, codigo: row.producto_codigo } : null
  }
}

const DETALLE_SELECT = `
  SELECT d.*, p.nombre AS producto_nombre, p.codigo AS producto_codigo
    FROM ventas_detalles d
    LEFT JOIN productos p ON p.id = d.producto_id
`

/**
 * Validate the request body. Everything that can be refused is refused BEFORE the transaction
 * opens, so a malformed ticket costs no write lock and, more importantly, so a refusal is
 * indistinguishable from a refusal on the web: same wording, same 400.
 */
function validar(body) {
  if (!body || typeof body !== 'object') {
    throw new IpcError('VENTA_CUERPO_INVALIDO', 400, 'La venta debe enviar un cuerpo de petición')
  }
  const { items, metodoPago = 'efectivo' } = body

  if (!Array.isArray(items) || items.length === 0) {
    throw new IpcError('VENTA_SIN_ITEMS', 400, 'La venta debe tener al menos un producto')
  }
  if (!METODOS.includes(metodoPago)) {
    throw new IpcError('VENTA_METODO_INVALIDO', 400, `Método de pago inválido: ${metodoPago}`)
  }
  // The web's own refusal, kept word for word: a `mixto` sale would need a cash/credit split
  // that nothing collects, so accepting it records a total with no story behind it.
  if (metodoPago === 'mixto') {
    throw new IpcError(
      'VENTA_MIXTO_NO_SOPORTADO',
      400,
      'Método mixto requiere desglose efectivo/crédito, aún no soportado'
    )
  }
  if (metodoPago === 'credito' && !body.clienteDeudorId) {
    // Without a debtor there is no debt, and a credit sale with no debt is an income hole.
    throw new IpcError('VENTA_CREDITO_SIN_DEUDOR', 400, 'Venta a crédito requiere deudor')
  }
  // A discount the code would store and never apply is worse than no discount: the customer is
  // charged full price against a document that says otherwise.
  if (body.descuento != null && !esCeroDescuento(body.descuento)) {
    throw new IpcError('VENTA_DESCUENTO_NO_SOPORTADO', 400, 'Descuento aún no soportado')
  }

  const lineas = items.map((item, i) => {
    if (item.descuento != null && !esCeroDescuento(item.descuento)) {
      throw new IpcError('VENTA_DESCUENTO_NO_SOPORTADO', 400, 'Descuento aún no soportado')
    }
    let cantidadMilli
    try {
      cantidadMilli = toMilli(item.cantidad, `items[${i}].cantidad`)
    } catch (err) {
      // A quantity the operator typed badly is THEIR input, and the message the POS already
      // shows for it is "Cantidad inválida". The QtyError detail is not lost — it is appended,
      // so the log keeps the reason and the operator keeps the words they know.
      if (err instanceof QtyError) {
        throw new IpcError('VENTA_CANTIDAD_INVALIDA', 400, `Cantidad inválida: ${err.message}`)
      }
      throw err
    }
    if (cantidadMilli < 1) {
      // The web's message for `cant < 1`, kept so the POS's "Cantidad inválida" still matches.
      throw new IpcError('VENTA_CANTIDAD_INVALIDA', 400, 'Cantidad inválida')
    }
    return {
      productoId: item.productoId == null ? null : Number(item.productoId),
      nombre: typeof item.nombre === 'string' && item.nombre.trim() !== '' ? item.nombre.trim() : null,
      cantidadMilli,
      precioUnitario: item.precioUnitario ?? null,
      costoUnitario: item.costoUnitario ?? null
    }
  })

  return { lineas, metodoPago, body }
}

/**
 * A blank, a zero, or an absent discount all mean "there is no discount to apply".
 *
 * The web uses `parseFloat(x) !== 0`, which throws on a blank string because `NaN !== 0`. That
 * is an accident of `parseFloat` and not a rule anyone chose, so a blank here is treated as
 * absent, which is what the operator meant. Every OTHER value that is not zero is a discount
 * the code would not apply, and is refused.
 */
function esCeroDescuento(valor) {
  if (valor === '' || valor === null || valor === undefined) return true
  const n = typeof valor === 'number' ? valor : Number(String(valor).trim().replace(',', '.'))
  return Number.isFinite(n) && n === 0
}

/**
 * Create a sale (VENTA-1..9). The whole of the business transaction.
 *
 * Everything below happens inside ONE `ctx.tx()`: the header, the lines, the stock decrements,
 * the till movement and total, the debtor note, the journal entries and the audit row. The
 * idempotency fast path is the only read that happens before it, and the only reason is to
 * answer a retry without taking a write lock.
 *
 * @returns `{ venta, duplicado, advertenciaLimite? }` — `duplicado: true` when this exact
 *          `idempotencyKey` had already been recorded, and NOTHING was written.
 */
export function crear(ctx, body) {
  requireTenant(ctx.negocioId)
  if (!ctx.actorId) {
    throw new IpcError('ACTOR_REQUERIDO', 401, 'La venta necesita un usuario en sesión')
  }
  const { lineas, metodoPago, body: req } = validar(body)
  const idempotencyKey =
    typeof req.idempotencyKey === 'string' && req.idempotencyKey.trim() !== ''
      ? req.idempotencyKey.trim().slice(0, 100)
      : null

  // A retry after a network failure must not sell twice. Checked before the transaction so the
  // common case costs no write lock, and the index below catches the case this check cannot see.
  if (idempotencyKey) {
    const previa = ctx.db
      .prepare('SELECT * FROM ventas WHERE negocio_id = ? AND idempotency_key = ?')
      .get(ctx.negocioId, idempotencyKey)
    if (previa) {
      return { venta: obtener(ctx.db, ctx.negocioId, previa.id), duplicado: true }
    }
  }

  const resultado = correrTransaccion(ctx, idempotencyKey, () => {
    // ---- products ---------------------------------------------------------------------
    // Read up front so a wrong id is "no encontrado" and not a stock failure, and so the
    // prorated price and the iva rate come from the product rather than from the request.
    const productos = new Map()
    for (const linea of lineas) {
      if (linea.productoId === null) continue
      if (productos.has(linea.productoId)) continue
      const p = ctx.db
        .prepare(
          `SELECT id, nombre, codigo, precio_centavos, precio_compra_centavos, stock_milli,
                  iva_porcentaje, unidad_medida, es_pesable, activo
             FROM productos
            WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL`
        )
        .get(linea.productoId, ctx.negocioId)
      if (!p) {
        throw new IpcError('VENTA_PRODUCTO_NO_ENCONTRADO', 400, `Producto con ID ${linea.productoId} no encontrado`)
      }
      if (!p.activo) {
        throw new IpcError('VENTA_PRODUCTO_INACTIVO', 400, `Producto con ID ${linea.productoId} está inactivo`)
      }
      productos.set(p.id, p)
    }

    // ---- prices, quantities, totals ---------------------------------------------------
    let subtotal = 0
    let iva = 0
    let costoTotal = 0
    const detalles = []

    for (const linea of lineas) {
      const producto = linea.productoId === null ? null : productos.get(linea.productoId)
      // A free-text POS line may name its own price and cost; a catalog line takes the product's
      // price, and the SALE-2 test exists because the web does exactly this.
      const precioUnitarioCentavos =
        linea.precioUnitario !== null
          ? assertCents(toCents(linea.precioUnitario, 'precioUnitario'), 'precioUnitario')
          : (producto?.precio_centavos ?? 0)
      const costoUnitarioCentavos =
        linea.costoUnitario !== null
          ? assertCents(toCents(linea.costoUnitario, 'costoUnitario'), 'costoUnitario')
          : (producto?.precio_compra_centavos ?? 0)

      // THE fractional line. A $2.000/kg product weighed at 500 g is `20000 * 500 / 1000` =
      // 10000 centavos, exact. The web cannot express this line at all.
      const subtotalLinea = lineTotalCentavos(precioUnitarioCentavos, linea.cantidadMilli, {
        label: linea.nombre ?? `producto ${linea.productoId}`
      })
      const costoLinea = lineTotalCentavos(costoUnitarioCentavos, linea.cantidadMilli, {
        label: `costo ${linea.nombre ?? `producto ${linea.productoId}`}`
      })

      // IVA is EXTRACTED, never added: the customer pays the shelf price. (MATH-6)
      const ivaLinea = extractRate(subtotalLinea, producto?.iva_porcentaje ?? 0, { label: 'IVA' })

      subtotal += subtotalLinea
      iva += ivaLinea
      costoTotal += costoLinea
      detalles.push({
        productoId: linea.productoId,
        nombreProducto: linea.nombre ?? producto?.nombre ?? 'Producto sin nombre',
        cantidadMilli: linea.cantidadMilli,
        precioUnitarioCentavos,
        costoUnitarioCentavos,
        subtotalCentavos: subtotalLinea,
        ivaCentavos: ivaLinea
      })
    }

    subtotal = assertCents(subtotal, 'subtotal')
    iva = assertCents(iva, 'IVA')
    costoTotal = assertCents(costoTotal, 'costo total')
    // The total is the subtotal, full stop. `iva` is carried for the receipt and the report, and
    // adding it here is the bug that charges the customer 21% over the shelf price.
    const total = subtotal

    // ---- cash taken and change given ---------------------------------------------------
    // Only a cash sale has both. The schema makes `monto_recibido_centavos` NULL for credit and
    // transfer, and that NULL is the difference between "no cash was involved" and "zero cash".
    // A zero or blank received amount is an ABSENT one — the web has no field at all, so the
    // only stories a received amount can tell are "cash came in" and "no amount was typed".
    let montoRecibido = null
    let montoCambio = null
    if (metodoPago === 'efectivo' && !esCeroDescuento(req.montoRecibido)) {
      montoRecibido = assertCents(toCents(req.montoRecibido, 'monto recibido'), 'monto recibido')
      if (montoRecibido < total) {
        throw new IpcError(
          'VENTA_MONTO_INSUFICIENTE',
          400,
          `El monto recibido (${montoRecibido}) es menor que el total (${total})`
        )
      }
      montoCambio = assertCents(montoRecibido - total, 'monto cambio')
    }

    // ---- the sale -----------------------------------------------------------------------
    const folio = nuevoFolio()
    const ts = new Date().toISOString()
    // No try/catch here on purpose. The idempotency race is caught by `correrTransaccion`
    // OUTSIDE the transaction, because inside it the only two honest options are to commit a
    // half-finished sale or to abort — and this INSERT failing means another connection already
    // committed the whole sale, so the right answer is "here is that sale", which requires the
    // transaction to be over before it can be read.
    const info = ctx.db
      .prepare(
        `INSERT INTO ventas
           (folio, fecha, subtotal_centavos, iva_centavos, descuento_centavos, total_centavos,
            metodo_pago, estado, cliente_nombre, cliente_documento, observaciones,
            user_id, negocio_id, deudor_id, monto_recibido_centavos, monto_cambio_centavos,
            idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, 'completada', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        folio,
        ts,
        subtotal,
        iva,
        total,
        metodoPago,
        req.clienteNombre ?? null,
        req.clienteDocumento ?? null,
        req.observaciones ?? null,
        ctx.actorId,
        ctx.negocioId,
        metodoPago === 'credito' ? Number(req.clienteDeudorId) : null,
        montoRecibido,
        montoCambio,
        idempotencyKey,
        ts,
        ts
      )
    const id = Number(info.lastInsertRowid)

    // ---- lines and stock ----------------------------------------------------------------
    const insDetalle = ctx.db.prepare(
      `INSERT INTO ventas_detalles
         (cantidad_milli, precio_unitario_centavos, costo_unitario_centavos, nombre_producto,
          descuento_centavos, subtotal_centavos, venta_id, producto_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
    )
    // `stock_milli >= cantidad` is the whole safety argument, and `cambios === 0` is how SQLite
    // says "no row matched". There is no read of the stock to go stale between check and write.
    const bajaStock = ctx.db.prepare(
      `UPDATE productos SET stock_milli = stock_milli - ?, updated_at = ?
        WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL AND stock_milli >= ?`
    )

    for (const d of detalles) {
      insDetalle.run(
        d.cantidadMilli,
        d.precioUnitarioCentavos,
        d.costoUnitarioCentavos,
        d.nombreProducto,
        d.subtotalCentavos,
        id,
        d.productoId,
        ts,
        ts
      )
      if (d.productoId === null) continue
      const res = bajaStock.run(d.cantidadMilli, ts, d.productoId, ctx.negocioId, d.cantidadMilli)
      if (res.changes === 0) {
        throw new IpcError(
          'STOCK_INSUFICIENTE',
          400,
          `Stock insuficiente para ${d.nombreProducto || `ID ${d.productoId}`}`
        )
      }
    }

    // ---- credit sale: the debtor --------------------------------------------------------
    // NO balance is written here, and the reason is in the schema: `clientes_deudores` has no
    // `deuda_total` / `deuda_pendiente` column on purpose, because a cached balance is a number
    // nothing recomputes. The receivable is real and it IS recorded — as the 1.3.01 debit in the
    // journal below. What is not written is the per-debtor aging line in
    // `cuentas_corrientes_deudas`, which is a different module's table.
    let advertenciaLimite = null
    if (metodoPago === 'credito' && req.clienteDeudorId != null) {
      const deudor = ctx.db
        .prepare('SELECT * FROM clientes_deudores WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL')
        .get(Number(req.clienteDeudorId), ctx.negocioId)
      if (!deudor) {
        throw new IpcError('VENTA_DEUDOR_NO_ENCONTRADO', 400, 'Deudor no encontrado')
      }
      const detalleTexto = [
        `[${ts.slice(0, 10)}] Venta ${folio} - Total: ${total} centavos`,
        ...detalles.map((d) => `${d.cantidadMilli} x ${d.nombreProducto} = ${d.subtotalCentavos} centavos`)
      ].join('\n')
      ctx.db
        .prepare('UPDATE clientes_deudores SET notas = ?, updated_at = ? WHERE id = ?')
        .run(`${deudor.notas ? deudor.notas + '\n\n' : ''}${detalleTexto}`, ts, deudor.id)

      // THE LIMIT IS A CEILING ON THE RESULTING DEBT, so the comparison has to include what the
      // debtor ALREADY owes. `DIVERGENCES.md` §7 recorded this as an unfixable fidelity loss —
      // "the warning compares `total > limite` alone", because at the time there was no way to
      // read a per-debtor balance. There is now: `v_clientes_deudores` derives it.
      //
      // That matters because a warning that cannot see the balance is a warning that is WRONG in
      // the direction that costs money: a customer already $90.000 deep on a $100.000 limit buys
      // a $2.000 ticket, `total > limite` is false, and nothing is said — while a $90.000 deep
      // customer who buys $15.000 is allowed through with a warning, which teaches the cashier
      // the warning is noise.
      //
      // READ WHERE IT IS, AND THAT DECIDES THE ARITHMETIC. This block sits AFTER the
      // `INSERT INTO ventas` above, and the view sums `ventas WHERE metodo_pago = 'credito' AND
      // estado <> 'cancelada'` — so the row that was just inserted is ALREADY inside the number
      // this read returns. The figure below is therefore the RESULTING debt, not the previous
      // one, and adding `total` to it would count this ticket twice: a customer on a $100.000
      // limit buying $15.000 with $90.000 already owed would be warned about $120.000, and a
      // cashier would learn to ignore it. The first version of this check did exactly that.
      //
      // It is the same comparison the POS makes on screen (`deudaPendienteCentavos + totalCentavos
      // > limite`, `puntoDeVenta.jsx:134-135`) and the same one the web does
      // (`nuevaDeuda = deudaPendiente + total > limiteCredito`, `venta.controller.js:289-292`) —
      // the renderer's `total` and this function's post-insert `pendiente` are the same number
      // reached from two sides, so the warning on screen and the warning in the response cannot
      // disagree. The previous debt is reported as `proyectado - total` so the operator still sees
      // both figures.
      const saldo = ctx.db
        .prepare('SELECT deuda_pendiente_centavos FROM v_clientes_deudores WHERE id = ?')
        .get(deudor.id)
      const proyectado = saldo?.deuda_pendiente_centavos ?? 0
      if (deudor.limite_credito_centavos != null && proyectado > deudor.limite_credito_centavos) {
        advertenciaLimite =
          `Atención: la venta supera el límite de crédito configurado ` +
          `(${deudor.limite_credito_centavos} centavos). ` +
          `Deuda actual: ${proyectado - total}; con esta venta: ${proyectado}.`
      }
    }

    // ---- the till -----------------------------------------------------------------------
    // A credit sale moves no cash, so it gets no till movement and no till total. Same as the web.
    const caja = metodoPago === 'credito' ? null : cajaActiva(ctx.db, ctx.negocioId)

    // A CASH sale with no till open has to be refused, and it has to be refused HERE. It used to
    // fall through the `if (caja)` below: the header, the lines, the stock decrements and the
    // ledger all committed, `ventas.caja_id` stayed NULL, and no `movimientos_caja` row was ever
    // written. Nothing threw. The sale existed, the goods were gone, and the money was in
    // nobody's drawer — the exact balance the till is supposed to prove. The cashier's own
    // check on the POS screen is a courtesy, not a lock: the window between "checked" and
    // "committed" is where a closed till becomes a hole in the cash count, and anything that
    // can be reached by another caller would walk straight through a renderer-only guard.
    // 409, not 400: the request is well-formed, the STATE it needs is the thing that is wrong.
    if (metodoPago !== 'credito' && !caja) {
      throw new IpcError(
        'CAJA_ABIERTA_REQUERIDA',
        409,
        'No hay caja abierta. Abrí una caja antes de vender.'
      )
    }

    if (caja) {
      registrarMovimiento(ctx, {
        caja,
        tipo: 'ingreso',
        concepto: `Venta ${folio}`,
        montoCentavos: total,
        origen: 'venta',
        referencia: folio,
        ventaId: id
      })
      ctx.db.prepare('UPDATE ventas SET caja_id = ? WHERE id = ?').run(caja.id, id)
    }

    // ---- the ledger ---------------------------------------------------------------------
    const cuentas = asegurarPlan(ctx)
    asentarVenta(ctx, { id, folio, total, costoTotal, metodoPago, fecha: ts, cuentas })

    // ---- the audit trail ------------------------------------------------------------------
    // The web has an `auditoria` table and never writes to it. A sale that moves stock and money
    // is written down before it is written to `auditoria`; a sale with no trail can be neither
    // reconciled nor explained.
    ctx.db
      .prepare(
        `INSERT INTO auditoria (tabla, registro_id, accion, valores_anteriores, valores_nuevos, user_id, negocio_id, created_at, updated_at)
         VALUES ('ventas', ?, 'CREATE', NULL, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        JSON.stringify({ folio, totalCentavos: total, metodoPago, cajaId: caja?.id ?? null, lineas: detalles.length }),
        ctx.actorId,
        ctx.negocioId,
        ts,
        ts
      )

    return { id, advertenciaLimite }
  })

  if (resultado.duplicado) {
    return { venta: obtener(ctx.db, ctx.negocioId, resultado.id), duplicado: true }
  }
  return {
    venta: obtener(ctx.db, ctx.negocioId, resultado.id),
    duplicado: false,
    ...(resultado.advertenciaLimite ? { advertenciaLimite: resultado.advertenciaLimite } : {})
  }
}

/**
 * Run the sale transaction, and translate the ONE failure that is not a failure.
 *
 * `ux_ventas_idempotencia` firing means a concurrent request with the same key committed first.
 * The transaction rolls back — it wrote nothing, which is the entire point of doing the whole sale
 * in one transaction — and the caller gets the winner's sale with `duplicado: true`, exactly what
 * the pre-flight SELECT above would have returned had it looked a microsecond later. The web does
 * the same thing (`esDuplicadoIdempotencia` in `venta.controller.js:20-42`) and turns every OTHER
 * unique violation into a 500, which is right: a duplicate folio is a bug, a duplicate key is a
 * retry.
 *
 * The check is on the COLUMNS of the index, not on the word "duplicate" in the message, because
 * the message is SQLite's wording and wording is not an API — and not on the INDEX NAME either,
 * which is what this used to do. SQLite names the columns a UNIQUE INDEX covers and never the index
 * itself: the message is "UNIQUE constraint failed: ventas.negocio_id, ventas.idempotency_key" and
 * `ux_ventas_idempotencia` appears nowhere in it. So the guard matched nothing, and the one path it
 * exists for — two writers racing on the same key, where the pre-flight SELECT above could not see
 * the winner — fell through as a raw SQLite error to the operator. The race is rare; the stock it
 * can move twice is not.
 */
function correrTransaccion(ctx, idempotencyKey, fn) {
  try {
    return ctx.tx(fn)
  } catch (err) {
    const esClaveRepetida =
      idempotencyKey !== null &&
      esViolacionUnicaEn(err, 'ventas.idempotency_key', 'ventas.negocio_id')
    if (esClaveRepetida) {
      // Re-read by the key that failed. There is exactly one row per key, so this is THE
      // competing sale, and it is a committed sale that already moved its own stock.
      const ganadora = ctx.db
        .prepare('SELECT * FROM ventas WHERE negocio_id = ? AND idempotency_key = ?')
        .get(ctx.negocioId, idempotencyKey)
      if (ganadora) {
        return { id: ganadora.id, duplicado: true }
      }
    }
    throw err
  }
}

/**
 * The two entries a sale posts, mirroring `backend/seed-contabilidad.js` entries 12a and 12b.
 *
 * TWO entries and not one, on purpose. They are separate economic facts with different dates and
 * different accounts: revenue recognises what the customer owes, cost recognises what the shop
 * gave up. Collapsing them into one four-line entry would make the gross margin of a single sale
 * impossible to read, because a margin is a difference between two entries.
 *
 * IVA is NOT split out. The canonical plan has no asset account for tax owed TO the authority —
 * it has `2.3.01 Impuestos a Pagar`, a liability that arises when the tax is declared, not when
 * it is charged — and inventing one to hold a number the shop is not yet remitting would put a
 * balance on the balance sheet that no filing supports. So the entry is at gross and `iva` rides
 * on the sale for the receipt. This is the conservative choice and it is recorded.
 */
function asentarVenta(ctx, { id, folio, total, costoTotal, metodoPago, fecha, cuentas }) {
  const recibe = CUENTA_POR_METODO[metodoPago]
  const recibeId = cuentas.get(recibe).id

  asentar(ctx, {
    fecha,
    descripcion: `Venta ${folio}`,
    tipo: 'ingreso',
    referencia: `venta:${id}`,
    partidas: [
      { cuentaId: recibeId, debeCentavos: total, haberCentavos: 0, descripcion: `Cobro ${metodoPago}` },
      { cuentaId: cuentas.get(CUENTA.VENTAS).id, debeCentavos: 0, haberCentavos: total, descripcion: `Ventas ${folio}` }
    ]
  })

  asentar(ctx, {
    fecha,
    descripcion: `Costo de mercadería vendida - ${folio}`,
    tipo: 'egreso',
    referencia: `venta:${id}`,
    partidas: [
      { cuentaId: cuentas.get(CUENTA.CMV).id, debeCentavos: costoTotal, haberCentavos: 0, descripcion: `CMV ${folio}` },
      { cuentaId: cuentas.get(CUENTA.MERCADERIAS).id, debeCentavos: 0, haberCentavos: costoTotal, descripcion: `Mercaderías ${folio}` }
    ]
  })
}

/**
 * Cancel a sale and put the stock back.
 *
 * REACHABLE FROM THE RENDERER, through `ventas.cancel`. The web's API did not have it — the web
 * `ventasAPI` and its controller stop at `create`, `getAll` and `getById` — so this contract is
 * one operation ahead of the API it mirrors. It was written and tested first as a data-layer
 * capability and stayed unreachable until the sales list grew a button that needed it; counting
 * operations in the design as more important than a cashier being able to undo a mistake was the
 * wrong call, and the count moved rather than the capability.
 *
 * WHAT IT DOES, in one transaction:
 *
 *   - returns every `cantidad_milli` to the product it came from, for the products that still
 *     exist. A product deleted in the meantime is skipped, not an error: the stock it held is
 *     gone either way and the line keeps pointing at nothing.
 *   - records the cash going back out as an `egreso` movement, and moves `total_ingresos` down
 *     and `total_egresos` up, so the till's derived balance is the drawer again.
 *   - posts the MIRROR of the sale's two entries. Not negative amounts: the same magnitudes on
 *     the other side. A reversal entry with negative values is arithmetically fine and is how a
 *     ledger that a human has to read stops being readable.
 *   - leaves the sale itself in place with `estado = 'cancelada'`. It is a receipt, not a lie.
 *   - writes an `UPDATE` audit row carrying the previous state.
 *
 * Returns `{ venta, movimientosStock }` so a caller can see exactly what came back.
 */
export function cancelar(ctx, id, { motivo = null } = {}) {
  requireTenant(ctx.negocioId)
  const ventaId = Number(id)
  if (!Number.isSafeInteger(ventaId) || ventaId < 1) {
    throw new IpcError('VENTA_ID_INVALIDO', 400, `Id de venta inválido: ${id}`)
  }

  return ctx.tx(() => {
    const venta = ctx.db
      .prepare('SELECT * FROM ventas WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL')
      .get(ventaId, ctx.negocioId)
    if (!venta) {
      throw new IpcError('VENTA_NO_ENCONTRADA', 404, 'Venta no encontrada')
    }
    if (venta.estado === 'cancelada') {
      // Cancelling twice would return the stock twice, and the second return is invisible: the
      // count looks plausible and is wrong by exactly the sale.
      throw new IpcError('VENTA_YA_CANCELADA', 400, 'Esta venta ya está cancelada')
    }

    const ts = new Date().toISOString()
    const detalles = ctx.db
      .prepare('SELECT * FROM ventas_detalles WHERE venta_id = ?')
      .all(ventaId)

    // ---- stock back ---------------------------------------------------------------------
    const devolverStock = ctx.db.prepare(
      `UPDATE productos SET stock_milli = stock_milli + ?, updated_at = ?
        WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL`
    )
    const movimientosStock = []
    for (const d of detalles) {
      if (d.producto_id === null) continue
      const res = devolverStock.run(assertMilli(d.cantidad_milli, 'cantidad'), ts, d.producto_id, ctx.negocioId)
      if (res.changes === 1) {
        movimientosStock.push({ productoId: d.producto_id, cantidadMilli: d.cantidad_milli })
      }
    }

    // ---- the drawer ---------------------------------------------------------------------
    if (venta.caja_id !== null) {
      const caja = ctx.db.prepare('SELECT * FROM cajas WHERE id = ?').get(venta.caja_id)
      if (caja && caja.estado === 'abierta') {
        registrarMovimiento(ctx, {
          caja,
          tipo: 'egreso',
          concepto: `Anulación venta ${venta.folio}`,
          montoCentavos: venta.total_centavos,
          origen: 'venta',
          referencia: venta.folio,
          ventaId: venta.id
        })
        // `total_ingresos` is deliberately NOT touched, and the reason is the one rule that keeps
        // a drawer readable: the till's totals are the SUM of its movement rows, so a reversal is
        // a NEW movement and never an edit of the old one. The sale's `ingreso` row is still in
        // `movimientos_caja`; if the total stopped counting it, the totals would stop equalling
        // the sum and `saldoCaja()` would no longer match the last movement's `saldo_nuevo`.
        // Both totals still count both movements, so the drawer's balance comes back to exactly
        // where it was before the sale, which is the true answer.
      }
    }

    // ---- the ledger, mirrored ------------------------------------------------------------
    const costoTotal = detalles.reduce(
      (s, d) => s + lineTotalCentavos(d.costo_unitario_centavos, d.cantidad_milli, { label: `costo ${d.nombre_producto}` }),
      0
    )
    const cuentas = asegurarPlan(ctx)
    asentar(ctx, {
      fecha: ts,
      descripcion: `Anulación venta ${venta.folio}`,
      tipo: 'ajuste',
      referencia: `venta:${venta.id}`,
      partidas: [
        { cuentaId: cuentas.get(CUENTA.VENTAS).id, debeCentavos: venta.total_centavos, haberCentavos: 0, descripcion: `Reversa ventas ${venta.folio}` },
        { cuentaId: cuentas.get(CUENTA_POR_METODO[venta.metodo_pago]).id, debeCentavos: 0, haberCentavos: venta.total_centavos, descripcion: `Devolución ${venta.metodo_pago}` }
      ]
    })
    asentar(ctx, {
      fecha: ts,
      descripcion: `Reversa costo de mercadería - ${venta.folio}`,
      tipo: 'ajuste',
      referencia: `venta:${venta.id}`,
      partidas: [
        { cuentaId: cuentas.get(CUENTA.MERCADERIAS).id, debeCentavos: costoTotal, haberCentavos: 0, descripcion: `Reversa CMV ${venta.folio}` },
        { cuentaId: cuentas.get(CUENTA.CMV).id, debeCentavos: 0, haberCentavos: costoTotal, descripcion: `Reversa mercaderías ${venta.folio}` }
      ]
    })

    // ---- the state, and the trail --------------------------------------------------------
    const nota = motivo ? `${venta.observaciones ? venta.observaciones + '\n' : ''}ANULADA: ${motivo}` : venta.observaciones
    ctx.db
      .prepare(`UPDATE ventas SET estado = 'cancelada', observaciones = ?, updated_at = ? WHERE id = ?`)
      .run(nota, ts, ventaId)

    ctx.db
      .prepare(
        `INSERT INTO auditoria (tabla, registro_id, accion, valores_anteriores, valores_nuevos, user_id, negocio_id, created_at, updated_at)
         VALUES ('ventas', ?, 'UPDATE', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ventaId,
        JSON.stringify({ estado: venta.estado, totalCentavos: venta.total_centavos }),
        JSON.stringify({ estado: 'cancelada', motivo: motivo ?? null }),
        ctx.actorId,
        ctx.negocioId,
        ts,
        ts
      )

    return { venta: mapVenta(ctx.db.prepare('SELECT * FROM ventas WHERE id = ?').get(ventaId)), movimientosStock }
  })
}

/** One sale with its lines. Scoped by business, so another tenant's id is a 404, not a 200. */
export function obtener(db, negocioId, id) {
  const ventaId = Number(id)
  if (!Number.isSafeInteger(ventaId) || ventaId < 1) {
    throw new IpcError('VENTA_ID_INVALIDO', 400, `Id de venta inválido: ${id}`)
  }
  const row = db
    .prepare('SELECT * FROM ventas WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL')
    .get(ventaId, negocioId)
  if (!row) {
    throw new IpcError('VENTA_NO_ENCONTRADA', 404, 'Venta no encontrada')
  }
  return { ...mapVenta(row), detalles: db.prepare(`${DETALLE_SELECT} WHERE d.venta_id = ? ORDER BY d.id`).all(ventaId).map(mapDetalle) }
}

/** Newest first. `estado` and a date range are the web's filters; both are optional. */
export function listar(db, negocioId, { limit = 20, offset = 0, estado = null, desde = null, hasta = null } = {}) {
  const cond = ['negocio_id = ?', 'deleted_at IS NULL']
  const args = [negocioId]
  if (estado) {
    cond.push('estado = ?')
    args.push(estado)
  }
  if (desde) {
    cond.push('fecha >= ?')
    args.push(desde)
  }
  if (hasta) {
    cond.push('fecha <= ?')
    args.push(hasta)
  }
  const where = cond.join(' AND ')
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ventas WHERE ${where}`).get(...args).n
  const filas = db
    .prepare(`SELECT * FROM ventas WHERE ${where} ORDER BY fecha DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset)
  return { filas: filas.map(mapVenta), total }
}
