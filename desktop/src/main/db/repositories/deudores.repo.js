import { IpcError } from '../../bridge/errors.js'
import { assertCents, formatCents, toCents } from '../../../shared/money.js'
import { requireTenant } from '../seed.js'

/**
 * Debtors — the customers a credit sale can be billed to.
 *
 * WHY ONLY `list`. `ventas.repo.js` refuses a `credito` sale with no `clienteDeudorId`
 * (`VENTA_CREDITO_SIN_DEUDOR`), which is the right call: a credit sale with no debtor is an
 * income hole, because nothing anywhere records who owes what. The POS's payment modal therefore
 * needs to be able to LIST debtors before it can offer "Crédito" at all, and listing is what
 * this file provides. `get`, `create`, `update`, `remove`, `addPayment` and `payments` are
 * contract members with no handler in this build, so the registry answers 501 for them — the
 * same honest answer every other unimplemented operation gives.
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
      const esDocumentoRepetido =
        err?.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
        String(err.message).includes('ux_clientes_deudores_documento')
      if (esDocumentoRepetido) {
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
