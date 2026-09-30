import { IpcError } from '../../bridge/errors.js'
import { assertCents, formatCents, toCents } from '../../../shared/money.js'
import { requireTenant } from '../seed.js'
import { asentar, asegurarPlan, CUENTA } from './cuentas.repo.js'
import { cajaActiva, registrarMovimiento } from './cajas.repo.js'
import { esViolacionUnicaEn } from '../errores-sqlite.js'

/**
 * Debtors — the customers a credit sale can be billed to.
 *
 * FOUR OF SEVEN. `list`, `create`, `payments` and `addPayment`. `get`, `update` and `remove` are
 * contract members with no handler in this build, so the registry answers 501 for them — the
 * same honest answer every other unimplemented operation gives.
 *
 * WHY `list` AND `create` ARE ENOUGH FOR A SALE. `ventas.repo.js` refuses a `credito` sale with
 * no `clienteDeudorId` (`VENTA_CREDITO_SIN_DEUDOR`), which is the right call: a credit sale with
 * no debtor is an income hole, because nothing anywhere records who owes what. The POS's payment
 * modal therefore needs to be able to LIST debtors before it can offer "Crédito" at all, and
 * listing is what this file provides. `create` is here for the same reason: a credit sale needs
 * someone to bill, and the first-run seed deliberately does not invent demo customers.
 *
 * WHY `addPayment` IS THE HEAVY ONE. Recording a payment is not a row in a second table — it is
 * three facts that have to agree: the debtor owes less, the money is somewhere, and the ledger
 * says both. It gets its own journal entry, its own drawer movement when the money is cash, and
 * it leaves the balance to the view. It is the operation that makes a credit sale a loan rather
 * than an unpaid ticket.
 *
 * THE BALANCE IS READ FROM THE VIEW, NEVER COMPUTED HERE.
 *
 * `v_clientes_deudores` exists precisely so that `deuda_total` and `deuda_pendiente` cannot rot:
 * `001_init.sql` §4 records that the web maintained both by hand, in two controllers, so every
 * write path that forgot a step left a balance lying with no error anywhere. Recomputing the same
 * two numbers here would recreate the second copy of that invariant, and a second copy is the
 * bug. It also means this file cannot be wrong about a balance: it has no arithmetic in it.
 *
 * The clamp at zero in the view is load-bearing and is documented there — a payment can outlive
 * the sale that created the debt, and an unclamped subtraction yields a negative invoice.
 *
 * `addPayment` writes NOTHING to `clientes_deudores` for the same reason. It inserts the payment
 * and the ledger entries; the new balance is whatever the view says on the next read. A payment
 * that also decremented a stored column would be the second copy of the invariant, and the two
 * copies would disagree the first time a credit sale was cancelled.
 */
function mapDeudor(row) {
  if (!row) return null
  return {
    id: row.id,
    nombre: row.nombre,
    documento: row.documento,
    telefono: row.telefono,
    email: row.email,
    direccion: row.direccion,
    limiteCreditoCentavos: row.limite_credito_centavos,
    notas: row.notas,
    userId: row.user_id,
    negocioId: row.negocio_id,
    activo: Boolean(row.activo),
    deudaTotalCentavos: row.deuda_total_centavos,
    deudaPendienteCentavos: row.deuda_pendiente_centavos,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** Escape `LIKE` wildcards so a name containing `%` is searched literally. */
function escaparLike(texto) {
  return texto.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/**
 * Refuse a negative credit limit, for the reason spelled out in `productos.repo.js`:
 * `toCents` parses negatives on purpose (a ledger has legitimate ones) and `toIpcError` cannot
 * recognise `SQLITE_CONSTRAINT_CHECK`, so a schema CHECK firing is a 500 for something a human
 * typed. `null` passes through — "no limit" is a real and common setting.
 */
function assertLimite(valor) {
  if (valor < 0) {
    throw new IpcError('DEUDOR_LIMITE_NEGATIVO', 400, `El límite de crédito no puede ser negativo: ${formatCents(valor)}`)
  }
  return valor
}

/**
 * Debtors, filtered by name or document, with their live balances.
 *
 * `conDeuda` narrows to the ones that actually owe something — the list a shop calls "debtors"
 * rather than "customers", and the default the notifications panel wants. It is opt-in so the POS
 * picker can also show a customer with a clean slate.
 */
export function listar(ctx, { search = '', conDeuda = false, limit = 50, offset = 0 } = {}) {
  requireTenant(ctx.negocioId)
  const cond = ['d.negocio_id = ?', 'd.deleted_at IS NULL', 'd.activo = 1']
  const args = [ctx.negocioId]
  const q = search === null || search === undefined ? '' : String(search).trim()
  if (q !== '') {
    cond.push("(d.nombre LIKE ? ESCAPE '\\' OR (d.documento IS NOT NULL AND d.documento LIKE ? ESCAPE '\\'))")
    const patron = `%${escaparLike(q.toLowerCase())}%`
    args.push(patron, patron)
  }
  if (conDeuda) cond.push('v.deuda_pendiente_centavos > 0')
  const where = cond.join(' AND ')

  const total = ctx.db
    .prepare(`SELECT COUNT(*) AS n FROM clientes_deudores d
              LEFT JOIN v_clientes_deudores v ON v.id = d.id
             WHERE ${where}`)
    .get(...args).n
  const filas = ctx.db
    .prepare(
      `SELECT d.*, v.deuda_total_centavos, v.deuda_pendiente_centavos
         FROM clientes_deudores d
         LEFT JOIN v_clientes_deudores v ON v.id = d.id
        WHERE ${where}
        ORDER BY d.nombre COLLATE NOCASE ASC, d.id ASC
        LIMIT ? OFFSET ?`
    )
    .all(...args, limit, offset)
  return { filas: filas.map(mapDeudor), total }
}

/**
 * Create a debtor. Not reachable from the POS in this build, and kept here because a credit sale
 * needs someone to bill and the seed deliberately does not invent demo customers.
 *
 * `deuda_total` / `deuda_pendiente` are ABSENT from the INSERT on purpose: those columns do not
 * exist on the table. They are computed by the view, and a row that carried a stored balance is
 * the defect `001_init.sql` §4 was written to remove.
 */
export function crear(ctx, body) {
  requireTenant(ctx.negocioId)
  if (!ctx.actorId) {
    throw new IpcError('ACTOR_REQUERIDO', 401, 'La operación necesita un usuario en sesión')
  }
  if (!body || typeof body !== 'object') {
    throw new IpcError('DEUDOR_CUERPO_INVALIDO', 400, 'El deudor debe enviar un cuerpo de petición')
  }
  const nombre = body.nombre === null || body.nombre === undefined ? '' : String(body.nombre).trim()
  if (nombre === '') {
    throw new IpcError('DEUDOR_NOMBRE_REQUERIDO', 400, 'El deudor necesita un nombre')
  }
  const documento = body.documento === null || body.documento === undefined || String(body.documento).trim() === ''
    ? null
    : String(body.documento).trim()
  const limiteCreditoCentavos = body.limiteCredito === undefined || body.limiteCredito === null || body.limiteCredito === ''
    ? null
    : assertLimite(assertCents(toCents(body.limiteCredito, 'límite de crédito'), 'límite de crédito'))
  const texto = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim())
  const ts = new Date().toISOString()

  return ctx.tx(() => {
    let info
    try {
      info = ctx.db
        .prepare(
          `INSERT INTO clientes_deudores
             (nombre, documento, telefono, email, direccion, limite_credito_centavos, notas, user_id, negocio_id, activo, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .run(
          nombre,
          documento,
          texto(body.telefono),
          texto(body.email),
          texto(body.direccion),
          limiteCreditoCentavos,
          texto(body.notas),
          ctx.actorId,
          ctx.negocioId,
          ts,
          ts
        )
    } catch (err) {
      // Matched on the COLUMNS. SQLite's message for a UNIQUE INDEX is the list of columns the
      // index covers — "UNIQUE constraint failed: clientes_deudores.documento,
      // clientes_deudores.negocio_id" — and the index name `ux_clientes_deudores_documento`
      // appears NOWHERE in it. A guard that matched the index name therefore matched nothing, and
      // a duplicate document escaped as an untranslated SQLite error: no code, no status, and a
      // sentence naming a table to a cashier standing at a form. The original code here had exactly
      // that bug; this test is what found it.
      //
      // BOTH columns because the index is on `(documento, negocio_id)`: a document is unique
      // WITHIN a shop, so the pair is the fingerprint rather than the document alone.
      if (esViolacionUnicaEn(err, 'clientes_deudores.documento', 'clientes_deudores.negocio_id')) {
        throw new IpcError('DEUDOR_DOCUMENTO_DUPLICADO', 400, `El documento "${documento}" ya existe en esta tienda`)
      }
      throw err
    }
    const id = Number(info.lastInsertRowid)
    ctx.db
      .prepare(
        `INSERT INTO auditoria (tabla, registro_id, accion, valores_anteriores, valores_nuevos, user_id, negocio_id, created_at, updated_at)
         VALUES ('clientes_deudores', ?, 'CREATE', NULL, ?, ?, ?, ?, ?)`
      )
      .run(id, JSON.stringify({ nombre, documento }), ctx.actorId, ctx.negocioId, ts, ts)
    return mapDeudor(
      ctx.db
        .prepare(
          `SELECT d.*, v.deuda_total_centavos, v.deuda_pendiente_centavos
             FROM clientes_deudores d
             LEFT JOIN v_clientes_deudores v ON v.id = d.id
            WHERE d.id = ?`
        )
        .get(id)
    )
  })
}

/**
 * The payments recorded against one debtor's debt, newest first.
 *
 * READ-ONLY, and the reason it exists is the payment receipt. `BoletaPago` printed a hardcoded
 * `$0.00` for the outstanding balance and a `✓ DEUDA PAGADA` banner that was rendered
 * unconditionally, so a debtor who owed the shop money was handed a receipt saying the debt was
 * settled. A receipt that says the wrong thing is worse than no receipt: it is a document people
 * keep.
 *
 * WHY THE RENDERER STILL DOES NOT ADD UP THE COLUMN. The pending balance on the receipt is
 * `deudor.deudaPendienteCentavos`, which comes from `v_clientes_deudores` — the single copy of
 * that invariant. This list is the human-readable history next to it, not a second source for
 * the number. An earlier version of the component summed these rows with `parseFloat` and
 * compared the total against the debt; over pesos that sum drifts, and a receipt that computes
 * its own balance can disagree with the ledger while looking perfectly normal. The view is the
 * balance; this is the story of how it got there.
 *
 * `addPayment` is what makes this list a history rather than an empty page: the receipt prints the
 * rows, and the balance printed beside them is the view's.
 */
export function pagos(ctx, deudorId) {
  requireTenant(ctx.negocioId)
  const id = Number(deudorId)
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new IpcError('DEUDOR_ID_INVALIDO', 400, `Id de deudor inválido: ${deudorId}`)
  }

  // Scoped by `negocio_id` as well as `deudor_id`. The debtor id alone is enough to find the row
  // (it is a global autoincrement), but a payment list that could be read across tenants is a
  // data leak, and the fix costs one predicate.
  const filas = ctx.db
    .prepare(
      `SELECT id, monto_centavos, fecha, metodo_pago, referencia, observaciones, venta_id
         FROM pagos_deuda
        WHERE deudor_id = ? AND negocio_id = ?
        ORDER BY fecha DESC, id DESC`
    )
    .all(id, ctx.negocioId)

  return {
    deudorId: id,
    pagos: filas.map((p) => ({
      id: p.id,
      montoCentavos: p.monto_centavos,
      fecha: p.fecha,
      metodoPago: p.metodo_pago,
      referencia: p.referencia,
      observaciones: p.observaciones,
      ventaId: p.venta_id
    }))
  }
}

/**
 * Payment methods a PAYMENT can carry, which is NOT the list a sale can carry.
 *
 * `pagos_deuda`'s own CHECK is `('efectivo','tarjeta','transferencia','mixto')` — it has no
 * `'credito'`, because a payment that is itself on credit is not a payment, and the schema's note
 * says so. `ventas.metodo_pago` is the other list, and the two are deliberately different
 * (divergence B7).
 *
 * `mixto` IS IN THE LIST AND IS STILL REFUSED, and that deserves the argument rather than a
 * shrug: the web ACCEPTS it (`metodosPermitidos` in `deudor.controller.js:291-296`) — but the web
 * writes no journal entry and no drawer movement for a payment, so the web never has to say where
 * a mixed payment's money went. This port does, and the honest answer needs the effective/cash
 * split that nothing collects: the POS has no field for it and the schema has no column for it.
 * Writing a single entry for `mixto` would have to claim the whole amount arrived in one place
 * that is not the truth — the same lie `asentar` refuses when one line is non-zero on both sides.
 * So the method is refused here, in the words `ventas.repo.js` already uses for the same reason,
 * and it is recorded in `DIVERGENCES.md`. The UI never offers it: this is a refusal of an input a
 * hand-written payload could produce, not a button a cashier can press.
 */
const METODOS_PAGO_PAGO = Object.freeze(['efectivo', 'tarjeta', 'transferencia'])

/**
 * Where the money physically IS when it arrives, per method.
 *
 * The same table, and the same question, as `ventas.repo.js#CUENTA_POR_METODO`: "does this event
 * put money in the drawer?" has to have one answer in this codebase, and the two files agreeing
 * is the point.
 *
 *   efectivo      -> 1.1.01 Caja       the drawer the money is physically in, and it MOVES
 *   tarjeta       -> 1.1.02 Banco      card settlement, a bank claim, and it does NOT move
 *   transferencia -> 1.1.02 Banco      a bank credit, the same account
 *
 * A CARD PAYMENT MUST NOT TOUCH THE DRAWER, and this table is where that is decided. The sale
 * path has the identical rule and the identical reason: the till's cash-on-hand is what a cashier
 * counts at close, and a claim on a bank account counted as cash is a drawer that can never be
 * reconciled. The journal entry is posted either way — a debt really was collected — but only
 * `efectivo` writes a `movimientos_caja` row and moves `total_ingresos`.
 */
const CUENTA_POR_METODO_PAGO = Object.freeze({
  efectivo: CUENTA.CAJA,
  tarjeta: CUENTA.BANCO,
  transferencia: CUENTA.BANCO
})

/** One debtor with the VIEW's live balances, in the shape `listar` returns. */
function leerConSaldos(db, negocioId, id) {
  return mapDeudor(
    db
      .prepare(
        `SELECT d.*, v.deuda_total_centavos, v.deuda_pendiente_centavos
           FROM clientes_deudores d
           LEFT JOIN v_clientes_deudores v ON v.id = d.id
          WHERE d.id = ? AND d.negocio_id = ? AND d.deleted_at IS NULL`
      )
      .get(id, negocioId)
  )
}

/**
 * Record a payment against a debtor's debt (DEBT-6, DEBT-7; contract `deudores.addPayment`).
 *
 * WHAT HAPPENS, in one `ctx.tx()`:
 *
 *   1. The debtor is read through the VIEW, so the balance being reduced is the same number the
 *      receipt prints — not a stored column, and not this function's arithmetic.
 *   2. `pagos_deuda` gets the row. That is the only place the money is written down.
 *   3. The journal gets ONE entry: debit the account the money arrived in, credit `1.3.01
 *      Clientes (Deudores)`. The credit is the half that makes the debt smaller, and it is why
 *      the receivable account's balance is the sum of everything this shop is owed rather than a
 *      number somebody maintains.
 *   4. `efectivo` and ONLY `efectivo` writes a `movimientos_caja` row and moves
 *      `total_ingresos`. A card or a transfer is money that went to a bank, not to the drawer.
 *   5. `auditoria` gets the CREATE row.
 *
 * THE BALANCE IS NOT WRITTEN. Step 1 reads it and nothing updates it, because the view recomputes
 * it from the very rows this transaction inserted. The response carries the post-transaction
 * figure read back through the view, so the caller never has to compute what is left.
 *
 * `monto` is PESOS, like every other repository entry point (`productos.crear`,
 * `cajas.abrir`, `deudores.crear`) — the renderer's language, converted once at the boundary
 * with `toCents`. A caller that forgets is off by a factor of 100, and the name of the argument
 * in the error message is what catches it.
 *
 * @param body `{ monto, metodoPago?, referencia?, observaciones? }`
 * @returns `{ pago, deudor, pagadoCompleto }` — `deudor` is the debtor with the view's NEW
 *          balances, so the screen can redraw from the answer instead of guessing.
 */
export function registrarPago(ctx, deudorId, body) {
  requireTenant(ctx.negocioId)
  if (!ctx.actorId) {
    throw new IpcError('ACTOR_REQUERIDO', 401, 'La operación necesita un usuario en sesión')
  }
  if (!body || typeof body !== 'object') {
    throw new IpcError('PAGO_CUERPO_INVALIDO', 400, 'El pago debe enviar un cuerpo de petición')
  }
  const id = Number(deudorId)
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new IpcError('DEUDOR_ID_INVALIDO', 400, `Id de deudor inválido: ${deudorId}`)
  }

  const metodoPago =
    body.metodoPago === null || body.metodoPago === undefined || body.metodoPago === ''
      ? 'efectivo'
      : String(body.metodoPago).toLowerCase()
  if (!METODOS_PAGO_PAGO.includes(metodoPago)) {
    // `mixto` lands here too, and gets the same words `ventas.repo.js` uses for it. The reason
    // is written out at `METODOS_PAGO_PAGO`: this port has to say where the money went, and a
    // split nobody collects cannot be said out loud.
    throw new IpcError(
      'PAGO_METODO_INVALIDO',
      400,
      `Método de pago inválido: ${metodoPago}. El pago mixto requiere desglose efectivo/crédito, aún no soportado`
    )
  }

  // Validated BEFORE the transaction opens, exactly as `ventas.repo.js` does, so a malformed
  // payment costs no write lock.
  const montoCentavos = assertCents(toCents(body.monto, 'monto del pago'), 'monto del pago')
  if (montoCentavos < 1) {
    // The web's own sentence (`deudor.controller.js:278-280`), and it is also what the schema's
    // `CHECK (monto_centavos >= 1)` would say — as a 500, in SQLite's words, for something a
    // human typed. The application-level check is what makes it a 400 a person can act on.
    throw new IpcError('PAGO_MONTO_INVALIDO', 400, 'El monto debe ser mayor a 0')
  }

  return ctx.tx(() => {
    const deudor = leerConSaldos(ctx.db, ctx.negocioId, id)
    if (!deudor) {
      throw new IpcError('DEUDOR_NO_ENCONTRADO', 404, 'Cliente deudor no encontrado')
    }
    const pendiente = deudor.deudaPendienteCentavos

    if (montoCentavos > pendiente) {
      // The web refuses this too (`deudor.controller.js:282-288`), and for the same reason it
      // does everywhere: a payment larger than the debt is not a payment, it is a data-entry
      // mistake, and accepting it mints a negative balance or a phantom credit. The view clamps
      // at zero so the stored number can never be negative — but the CLAMP is not permission. A
      // silent clamp here would hand back `pendiente: 0` for a payment the operator believes
      // recorded in full, which is the "receipt that says the wrong thing" defect again.
      throw new IpcError(
        'PAGO_EXCEDE_DEUDA',
        400,
        `El monto excede la deuda pendiente (${pendiente} centavos)`
      )
    }

    const ts = new Date().toISOString()
    const texto = (v) =>
      v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim()

    // `venta_id` stays NULL and `origen` below is 'manual', because a debtor payment is not
    // tied to one sale: it pays the whole debt, not a line of one ticket. The CHECK
    // `((origen = 'venta') = (venta_id IS NOT NULL))` is satisfied by a null sale, and the
    // column is nullable precisely for this case.
    const info = ctx.db
      .prepare(
        `INSERT INTO pagos_deuda
           (monto_centavos, fecha, metodo_pago, referencia, observaciones,
            deudor_id, user_id, negocio_id, venta_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      )
      .run(
        montoCentavos,
        ts,
        metodoPago,
        texto(body.referencia),
        texto(body.observaciones),
        id,
        ctx.actorId,
        ctx.negocioId,
        ts,
        ts
      )
    const pagoId = Number(info.lastInsertRowid)

    // ---- the ledger ---------------------------------------------------------------------
    // Debit WHERE IT LANDED, credit the receivable. One entry, two lines, balanced by
    // construction — `asentar` throws before the first INSERT if it is not, so an unbalanced
    // payment cannot reach the database even if this arithmetic were edited into something wrong.
    const cuentas = asegurarPlan(ctx)
    const recibeId = cuentas.get(CUENTA_POR_METODO_PAGO[metodoPago]).id
    const clientesId = cuentas.get(CUENTA.CLIENTES).id
    asentar(ctx, {
      fecha: ts,
      descripcion: `Pago de deuda - ${deudor.nombre}`,
      tipo: 'ingreso',
      referencia: `pago:${pagoId}`,
      partidas: [
        {
          cuentaId: recibeId,
          debeCentavos: montoCentavos,
          haberCentavos: 0,
          descripcion: `Cobro de deuda ${metodoPago}`
        },
        {
          cuentaId: clientesId,
          debeCentavos: 0,
          haberCentavos: montoCentavos,
          descripcion: `Cancelación deuda ${deudor.nombre}`
        }
      ]
    })

    // ---- the drawer, ONLY for cash -------------------------------------------------------
    // `origen: 'manual'` and `ventaId: null`, because the money entered the shop without a
    // ticket behind it. That is exactly what the schema's `origen` vocabulary calls 'manual',
    // and 'venta' would be a lie the CHECK itself would refuse.
    let movimiento = null
    if (metodoPago === 'efectivo') {
      const caja = cajaActiva(ctx.db, ctx.negocioId)
      if (!caja) {
        // A cash payment with no till open is refused rather than quietly banked. `ventas.repo.js`
        // already refuses the cash SALE for the same reason and with the same words: the cash is
        // physically in a drawer, and a drawer that is not open cannot prove it holds anything.
        // Posting the journal entry anyway would leave the money in `1.1.01` with no movement
        // behind it — a balance the till's own sum cannot reproduce. A CARD payment is not
        // refused: no cash is involved, exactly as a credit sale is allowed with no till open.
        throw new IpcError(
          'CAJA_ABIERTA_REQUERIDA',
          409,
          'No hay caja abierta. Abrí una caja antes de recibir un pago en efectivo.'
        )
      }
      movimiento = registrarMovimiento(ctx, {
        caja,
        tipo: 'ingreso',
        concepto: `Pago de deuda - ${deudor.nombre}`,
        montoCentavos: montoCentavos,
        origen: 'manual',
        referencia: `pago:${pagoId}`
      })
    }

    // ---- the trail -----------------------------------------------------------------------
    ctx.db
      .prepare(
        `INSERT INTO auditoria (tabla, registro_id, accion, valores_anteriores, valores_nuevos, user_id, negocio_id, created_at, updated_at)
         VALUES ('pagos_deuda', ?, 'CREATE', NULL, ?, ?, ?, ?, ?)`
      )
      .run(
        pagoId,
        JSON.stringify({
          montoCentavos,
          metodoPago,
          deudorId: id,
          saldoPendienteAntes: pendiente
        }),
        ctx.actorId,
        ctx.negocioId,
        ts,
        ts
      )

    // Read the balance back through the VIEW rather than subtracting here. The caller gets the
    // number the next reader of the debtor list will get, which is the only way these two can be
    // the same number.
    const despues = leerConSaldos(ctx.db, ctx.negocioId, id)
    const pago = ctx.db
      .prepare('SELECT * FROM pagos_deuda WHERE id = ?')
      .get(pagoId)

    return {
      pago: {
        id: pagoId,
        montoCentavos: pago.monto_centavos,
        fecha: pago.fecha,
        metodoPago: pago.metodo_pago,
        referencia: pago.referencia,
        observaciones: pago.observaciones,
        ventaId: pago.venta_id
      },
      deudor: despues,
      // The same verdict the web returns, computed from the view rather than from a column.
      pagadoCompleto: despues.deudaPendienteCentavos === 0,
      movimientoCaja: movimiento
    }
  })
}
