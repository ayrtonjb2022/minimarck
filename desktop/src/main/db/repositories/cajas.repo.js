import { IpcError } from '../../bridge/errors.js'
import { assertCents, toCents } from '../../../shared/money.js'
import { requireTenant } from '../seed.js'
import { esViolacionUnicaEn } from '../errores-sqlite.js'

/**
 * The till (design §D.5; spec CAJA-1..4).
 *
 * Ported from `backend/src/controllers/caja.controller.js`, with the one thing that controller
 * CANNOT do: it serialises concurrent openings with `SELECT ... FOR UPDATE` on the business row,
 * a lock MySQL has and SQLite does not. Here `BEGIN IMMEDIATE` plus the partial unique index
 * `ux_cajas_abierta` does the same job — the second concurrent open loses on the index, in the
 * database, rather than on a check that a second process skipped between read and write.
 *
 * The web's application-level check is KEPT as well, and it is not redundant with the index. The
 * index is the backstop that makes the invariant unbypassable; the check is what produces an
 * error an operator can act on. A losing writer that only trips `SQLITE_CONSTRAINT_UNIQUE` learns
 * that "ya existe una caja abierta" from a translated constraint name, which is the worst way to
 * learn that you are holding a drawer someone else already opened.
 */

/** Payment methods a sale can carry, as the web's controller validates them. `mixto` is excluded on purpose. */
export const METODOS_PAGO = Object.freeze(['efectivo', 'tarjeta', 'transferencia', 'credito'])

/** The open till for a business, or `null`. Read through this everywhere rather than a bare query. */
export function cajaActiva(db, negocioId) {
  return (
    db
      .prepare(
        `SELECT * FROM cajas
          WHERE negocio_id = ? AND estado = 'abierta' AND deleted_at IS NULL
          ORDER BY id DESC LIMIT 1`
      )
      .get(negocioId) ?? null
  )
}

/**
 * The till's cash on hand, from its own columns.
 *
 * Derived, never stored: `saldo_final_centavos` is a snapshot taken at close time, and a number
 * that has to be recomputed on every read is the one definition of a cached balance — the thing
 * this schema deliberately refuses to have (see the `clientes_deudores` note in `001_init.sql`).
 */
export function saldoCaja(caja) {
  return assertCents(
    (caja.saldo_inicial_centavos ?? 0) + (caja.total_ingresos_centavos ?? 0) - (caja.total_egresos_centavos ?? 0),
    'saldo de caja'
  )
}

/**
 * One movement, and the till total it implies, in the caller's transaction.
 *
 * `montoCentavos` IS centavos — every caller that reaches this function has already converted
 * (`ipc/cajas.js` converts the renderer's pesos string; `ventas.repo.js` passes a total that was
 * never pesos). Converting again here would multiply every sale's movement by one hundred, so the
 * only guard is integer arithmetic.
 *
 * The schema says `monto_centavos >= 1`, so a ZERO movement is skipped rather than written. The
 * web writes one unconditionally — `monto: saldoInicial || 0` on every opening — and the desktop
 * would refuse that row with a bare `CHECK constraint failed`. A drawer opened with no float in
 * it has had no cash event, so there is nothing to record and the till total is already correct.
 * The skip is a divergence, recorded as one.
 *
 * NOTE ON OPENING: the APERTURA movement is the ONE movement that does NOT go through this
 * function — `abrir` writes it directly, the way the web does (`MovimientoCaja.create` without
 * touching the totals). See there for why.
 */
export function registrarMovimiento(
  ctx,
  { caja, tipo, concepto, montoCentavos, referencia = null, origen, ventaId = null }
) {
  const monto = assertCents(montoCentavos, 'monto del movimiento')
  if (monto === 0) return null

  // The chain is read from the DRAWER, not from the caller's snapshot. The row a caller hands in
  // is a moment in time — usually the one right before the first movement — and computing the
  // second movement of a session from it would write a saldo the drawer never had (ingreso, then
  // egreso, saldo jumping BACK instead of carrying +ingreso forward). The snapshot has the right
  // `id`; the truth is in the row.
  const actual = ctx.db.prepare('SELECT * FROM cajas WHERE id = ?').get(caja.id)
  const saldoAnterior = saldoCaja(actual)
  const saldoNuevo = assertCents(saldoAnterior + (tipo === 'ingreso' ? monto : -monto), 'saldo nuevo')
  const ts = new Date().toISOString()

  ctx.db
    .prepare(
      `INSERT INTO movimientos_caja
         (tipo, concepto, monto_centavos, saldo_anterior_centavos, saldo_nuevo_centavos,
          origen, referencia, caja_id, user_id, negocio_id, venta_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(tipo, concepto, monto, saldoAnterior, saldoNuevo, origen, referencia, caja.id, ctx.actorId, ctx.negocioId, ventaId, ts, ts)

  // The till total moves in the SAME statement set as the movement, for the same reason the
  // movement carries its own running balance: a movement with no matching total update is a
  // drawer whose history and whose number disagree, and the number is the one people trust.
  const columna = tipo === 'ingreso' ? 'total_ingresos_centavos' : 'total_egresos_centavos'
  ctx.db.prepare(`UPDATE cajas SET ${columna} = ${columna} + ?, updated_at = ? WHERE id = ?`).run(monto, ts, caja.id)
  return { monto, saldoAnterior, saldoNuevo }
}

/**
 * Open the till (CAJA-1).
 *
 * One transaction, and the `ux_cajas_abierta` partial index is the thing that actually enforces
 * "at most one open register" — the SELECT in front of it is for the error message, not for the
 * guarantee. `BEGIN IMMEDIATE` in the connection's `tx()` takes the write lock before the SELECT
 * runs, which is what makes that SELECT authoritative for the rest of the transaction.
 */
export function abrir(ctx, { saldoInicial = 0, observaciones = null } = {}) {
  requireTenant(ctx.negocioId)
  const saldoInicialCentavos = assertCents(toCents(saldoInicial, 'saldo inicial'), 'saldo inicial')
  if (saldoInicialCentavos < 0) {
    throw new IpcError('CAJA_SALDO_INICIAL_NEGATIVO', 400, 'El saldo inicial no puede ser negativo')
  }

  return ctx.tx(() => {
    const existente = cajaActiva(ctx.db, ctx.negocioId)
    if (existente) {
      throw new IpcError(
        'CAJA_ABIERTA',
        400,
        'Ya existe una caja abierta. Debe cerrarla antes de abrir otra'
      )
    }

    const ts = new Date().toISOString()
    let cajaId
    try {
      const info = ctx.db
        .prepare(
          `INSERT INTO cajas
             (fecha_apertura, saldo_inicial_centavos, total_ingresos_centavos, total_egresos_centavos,
              estado, observaciones, user_id, usuario_apertura, negocio_id, created_at, updated_at)
           VALUES (?, ?, 0, 0, 'abierta', ?, ?, ?, ?, ?, ?)`
        )
        .run(ts, saldoInicialCentavos, observaciones, ctx.actorId, ctx.actorId, ctx.negocioId, ts, ts)
      cajaId = Number(info.lastInsertRowid)
    } catch (err) {
      // The race the SELECT above cannot see: another connection inserted between our check and
      // ours. The index is what decides, and this is the translation of its verdict into the
      // same error the SELECT would have produced.
      if (esIndiceCajaAbierta(err)) {
        throw new IpcError(
          'CAJA_ABIERTA',
          400,
          'Ya existe una caja abierta. Debe cerrarla antes de abrir otra'
        )
      }
      throw err
    }

    const caja = ctx.db.prepare('SELECT * FROM cajas WHERE id = ?').get(cajaId)

    // THE FLOAT IS RECORDED BUT NEVER COUNTS TOWARD `total_ingresos`, and the reason is
    // arithmetic, not style. `saldoCaja()` is `saldo_inicial + total_ingresos - total_egresos` —
    // the web's own close-time formula (`caja.controller.js:107-110`) — so adding the float to
    // `total_ingresos` as well would count it TWICE: a drawer opened with 50 000 would report
    // 100 000. The web never makes this mistake, because it creates the row with the totals at 0
    // and writes the APERTURA movement STANDALONE — `MovimientoCaja.create`, no increment, with
    // `saldoAnterior: 0` and `saldoNuevo: saldoInicial` (`caja.controller.js:40-62`). This is
    // that same split, in the same transaction. A zero float writes no row (see the note on
    // `registrarMovimiento`; the schema refuses `monto_centavos < 1`).
    if (saldoInicialCentavos >= 1) {
      ctx.db
        .prepare(
          `INSERT INTO movimientos_caja
             (tipo, concepto, monto_centavos, saldo_anterior_centavos, saldo_nuevo_centavos,
              origen, referencia, caja_id, user_id, negocio_id, created_at, updated_at)
           VALUES ('ingreso', 'APERTURA DE CAJA', ?, 0, ?, 'caja_apertura', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          saldoInicialCentavos,
          saldoInicialCentavos,
          `caja:${cajaId}`,
          cajaId,
          ctx.actorId,
          ctx.negocioId,
          ts,
          ts
        )
    }

    return ctx.db.prepare('SELECT * FROM cajas WHERE id = ?').get(cajaId)
  })
}

/**
 * Close the till (CAJA-2).
 *
 * `saldo_final_centavos` is the balance the till's own movements produce, not a number the
 * operator typed in: the web has no field for a counted amount either, and letting the till close
 * onto a figure that no movement supports is how a drawer becomes permanently unaccountable.
 *
 * A NEGATIVE balance cannot be closed, and the refusal is explicit. The schema forbids it
 * (`cajas.saldo_final_centavos >= 0`) while the SAME file's note on `movimientos_caja` states that
 * a till which has spent more cash than it held "is a real state a shop can reach" and that
 * refusing it "would leave the register permanently unable to close". Those two decisions
 * contradict each other; the schema owns the column, so this file does not change it. It reports
 * the number, says what to do, and leaves the fix to whoever owns `001_init.sql`. See
 * `DIVERGENCES.md`.
 */
export function cerrar(ctx, id, { observaciones = null } = {}) {
  requireTenant(ctx.negocioId)
  const cajaId = Number(id)
  if (!Number.isSafeInteger(cajaId) || cajaId < 1) {
    throw new IpcError('CAJA_ID_INVALIDO', 400, `Id de caja inválido: ${id}`)
  }

  return ctx.tx(() => {
    const caja = ctx.db
      .prepare('SELECT * FROM cajas WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL')
      .get(cajaId, ctx.negocioId)
    if (!caja) {
      throw new IpcError('CAJA_NO_ENCONTRADA', 404, 'Caja no encontrada')
    }
    if (caja.estado === 'cerrada') {
      throw new IpcError('CAJA_YA_CERRADA', 400, 'Esta caja ya está cerrada')
    }
    // The web's rule, kept verbatim: the drawer is closed by whoever opened it.
    if (caja.user_id !== ctx.actorId) {
      throw new IpcError('CAJA_NO_SUYA', 403, 'Solo quien abrió la caja puede cerrarla')
    }

    const saldo = saldoCaja(caja)
    if (saldo < 0) {
      throw new IpcError(
        'CAJA_SALDO_NEGATIVO',
        409,
        `La caja cierra en ${saldo} centavos: registró más egresos que ingresos. ` +
          'Registrá el ingreso faltante con cajaMovimientos.create antes de cerrarla.'
      )
    }

    const ts = new Date().toISOString()
    ctx.db
      .prepare(
        `UPDATE cajas
            SET fecha_cierre = ?, saldo_final_centavos = ?, estado = 'cerrada', usuario_cierre = ?,
                observaciones = COALESCE(?, observaciones), updated_at = ?
          WHERE id = ?`
      )
      .run(ts, saldo, ctx.actorId, observaciones, ts, cajaId)
    return ctx.db.prepare('SELECT * FROM cajas WHERE id = ?').get(cajaId)
  })
}

/** One till, scoped to the business. */
export function obtener(db, negocioId, id) {
  const cajaId = Number(id)
  if (!Number.isSafeInteger(cajaId) || cajaId < 1) {
    throw new IpcError('CAJA_ID_INVALIDO', 400, `Id de caja inválido: ${id}`)
  }
  const caja = db
    .prepare('SELECT * FROM cajas WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL')
    .get(cajaId, negocioId)
  if (!caja) {
    throw new IpcError('CAJA_NO_ENCONTRADA', 404, 'Caja no encontrada')
  }
  return { ...caja, saldoActualCentavos: saldoCaja(caja), movimientos: movimientos(db, cajaId) }
}

/** Newest first, so the open till is the first row a list ever shows. */
export function listar(db, negocioId, { limit = 20, offset = 0, estado = null } = {}) {
  const filas = estado
    ? db
        .prepare(
          `SELECT * FROM cajas
            WHERE negocio_id = ? AND deleted_at IS NULL AND estado = ?
            ORDER BY fecha_apertura DESC, id DESC LIMIT ? OFFSET ?`
        )
        .all(negocioId, estado, limit, offset)
    : db
        .prepare(
          `SELECT * FROM cajas
            WHERE negocio_id = ? AND deleted_at IS NULL
            ORDER BY fecha_apertura DESC, id DESC LIMIT ? OFFSET ?`
        )
        .all(negocioId, limit, offset)
  const total = estado
    ? db
        .prepare(
          `SELECT COUNT(*) AS n FROM cajas WHERE negocio_id = ? AND deleted_at IS NULL AND estado = ?`
        )
        .get(negocioId, estado)
    : db.prepare(`SELECT COUNT(*) AS n FROM cajas WHERE negocio_id = ? AND deleted_at IS NULL`).get(negocioId)
  return { filas: filas.map((c) => ({ ...c, saldoActualCentavos: saldoCaja(c) })), total: total.n }
}

export function movimientos(db, cajaId) {
  return db
    .prepare('SELECT * FROM movimientos_caja WHERE caja_id = ? ORDER BY id ASC')
    .all(cajaId)
}

/**
 * The web's `saldo-general`: every closed till plus the open one.
 *
 * Closed tills contribute their recorded `saldo_final_centavos` and the open one contributes its
 * live balance, because a closed till has no movements left to read and an open one has no final
 * figure yet. Reading the open till from its movements instead of from `saldo_final` would give
 * the same number; reading it from a `saldo_final` that does not exist yet would give zero, and
 * that is the bug this avoids.
 */
export function saldoGeneral(db, negocioId) {
  const cerradas = db
    .prepare(
      `SELECT COALESCE(SUM(saldo_final_centavos), 0) AS saldo, COUNT(*) AS n
         FROM cajas WHERE negocio_id = ? AND estado = 'cerrada' AND deleted_at IS NULL`
    )
    .get(negocioId)
  const abierta = cajaActiva(db, negocioId)
  const saldoAbierta = abierta ? saldoCaja(abierta) : 0
  return {
    saldoGeneral: assertCents(cerradas.saldo + saldoAbierta, 'saldo general'),
    saldoCerradas: assertCents(cerradas.saldo, 'saldo cerrado'),
    saldoAbierta,
    cajasCerradas: cerradas.n,
    tieneCajaAbierta: Boolean(abierta),
    cajaAbiertaId: abierta?.id ?? null
  }
}

/** The web's `/desglose`: sales by payment method for a till, plus same-day credit sales. */
export function desglose(db, negocioId, id) {
  const caja = obtener(db, negocioId, id)
  const metodos = [...METODOS_PAGO, 'mixto']
  const desglose = Object.fromEntries(metodos.map((m) => [m, 0]))
  const cantidades = Object.fromEntries(metodos.map((m) => [m, 0]))
  let totalVentas = 0

  // Credit sales carry no till movement (no cash left the drawer) but they are still sales made
  // on the day the till opened, which is what an operator counting at close wants to see.
  const filas = db
    .prepare(
      `SELECT metodo_pago, total_centavos, caja_id
         FROM ventas
        WHERE negocio_id = ? AND deleted_at IS NULL AND estado = 'completada'
          AND (caja_id = ? OR (metodo_pago = 'credito' AND caja_id IS NULL
                               AND substr(fecha, 1, 10) = substr(?, 1, 10)))`
    )
    .all(negocioId, caja.id, caja.fecha_apertura)

  for (const f of filas) {
    if (desglose[f.metodo_pago] === undefined) {
      desglose[f.metodo_pago] = 0
      cantidades[f.metodo_pago] = 0
    }
    desglose[f.metodo_pago] += f.total_centavos
    cantidades[f.metodo_pago] += 1
    totalVentas += f.total_centavos
  }
  return { cajaId: caja.id, fecha: caja.fecha_apertura, desglose, cantidades, totalVentas }
}

/**
 * The partial index `ux_cajas_abierta` (on `negocio_id`, WHERE `estado = 'abierta'`) refuses a
 * second open register. `cajas.negocio_id` is unique exactly once, in exactly that index, so the
 * column is the identifier. The "which shapes can this arrive in" half of the question lives in
 * `errores-sqlite.js`, where it is written down once instead of copied.
 */
function esIndiceCajaAbierta(err) {
  return esViolacionUnicaEn(err, 'cajas.negocio_id')
}
