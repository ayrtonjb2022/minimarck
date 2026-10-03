import { IpcError } from '../../bridge/errors.js'
import { assertCents, formatCents, toCents } from '../../../shared/money.js'
import { requireTenant } from '../seed.js'
import { esViolacionUnicaEn } from '../errores-sqlite.js'
import { saldoDeTipo } from '../reportes/metricas.js'
import { asentar, asegurarPlan, balanceGeneral } from './cuentas.repo.js'

/**
 * `contabilidad.*` — the fifteen operations, over the ledger the shop already writes.
 *
 * ── WHAT WAS ALREADY HERE, AND WHAT WAS MISSING ───────────────────────────────────────────────
 *
 * `cuentas.repo.js` has written the journal since the sale path landed: every sale, purchase,
 * debtor payment and till movement posts a balanced entry inside its own transaction. That file is
 * the WRITE half, and it is invoked by other features — nobody calls it directly.
 *
 * What did not exist was any way to READ or ADMINISTER that ledger. The chart of accounts was
 * created implicitly by `asegurarPlan` and could not be listed, renamed or deactivated; entries
 * could not be looked at, added by hand or removed. Fifteen contract operations, and not one
 * handler. So a shop had a double-entry ledger it could not open, which is the same defect as a
 * catalogue screen with no catalogue: the data was real and unreachable.
 *
 * ── WHY THIS IS A SEPARATE FILE FROM `cuentas.repo.js` ────────────────────────────────────────
 *
 * `cuentas.repo.js` is plumbing for other features: it opens no transaction, its `asentar` is
 * documented as "must be called inside the caller's transaction", and its whole contract is built
 * around being invoked mid-way through somebody else's atomic unit. This file is the opposite: it
 * is a user-facing entry point, so it OWNS its transactions, it validates what a person typed, and
 * it must not change the semantics the sale path depends on. Merging them would put a `ctx.tx()`
 * next to a function whose doc says it must never open one.
 *
 * ── THE INVARIANT THAT MATTERS MOST ───────────────────────────────────────────────────────────
 *
 * A hand-written entry is the one place a human can put money into the ledger that no sale
 * explains, so it is exactly where an unbalanced entry would come from. `asentar` already refuses
 * one (thrown, before the first INSERT), and this file re-validates the SHAPE before calling it:
 * at least two lines, each with an account, each moving one side. An entry with a single line is
 * refused by name rather than surfacing as `ASIENTO_DESBALANCEADO` from the depth of the money
 * module — the operator typed one line, so the refusal should say "one line".
 */

/** The five account types the schema CHECKs. Mirrored so a refusal is a 400 with a sentence. */
const TIPOS_CUENTA = Object.freeze(['activo', 'pasivo', 'capital', 'ingreso', 'gasto'])

/** The four entry types the schema CHECKs. */
const TIPOS_ASIENTO = Object.freeze(['ingreso', 'egreso', 'ajuste', 'apertura'])

/** The five debt types the schema CHECKs. */
const TIPOS_DEUDA = Object.freeze(['prestamo_mp', 'prestamo_bancario', 'prestamo_personal', 'proveedor', 'otro'])

const ESTADOS_DEUDA = Object.freeze(['activo', 'pagado', 'vencido'])

/**
 * The payment methods a debt payment accepts. `metodo_pago` is TEXT in this table — the schema
 * records that the model uses `STRING(30)` here while the other two payment tables use ENUMs — so
 * nothing in the database would stop "banana". The list is the app's, and it is the same four the
 * rest of the app already understands, so a payment screen cannot invent a method the reports
 * cannot group.
 */
const METODOS_PAGO = Object.freeze(['efectivo', 'tarjeta', 'transferencia', 'credito'])

/** Trimmed text, or null. A blank field is a blank, not an empty string. */
function textoOpcional(valor) {
  if (valor === null || valor === undefined) return null
  const t = String(valor).trim()
  return t === '' ? null : t
}

function textoRequerido(valor, campo, { max = 200 } = {}) {
  const t = textoOpcional(valor)
  if (t === null) throw new IpcError('DATO_INVALIDO', 400, `Falta ${campo}`)
  if (t.length > max) throw new IpcError('DATO_INVALIDO', 400, `${campo} es demasiado largo`)
  return t
}

/** A positive integer id, or a 400 that names the field. */
function assertId(valor, etiqueta) {
  const n = Number(valor)
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new IpcError('ID_INVALIDO', 400, `Id de ${etiqueta} inválido: ${valor}`)
  }
  return n
}

function assertEnLista(valor, lista, campo, codigo) {
  if (!lista.includes(valor)) {
    throw new IpcError(codigo, 400, `${campo} inválido: ${valor}. Permitidos: ${lista.join(', ')}`)
  }
  return valor
}

/** A date the shop typed, kept as an ISO day. `asientos.fecha` is TEXT and indexed as one. */
function fechaIso(valor, campo) {
  const t = textoOpcional(valor)
  if (t === null) return new Date().toISOString()
  const soloDia = /^\d{4}-\d{2}-\d{2}$/.test(t)
  if (!soloDia && Number.isNaN(Date.parse(t))) {
    throw new IpcError('FECHA_INVALIDA', 400, `${campo} no es una fecha válida: ${t}`)
  }
  return t
}

/** A rate in the schema's own range: `tasa_interes` CHECKs NULL or 0..100. */
function tasaOpcional(valor, campo) {
  if (valor === null || valor === undefined || valor === '') return null
  const n = typeof valor === 'number' ? valor : Number(String(valor).replace(',', '.'))
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new IpcError('TASA_INVALIDA', 400, `${campo} debe estar entre 0 y 100: ${valor}`)
  }
  return n
}

/** An optional positive integer count (`cuotas_totales`, `cuotas_pagadas`). */
function enteroOpcional(valor, campo, { min = 0 } = {}) {
  if (valor === null || valor === undefined || valor === '') return null
  const n = Number(valor)
  if (!Number.isSafeInteger(n) || n < min) {
    throw new IpcError('ENTERO_INVALIDO', 400, `${campo} debe ser un entero >= ${min}: ${valor}`)
  }
  return n
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Mappers: the snake_case row to the camelCase shape the renderer reads.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export function mapCuenta(row) {
  if (!row) return null
  return {
    id: row.id,
    codigo: row.codigo,
    nombre: row.nombre,
    tipo: row.tipo,
    descripcion: row.descripcion,
    parentId: row.parent_id,
    activo: Boolean(row.activo),
    // The two sums are ALWAYS present, and the signed reading is computed here rather than in the
    // screen. `saldoDeTipo` is the single table of signs for account types (`metricas.js`), so an
    // asset and a liability are read with the same function everywhere — a screen that subtracted
    // on its own would be the second implementation of the one rule that must not have two.
    debeCentavos: row.debe ?? 0,
    haberCentavos: row.haber ?? 0,
    saldoCentavos: row.tipo ? saldoDeTipo(row.tipo, row.debe ?? 0, row.haber ?? 0) : 0,
    // How many lines point at this account. Used to refuse a delete with a number in the message
    // instead of a bare "no se puede".
    movimientos: row.movimientos ?? 0
  }
}

function mapAsiento(row) {
  if (!row) return null
  return {
    id: row.id,
    fecha: row.fecha,
    descripcion: row.descripcion,
    tipo: row.tipo,
    referencia: row.referencia,
    montoTotalCentavos: row.monto_total_centavos,
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapDetalle(row) {
  if (!row) return null
  return {
    id: row.id,
    cuentaId: row.cuenta_contable_id,
    codigo: row.codigo,
    cuentaNombre: row.cuenta_nombre,
    tipo: row.cuenta_tipo,
    debeCentavos: row.debe_centavos,
    haberCentavos: row.haber_centavos,
    descripcion: row.descripcion
  }
}

export function mapDeuda(row) {
  if (!row) return null
  return {
    id: row.id,
    nombre: row.nombre,
    tipo: row.tipo,
    montoOriginalCentavos: row.monto_original_centavos,
    saldoPendienteCentavos: row.saldo_pendiente_centavos,
    tasaInteres: row.tasa_interes,
    cuotasTotales: row.cuotas_totales,
    cuotasPagadas: row.cuotas_pagadas,
    montoCuotaCentavos: row.monto_cuota_centavos,
    fechaInicio: row.fecha_inicio,
    fechaVencimiento: row.fecha_vencimiento,
    estado: row.estado,
    contactoNombre: row.contacto_nombre,
    contactoTelefono: row.contacto_telefono,
    proveedorId: row.proveedor_id,
    notas: row.notas,
    // Derived, never stored. `saldoPendienteCentavos` is a column here — unlike a debtor's balance,
    // which the view computes — because the payments in `pagos_deuda_contabilidad` are subtracted
    // from it and every row that moves it is in this file. The two are kept honest by
    // `recalcularSaldo` below rather than by a trigger, so there is exactly one writer.
    pagadoCentavos: Math.max(0, row.monto_original_centavos - row.saldo_pendiente_centavos),
    porcentajePagado: row.monto_original_centavos > 0
      ? Math.min(100, Math.floor(((row.monto_original_centavos - row.saldo_pendiente_centavos) * 100) / row.monto_original_centavos))
      : 0,
    pagos: row.pagos ?? 0
  }
}

function mapPago(row) {
  if (!row) return null
  return {
    id: row.id,
    deudaId: row.cuenta_corriente_deuda_id,
    montoCentavos: row.monto_centavos,
    fecha: row.fecha,
    metodoPago: row.metodo_pago,
    numeroCuota: row.numero_cuota,
    observaciones: row.observaciones,
    userId: row.user_id,
    createdAt: row.created_at
  }
}

/** One `auditoria` row. `cuentas_contables` has no audit column of its own. */
function auditar(ctx, tabla, registroId, accion, anteriores, nuevos) {
  const ts = new Date().toISOString()
  ctx.db
    .prepare(
      `INSERT INTO auditoria
         (tabla, registro_id, accion, valores_anteriores, valores_nuevos, user_id, negocio_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(tabla, registroId, accion, JSON.stringify(anteriores ?? {}), JSON.stringify(nuevos ?? {}),
         ctx.actorId, ctx.negocioId, ts, ts)
}

/** `LIKE` wildcards an operator typed are literal characters, not patterns. */
function escaparLike(t) {
  return t.replace(/[\\%_]/g, (c) => `\\${c}`)
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// CUENTAS
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The chart of accounts, with what has moved through each one.
 *
 * THE `asegurarPlan` CALL IS NOT DECORATION. The chart is created lazily by whichever flow needs it
 * first (`cuentas.repo.js` explains why it is not in the seed), so a shop that has never recorded a
 * sale has an EMPTY chart — and this screen is the one place somebody would go to look at it before
 * selling anything. Creating it here means the first thing an owner sees is the real plan rather
 * than an empty table that reads as broken.
 */
export function listarCuentas(ctx, { search = '', tipo, activo, conSaldo = false } = {}) {
  requireTenant(ctx.negocioId)
  asegurarPlanSiFalta(ctx)

  const cond = ['c.negocio_id = ?']
  const args = [ctx.negocioId]

  const q = textoOpcional(search)
  if (q !== null) {
    cond.push("(c.codigo LIKE ? ESCAPE '\\' OR c.nombre LIKE ? ESCAPE '\\')")
    const patron = `%${escaparLike(q.toLowerCase())}%`
    args.push(patron, patron)
  }
  if (tipo !== undefined && tipo !== null && tipo !== '' && tipo !== 'todos') {
    cond.push('c.tipo = ?')
    args.push(assertEnLista(tipo, TIPOS_CUENTA, 'Tipo de cuenta', 'CUENTA_TIPO_INVALIDO'))
  }
  if (activo !== undefined && activo !== null && activo !== '' && activo !== 'todos') {
    cond.push('c.activo = ?')
    args.push(activo === true || activo === 'true' || activo === 1 ? 1 : 0)
  }

  const filas = ctx.db
    .prepare(
      `SELECT c.*,
              COALESCE(SUM(d.debe_centavos), 0)  AS debe,
              COALESCE(SUM(d.haber_centavos), 0) AS haber,
              COUNT(d.id)                        AS movimientos
         FROM cuentas_contables c
         LEFT JOIN detalles_asientos d
           ON d.cuenta_contable_id = c.id AND d.negocio_id = c.negocio_id
        WHERE ${cond.join(' AND ')}
        GROUP BY c.id
        ORDER BY c.codigo ASC`
    )
    .all(...args)

  const cuentas = filas.map(mapCuenta)
  // `conSaldo` keeps the accounts that have actually moved. It is a filter on the RESULT rather
  // than on the query because `HAVING` on a LEFT JOIN would drop the empty accounts anyway, and the
  // two readings mean different things to a reader: "todas las cuentas" and "sólo las que tienen
  // movimiento" are different questions, and the pager/emptiness logic differs.
  return conSaldo ? cuentas.filter((c) => c.movimientos > 0) : cuentas
}

/** Idempotent, and cheap: see `asegurarPlan` in `cuentas.repo.js`. */
function asegurarPlanSiFalta(ctx) {
  const hay = ctx.db
    .prepare('SELECT COUNT(*) AS n FROM cuentas_contables WHERE negocio_id = ?')
    .get(ctx.negocioId).n
  if (hay === 0) asegurarPlan(ctx)
}

/**
 * Create an account.
 *
 * `tipo` and `codigo` are what the ledger is built on: the first decides the SIGN of every balance
 * the account will ever report (`saldoDeTipo`), and the second is the order a human reads the chart
 * in. Both are validated before the insert so the refusal is a 400 naming the field instead of a
 * `CHECK constraint failed` that `toIpcError` cannot translate.
 */
export function crearCuenta(ctx, body) {
  requireTenant(ctx.negocioId)
  if (!ctx.actorId) throw new IpcError('ACTOR_REQUERIDO', 401, 'La operación necesita un usuario en sesión')

  const b = body ?? {}
  const codigo = textoRequerido(b.codigo, 'el código', { max: 20 })
  const nombre = textoRequerido(b.nombre, 'el nombre', { max: 120 })
  const tipo = assertEnLista(b.tipo, TIPOS_CUENTA, 'Tipo de cuenta', 'CUENTA_TIPO_INVALIDO')
  const descripcion = textoOpcional(b.descripcion)
  const parentId = b.parentId === undefined || b.parentId === null || b.parentId === ''
    ? null
    : exigirCuenta(ctx, b.parentId, 'CUENTA_PADRE_NO_ENCONTRADA')
  const ts = new Date().toISOString()

  return ctx.tx(() => {
    let info
    try {
      info = ctx.db
        .prepare(
          `INSERT INTO cuentas_contables
             (codigo, nombre, tipo, descripcion, parent_id, activo, negocio_id, user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
        )
        .run(codigo, nombre, tipo, descripcion, parentId, ctx.negocioId, ctx.actorId, ts, ts)
    } catch (err) {
      if (esViolacionUnicaEn(err, 'cuentas_contables.codigo', 'cuentas_contables.negocio_id')) {
        throw new IpcError('CUENTA_CODIGO_DUPLICADO', 400, `El código "${codigo}" ya existe en este plan de cuentas`)
      }
      throw err
    }
    const id = Number(info.lastInsertRowid)
    auditar(ctx, 'cuentas_contables', id, 'CREATE', null, { codigo, nombre, tipo })
    return mapCuenta(ctx.db.prepare('SELECT * FROM cuentas_contables WHERE id = ?').get(id))
  })
}

/**
 * Update an account. Partial, like every other repository here: an absent key leaves the column
 * alone and an explicit empty string clears it.
 *
 * `codigo` and `tipo` ARE EDITABLE and that is a decision worth stating, because both are dangerous:
 * changing `tipo` changes the SIGN of every balance already computed through the account, and
 * changing `codigo` breaks any report a human ran last month that named the code. They are allowed
 * because a mistyped account is a real thing an owner needs to fix, and the alternative — an
 * account that has to be deleted and recreated, taking its history with it — is worse. The
 * `auditoria` row records both, so a sign that flipped is answerable after the fact.
 */
export function actualizarCuenta(ctx, id, body) {
  requireTenant(ctx.negocioId)
  if (!ctx.actorId) throw new IpcError('ACTOR_REQUERIDO', 401, 'La operación necesita un usuario en sesión')

  const cuentaId = assertId(id, 'cuenta')
  const actual = ctx.db
    .prepare('SELECT * FROM cuentas_contables WHERE id = ? AND negocio_id = ?')
    .get(cuentaId, ctx.negocioId)
  if (!actual) throw new IpcError('CUENTA_NO_ENCONTRADA', 404, 'Cuenta no encontrada')

  const b = body ?? {}
  const codigo = b.codigo === undefined ? actual.codigo : textoRequerido(b.codigo, 'el código', { max: 20 })
  const nombre = b.nombre === undefined ? actual.nombre : textoRequerido(b.nombre, 'el nombre', { max: 120 })
  const tipo = b.tipo === undefined
    ? actual.tipo
    : assertEnLista(b.tipo, TIPOS_CUENTA, 'Tipo de cuenta', 'CUENTA_TIPO_INVALIDO')
  const descripcion = b.descripcion === undefined ? actual.descripcion : textoOpcional(b.descripcion)
  const activo = b.activo === undefined ? actual.activo : b.activo ? 1 : 0
  const parentId = b.parentId === undefined
    ? actual.parent_id
    : b.parentId === null || b.parentId === ''
      ? null
      : exigirCuenta(ctx, b.parentId, 'CUENTA_PADRE_NO_ENCONTRADA')

  if (parentId === cuentaId) {
    throw new IpcError('CUENTA_PADRE_CICLICA', 400, 'Una cuenta no puede ser su propia cuenta padre')
  }
  // A cycle of length two is the one a form can actually produce, and the deeper ones need a walk.
  // Cheaper to refuse the whole class than to be right about the shallow case only.
  if (parentId !== null) {
    let cursor = parentId
    const vistos = new Set()
    while (cursor !== null && !vistos.has(cursor)) {
      vistos.add(cursor)
      const fila = ctx.db
        .prepare('SELECT parent_id FROM cuentas_contables WHERE id = ? AND negocio_id = ?')
        .get(cursor, ctx.negocioId)
      cursor = fila?.parent_id ?? null
      if (cursor === cuentaId) {
        throw new IpcError('CUENTA_PADRE_CICLICA', 400, 'La cuenta padre elegida ya depende de esta cuenta')
      }
    }
  }

  const ts = new Date().toISOString()
  return ctx.tx(() => {
    try {
      ctx.db
        .prepare(
          `UPDATE cuentas_contables
              SET codigo = ?, nombre = ?, tipo = ?, descripcion = ?, parent_id = ?, activo = ?, updated_at = ?
            WHERE id = ? AND negocio_id = ?`
        )
        .run(codigo, nombre, tipo, descripcion, parentId, activo, ts, cuentaId, ctx.negocioId)
    } catch (err) {
      if (esViolacionUnicaEn(err, 'cuentas_contables.codigo', 'cuentas_contables.negocio_id')) {
        throw new IpcError('CUENTA_CODIGO_DUPLICADO', 400, `El código "${codigo}" ya existe en este plan de cuentas`)
      }
      throw err
    }
    auditar(
      ctx, 'cuentas_contables', cuentaId, 'UPDATE',
      { codigo: actual.codigo, nombre: actual.nombre, tipo: actual.tipo, activo: actual.activo },
      { codigo, nombre, tipo, activo }
    )
    return mapCuenta(ctx.db.prepare('SELECT * FROM cuentas_contables WHERE id = ?').get(cuentaId))
  })
}

/**
 * Remove an account. REFUSED whenever it is used, and the two reasons are counted so the refusal
 * can say which.
 *
 * `detalles_asientos.cuenta_contable_id` is `ON DELETE RESTRICT`, so the database would refuse this
 * anyway — with a constraint error nobody can act on. The checks here turn it into a 409 that names
 * the number of lines, which is the difference between "no se puede" and "no se puede: tiene 412
 * movimientos, desactivala".
 *
 * AN ACCOUNT WITH MOVEMENTS IS NEVER DELETED, and that is not strictness. `balanceGeneral` groups
 * over `cuentas_contables` with a LEFT JOIN, so deleting an account would REMOVE its sums from the
 * trial balance while its lines stayed in `detalles_asientos` — the ledger would stop balancing
 * against itself and the report would look fine. Deleting a master row that history points at is
 * the defect `proveedores.repo.js` records for suppliers, in the one place where it also breaks an
 * accounting invariant.
 */
export function eliminarCuenta(ctx, id) {
  requireTenant(ctx.negocioId)
  if (!ctx.actorId) throw new IpcError('ACTOR_REQUERIDO', 401, 'La operación necesita un usuario en sesión')

  const cuentaId = assertId(id, 'cuenta')
  const actual = ctx.db
    .prepare('SELECT * FROM cuentas_contables WHERE id = ? AND negocio_id = ?')
    .get(cuentaId, ctx.negocioId)
  if (!actual) throw new IpcError('CUENTA_NO_ENCONTRADA', 404, 'Cuenta no encontrada')

  const movimientos = ctx.db
    .prepare('SELECT COUNT(*) AS n FROM detalles_asientos WHERE cuenta_contable_id = ? AND negocio_id = ?')
    .get(cuentaId, ctx.negocioId).n
  if (movimientos > 0) {
    throw new IpcError(
      'CUENTA_CON_MOVIMIENTOS',
      409,
      `La cuenta "${actual.codigo} ${actual.nombre}" tiene ${movimientos} movimiento(s) en el libro mayor: ` +
        'no se puede eliminar sin descuadrar el balance. Desactivala en su lugar.'
    )
  }
  const hijas = ctx.db
    .prepare('SELECT COUNT(*) AS n FROM cuentas_contables WHERE parent_id = ? AND negocio_id = ?')
    .get(cuentaId, ctx.negocioId).n
  if (hijas > 0) {
    throw new IpcError(
      'CUENTA_CON_HIJAS',
      409,
      `La cuenta "${actual.codigo} ${actual.nombre}" agrupa ${hijas} cuenta(s): reasignálas antes de eliminarla.`
    )
  }

  return ctx.tx(() => {
    ctx.db.prepare('DELETE FROM cuentas_contables WHERE id = ? AND negocio_id = ?').run(cuentaId, ctx.negocioId)
    auditar(ctx, 'cuentas_contables', cuentaId, 'DELETE', { codigo: actual.codigo, nombre: actual.nombre }, null)
    return { id: cuentaId, eliminada: true }
  })
}

/** One account of THIS business, or a refusal. The tenant check is the point. */
function exigirCuenta(ctx, id, codigoError) {
  const cuentaId = assertId(id, 'cuenta')
  const fila = ctx.db
    .prepare('SELECT id FROM cuentas_contables WHERE id = ? AND negocio_id = ?')
    .get(cuentaId, ctx.negocioId)
  if (!fila) throw new IpcError(codigoError, 400, `Cuenta contable ${cuentaId} no encontrada`)
  return cuentaId
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// ASIENTOS
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The journal, newest first, with each entry's total.
 *
 * `referencia` is filterable because it is how a machine-written entry is traced back to what
 * caused it (`venta:12`, `compra:4`, `pago:9`). An owner looking for "the entry for sale 12" has no
 * other handle: the description is prose.
 */
export function listarAsientos(ctx, { search = '', tipo, desde = null, hasta = null, limit = 50, offset = 0 } = {}) {
  requireTenant(ctx.negocioId)

  const cond = ['a.negocio_id = ?']
  const args = [ctx.negocioId]

  const q = textoOpcional(search)
  if (q !== null) {
    cond.push("(a.descripcion LIKE ? ESCAPE '\\' OR a.referencia LIKE ? ESCAPE '\\')")
    const patron = `%${escaparLike(q.toLowerCase())}%`
    args.push(patron, patron)
  }
  if (tipo !== undefined && tipo !== null && tipo !== '' && tipo !== 'todos') {
    cond.push('a.tipo = ?')
    args.push(assertEnLista(tipo, TIPOS_ASIENTO, 'Tipo de asiento', 'ASIENTO_TIPO_INVALIDO'))
  }
  if (textoOpcional(desde) !== null) {
    cond.push('a.fecha >= ?')
    args.push(desde)
  }
  if (textoOpcional(hasta) !== null) {
    cond.push('a.fecha <= ?')
    args.push(hasta)
  }
  const where = cond.join(' AND ')

  const total = ctx.db.prepare(`SELECT COUNT(*) AS n FROM asientos_contables a WHERE ${where}`).get(...args).n
  const filas = ctx.db
    .prepare(
      `SELECT a.*,
              (SELECT COUNT(*) FROM detalles_asientos d
                WHERE d.asiento_contable_id = a.id AND d.negocio_id = a.negocio_id) AS partidas
         FROM asientos_contables a
        WHERE ${where}
        ORDER BY a.fecha DESC, a.id DESC
        LIMIT ? OFFSET ?`
    )
    .all(...args, limit, offset)

  return {
    filas: filas.map((f) => ({ ...mapAsiento(f), partidas: f.partidas })),
    total
  }
}

/**
 * One entry with its lines, each carrying its account.
 *
 * The lines are ordered by SIDE — debits first, then credits — and not by id, because a journal
 * entry is read the way it is written: what came in, then what went out. `id` breaks the tie so the
 * order is stable.
 */
export function obtenerAsiento(ctx, id) {
  requireTenant(ctx.negocioId)
  const asientoId = assertId(id, 'asiento')
  const row = ctx.db
    .prepare('SELECT * FROM asientos_contables WHERE id = ? AND negocio_id = ?')
    .get(asientoId, ctx.negocioId)
  if (!row) throw new IpcError('ASIENTO_NO_ENCONTRADO', 404, 'Asiento no encontrado')

  const detalles = ctx.db
    .prepare(
      `SELECT d.*, c.codigo, c.nombre AS cuenta_nombre, c.tipo AS cuenta_tipo
         FROM detalles_asientos d
         JOIN cuentas_contables c ON c.id = d.cuenta_contable_id AND c.negocio_id = d.negocio_id
        WHERE d.asiento_contable_id = ? AND d.negocio_id = ?
        ORDER BY (d.debe_centavos = 0) ASC, d.id ASC`
    )
    .all(asientoId, ctx.negocioId)

  const debe = detalles.reduce((s, d) => s + d.debe_centavos, 0)
  const haber = detalles.reduce((s, d) => s + d.haber_centavos, 0)

  return {
    ...mapAsiento(row),
    detalles: detalles.map(mapDetalle),
    totalDebeCentavos: debe,
    totalHaberCentavos: haber,
    balanceado: debe === haber
  }
}

/**
 * Write an entry by hand — the one place a person can put money in the ledger that no sale explains.
 *
 * ── WHY THE SHAPE IS VALIDATED HERE AND THE BALANCE SOMEWHERE ELSE ────────────────────────────
 *
 * Two different refusals for two different mistakes, and the operator needs to be told which one
 * they made:
 *
 *   - FEWER THAN TWO LINES is a SHAPE error. A journal entry with one line cannot balance unless it
 *     is zero, and zero is not an entry. Refusing it as `ASIENTO_DESBALANCEADO` would be true and
 *     useless: the person typed one line, and the answer should say so.
 *   - DEBITS != CREDITS is a BALANCE error, and `asentar` owns that check because it owns the
 *     invariant for every writer, machine or human. Duplicating it here would be the second
 *     implementation of the one rule that must not have two.
 *
 * A line with both sides non-zero is refused by `asentar` too (`ASIENTO_PARTIDA_DOBLE`): in
 * double-entry a line moves ONE side, and a row claiming the same peso was spent and received twice
 * can still satisfy `SUM(debe) = SUM(haber)`.
 */
export function crearAsiento(ctx, body) {
  requireTenant(ctx.negocioId)
  if (!ctx.actorId) throw new IpcError('ACTOR_REQUERIDO', 401, 'La operación necesita un usuario en sesión')

  const b = body ?? {}
  const descripcion = textoRequerido(b.descripcion, 'la descripción', { max: 200 })
  const tipo = assertEnLista(b.tipo, TIPOS_ASIENTO, 'Tipo de asiento', 'ASIENTO_TIPO_INVALIDO')
  const fecha = fechaIso(b.fecha, 'La fecha')
  const referencia = textoOpcional(b.referencia)

  const partidas = Array.isArray(b.partidas) ? b.partidas : []
  if (partidas.length < 2) {
    throw new IpcError(
      'ASIENTO_POCO_PARTIDAS',
      400,
      `Un asiento necesita al menos dos partidas (una al debe y una al haber); llegaron ${partidas.length}.`
    )
  }

  // Each partida arrives in the RENDERER's units — pesos — like every other amount in this app, and
  // is parsed to integer centavos here. `toCents` refuses a thousands separator, which is the
  // `1.050` ambiguity the money module exists to prevent.
  const lineas = partidas.map((p, i) => {
    const cuentaId = exigirCuenta(ctx, p?.cuentaId, 'CUENTA_NO_ENCONTRADA')
    const debe = p?.debe === undefined || p.debe === null || p.debe === '' ? 0 : toCents(p.debe, `debe de la partida ${i + 1}`)
    const haber = p?.haber === undefined || p.haber === null || p.haber === '' ? 0 : toCents(p.haber, `haber de la partida ${i + 1}`)
    if (debe < 0 || haber < 0) {
      throw new IpcError('ASIENTO_MONTO_NEGATIVO', 400, `La partida ${i + 1} tiene un monto negativo`)
    }
    return {
      cuentaId,
      debeCentavos: assertCents(debe, `debe de la partida ${i + 1}`),
      haberCentavos: assertCents(haber, `haber de la partida ${i + 1}`),
      descripcion: textoOpcional(p?.descripcion)
    }
  })

  return ctx.tx(() => {
    // `asentar` opens no transaction of its own by design (it is called mid-sale elsewhere), so the
    // header, the lines and the audit row are one unit here.
    const res = asentar(ctx, { fecha, descripcion, tipo, referencia, partidas: lineas })
    if (!res) {
      throw new IpcError(
        'ASIENTO_VACIO',
        400,
        'Todas las partidas están en cero: un asiento sin montos no mueve nada y no se escribe.'
      )
    }
    auditar(ctx, 'asientos_contables', res.id, 'CREATE', null, { descripcion, tipo, total: res.debe })
    return obtenerAsiento(ctx, res.id)
  })
}

/**
 * Remove an entry, with its lines.
 *
 * `detalles_asientos.asiento_contable_id` is `ON DELETE CASCADE`, so the lines go with the header
 * and the ledger cannot be left with orphan lines. WHAT THIS DOES NOT DO is post a reversal: this
 * removes history, it does not correct it. A shop that needs to fix a wrong entry should write the
 * correcting entry instead, and the API's `deleteEntry` is here because it is in the frozen
 * contract and because a mistyped HAND-WRITTEN entry is a real thing.
 *
 * AN ENTRY THAT A FEATURE WROTE IS REFUSED. Every machine-written entry carries a `referencia`
 * (`venta:12`, `pago:3`); deleting one would leave the sale without its journal row — the exact
 * state `cuentas.repo.js` was written to end — and the report would silently stop reconciling
 * against the ledger. Cancelling the SALE is what reverses a sale's entry, and it does it by
 * writing the mirror entry rather than by erasing this one.
 */
export function eliminarAsiento(ctx, id) {
  requireTenant(ctx.negocioId)
  if (!ctx.actorId) throw new IpcError('ACTOR_REQUERIDO', 401, 'La operación necesita un usuario en sesión')

  const asientoId = assertId(id, 'asiento')
  const actual = ctx.db
    .prepare('SELECT * FROM asientos_contables WHERE id = ? AND negocio_id = ?')
    .get(asientoId, ctx.negocioId)
  if (!actual) throw new IpcError('ASIENTO_NO_ENCONTRADO', 404, 'Asiento no encontrado')

  if (actual.referencia !== null && actual.referencia !== '') {
    throw new IpcError(
      'ASIENTO_DE_SISTEMA',
      409,
      `El asiento #${asientoId} lo escribió la app (referencia "${actual.referencia}") y no se puede borrar: ` +
        'anulá la operación que lo generó, que registra el asiento espejo.'
    )
  }

  return ctx.tx(() => {
    ctx.db.prepare('DELETE FROM asientos_contables WHERE id = ? AND negocio_id = ?').run(asientoId, ctx.negocioId)
    auditar(ctx, 'asientos_contables', asientoId, 'DELETE', { descripcion: actual.descripcion, total: actual.monto_total_centavos }, null)
    return { id: asientoId, eliminado: true }
  })
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// DEUDAS DEL NEGOCIO
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * What the SHOP owes — the other side of the ledger from `deudores`, which is what customers owe it.
 *
 * These two are easy to confuse and they are opposites: `1.3.01 Clientes (Deudores)` is an ASSET,
 * money coming in, and this table's `2.2.0x Préstamo *` accounts are LIABILITIES, money going out.
 * The screen says which in words, because "deuda" alone is ambiguous in a shop's own vocabulary.
 */
export function listarDeudas(ctx, { search = '', tipo, estado, limit = 50, offset = 0 } = {}) {
  requireTenant(ctx.negocioId)

  const cond = ['d.negocio_id = ?']
  const args = [ctx.negocioId]

  const q = textoOpcional(search)
  if (q !== null) {
    cond.push("(d.nombre LIKE ? ESCAPE '\\' OR d.contacto_nombre LIKE ? ESCAPE '\\')")
    const patron = `%${escaparLike(q.toLowerCase())}%`
    args.push(patron, patron)
  }
  if (tipo !== undefined && tipo !== null && tipo !== '' && tipo !== 'todos') {
    cond.push('d.tipo = ?')
    args.push(assertEnLista(tipo, TIPOS_DEUDA, 'Tipo de deuda', 'DEUDA_TIPO_INVALIDO'))
  }
  if (estado !== undefined && estado !== null && estado !== '' && estado !== 'todos') {
    cond.push('d.estado = ?')
    args.push(assertEnLista(estado, ESTADOS_DEUDA, 'Estado de deuda', 'DEUDA_ESTADO_INVALIDO'))
  }
  const where = cond.join(' AND ')

  const total = ctx.db.prepare(`SELECT COUNT(*) AS n FROM cuentas_corrientes_deudas d WHERE ${where}`).get(...args).n
  const filas = ctx.db
    .prepare(
      `SELECT d.*,
              (SELECT COUNT(*) FROM pagos_deuda_contabilidad p
                WHERE p.cuenta_corriente_deuda_id = d.id AND p.negocio_id = d.negocio_id) AS pagos
         FROM cuentas_corrientes_deudas d
        WHERE ${where}
        ORDER BY (d.estado = 'pagado') ASC, d.fecha_vencimiento IS NULL ASC, d.fecha_vencimiento ASC, d.id DESC
        LIMIT ? OFFSET ?`
    )
    .all(...args, limit, offset)

  // The order is deliberate: unpaid first, then the ones with a due date, soonest first. A list of
  // debts is read to decide what to pay next, so the settled ones sink and the overdue ones surface.
  return { filas: filas.map(mapDeuda), total }
}

export function obtenerDeuda(ctx, id) {
  requireTenant(ctx.negocioId)
  const deudaId = assertId(id, 'deuda')
  const row = ctx.db
    .prepare(
      `SELECT d.*,
              (SELECT COUNT(*) FROM pagos_deuda_contabilidad p
                WHERE p.cuenta_corriente_deuda_id = d.id AND p.negocio_id = d.negocio_id) AS pagos
         FROM cuentas_corrientes_deudas d
        WHERE d.id = ? AND d.negocio_id = ?`
    )
    .get(deudaId, ctx.negocioId)
  if (!row) throw new IpcError('DEUDA_NO_ENCONTRADA', 404, 'Deuda no encontrada')
  return { ...mapDeuda(row), pagosDetalle: listarPagosDeuda(ctx, deudaId) }
}

/**
 * Record a debt the shop took on.
 *
 * `saldo_pendiente_centavos` STARTS EQUAL TO `monto_original_centavos` and is never taken from the
 * caller. A form that let the operator type the remaining balance could create a debt that is born
 * half-paid, which is a state only a payment can produce — and the payments are the rows that
 * explain it.
 */
export function crearDeuda(ctx, body) {
  requireTenant(ctx.negocioId)
  if (!ctx.actorId) throw new IpcError('ACTOR_REQUERIDO', 401, 'La operación necesita un usuario en sesión')

  const b = body ?? {}
  const nombre = textoRequerido(b.nombre, 'el nombre', { max: 150 })
  const tipo = assertEnLista(b.tipo ?? 'otro', TIPOS_DEUDA, 'Tipo de deuda', 'DEUDA_TIPO_INVALIDO')
  const montoCentavos = assertCents(toCents(b.montoOriginal, 'monto original'), 'monto original')
  if (montoCentavos < 1) {
    throw new IpcError('DEUDA_MONTO_INVALIDO', 400, 'El monto de la deuda debe ser mayor a cero')
  }
  const tasaInteres = tasaOpcional(b.tasaInteres, 'La tasa de interés')
  const cuotasTotales = enteroOpcional(b.cuotasTotales, 'Las cuotas totales', { min: 1 })
  const montoCuotaCentavos = b.montoCuota === undefined || b.montoCuota === null || b.montoCuota === ''
    ? null
    : assertCents(toCents(b.montoCuota, 'monto de cuota'), 'monto de cuota')
  const fechaInicio = fechaIso(b.fechaInicio, 'La fecha de inicio')
  const fechaVencimiento = b.fechaVencimiento === undefined || b.fechaVencimiento === null || b.fechaVencimiento === ''
    ? null
    : fechaIso(b.fechaVencimiento, 'La fecha de vencimiento')
  const proveedorId = b.proveedorId === undefined || b.proveedorId === null || b.proveedorId === ''
    ? null
    : assertId(b.proveedorId, 'proveedor')
  const ts = new Date().toISOString()

  return ctx.tx(() => {
    const info = ctx.db
      .prepare(
        `INSERT INTO cuentas_corrientes_deudas
           (nombre, tipo, monto_original_centavos, saldo_pendiente_centavos, tasa_interes, cuotas_totales,
            cuotas_pagadas, monto_cuota_centavos, fecha_inicio, fecha_vencimiento, estado,
            contacto_nombre, contacto_telefono, proveedor_id, notas, negocio_id, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'activo', ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        nombre, tipo, montoCentavos, montoCentavos, tasaInteres, cuotasTotales,
        montoCuotaCentavos, fechaInicio, fechaVencimiento,
        textoOpcional(b.contactoNombre), textoOpcional(b.contactoTelefono), proveedorId,
        textoOpcional(b.notas), ctx.negocioId, ctx.actorId, ts, ts
      )
    const id = Number(info.lastInsertRowid)
    auditar(ctx, 'cuentas_corrientes_deudas', id, 'CREATE', null, { nombre, tipo, montoCentavos })
    return mapDeuda(ctx.db.prepare('SELECT * FROM cuentas_corrientes_deudas WHERE id = ?').get(id))
  })
}

/**
 * Update a debt. Partial, and `saldo_pendiente_centavos` is NOT in the accepted field set.
 *
 * The remaining balance moves through `addDebtPayment` and nowhere else, so there is exactly one
 * writer and the payments always explain the number. Letting this endpoint set it would let a shop
 * declare a debt settled without recording that any money moved, which is the one thing a ledger
 * must not allow.
 *
 * `estado` IS editable, because "this one is paid off" and "this one is overdue" are things a person
 * knows and the app cannot infer: nothing here schedules payments.
 */
export function actualizarDeuda(ctx, id, body) {
  requireTenant(ctx.negocioId)
  if (!ctx.actorId) throw new IpcError('ACTOR_REQUERIDO', 401, 'La operación necesita un usuario en sesión')

  const deudaId = assertId(id, 'deuda')
  const actual = ctx.db
    .prepare('SELECT * FROM cuentas_corrientes_deudas WHERE id = ? AND negocio_id = ?')
    .get(deudaId, ctx.negocioId)
  if (!actual) throw new IpcError('DEUDA_NO_ENCONTRADA', 404, 'Deuda no encontrada')

  const b = body ?? {}
  const nombre = b.nombre === undefined ? actual.nombre : textoRequerido(b.nombre, 'el nombre', { max: 150 })
  const tipo = b.tipo === undefined
    ? actual.tipo
    : assertEnLista(b.tipo, TIPOS_DEUDA, 'Tipo de deuda', 'DEUDA_TIPO_INVALIDO')
  const estado = b.estado === undefined
    ? actual.estado
    : assertEnLista(b.estado, ESTADOS_DEUDA, 'Estado de deuda', 'DEUDA_ESTADO_INVALIDO')
  const tasaInteres = b.tasaInteres === undefined ? actual.tasa_interes : tasaOpcional(b.tasaInteres, 'La tasa de interés')
  const cuotasTotales = b.cuotasTotales === undefined
    ? actual.cuotas_totales
    : enteroOpcional(b.cuotasTotales, 'Las cuotas totales', { min: 1 })
  const montoCuotaCentavos = b.montoCuota === undefined
    ? actual.monto_cuota_centavos
    : b.montoCuota === null || b.montoCuota === ''
      ? null
      : assertCents(toCents(b.montoCuota, 'monto de cuota'), 'monto de cuota')
  const fechaVencimiento = b.fechaVencimiento === undefined
    ? actual.fecha_vencimiento
    : b.fechaVencimiento === null || b.fechaVencimiento === ''
      ? null
      : fechaIso(b.fechaVencimiento, 'La fecha de vencimiento')
  const proveedorId = b.proveedorId === undefined
    ? actual.proveedor_id
    : b.proveedorId === null || b.proveedorId === ''
      ? null
      : assertId(b.proveedorId, 'proveedor')

  if (estado === 'pagado' && actual.saldo_pendiente_centavos > 0) {
    throw new IpcError(
      'DEUDA_CON_SALDO',
      409,
      `La deuda todavía tiene ${formatCents(actual.saldo_pendiente_centavos)} pendiente: ` +
        'registrá el pago antes de marcarla como pagada.'
    )
  }
  // AND THE OTHER DIRECTION, which is the one that bit while this file was being written: a debt
  // with NOTHING left to pay cannot be `activo` or `vencido`.
  //
  // The panel and the list sort unpaid first, precisely so that "what do I have to pay" is the top
  // of the screen. A settled debt parked back in that bucket is a row the owner will chase forever,
  // and the number next to it reads zero — a contradiction the screen cannot explain because the
  // state itself is the lie. `registrarPagoDeuda` already settles a debt the moment its balance
  // reaches zero; this refuses the state a caller could write around it.
  if (estado !== 'pagado' && actual.saldo_pendiente_centavos === 0) {
    throw new IpcError(
      'DEUDA_SALDADA',
      409,
      `La deuda "${actual.nombre}" no tiene saldo pendiente y ya figura como pagada. ` +
        'Si le agregás un monto nuevo, cargá otra deuda.'
    )
  }

  const ts = new Date().toISOString()
  return ctx.tx(() => {
    ctx.db
      .prepare(
        `UPDATE cuentas_corrientes_deudas
            SET nombre = ?, tipo = ?, tasa_interes = ?, cuotas_totales = ?, monto_cuota_centavos = ?,
                fecha_vencimiento = ?, estado = ?, contacto_nombre = ?, contacto_telefono = ?,
                proveedor_id = ?, notas = ?, updated_at = ?
          WHERE id = ? AND negocio_id = ?`
      )
      .run(
        nombre, tipo, tasaInteres, cuotasTotales, montoCuotaCentavos, fechaVencimiento, estado,
        b.contactoNombre === undefined ? actual.contacto_nombre : textoOpcional(b.contactoNombre),
        b.contactoTelefono === undefined ? actual.contacto_telefono : textoOpcional(b.contactoTelefono),
        proveedorId,
        b.notas === undefined ? actual.notas : textoOpcional(b.notas),
        ts, deudaId, ctx.negocioId
      )
    auditar(ctx, 'cuentas_corrientes_deudas', deudaId, 'UPDATE',
      { nombre: actual.nombre, estado: actual.estado }, { nombre, estado })
    return mapDeuda(ctx.db.prepare('SELECT * FROM cuentas_corrientes_deudas WHERE id = ?').get(deudaId))
  })
}

/** Every payment of one debt, oldest first — the order a statement is read in. */
export function listarPagosDeuda(ctx, deudaId) {
  requireTenant(ctx.negocioId)
  const id = assertId(deudaId, 'deuda')
  return ctx.db
    .prepare(
      `SELECT * FROM pagos_deuda_contabilidad
        WHERE cuenta_corriente_deuda_id = ? AND negocio_id = ?
        ORDER BY fecha ASC, id ASC`
    )
    .all(id, ctx.negocioId)
    .map(mapPago)
}

/**
 * Record a payment against a debt, and move the remaining balance by exactly that amount.
 *
 * ── THE TWO WRITES ARE ONE TRANSACTION, AND THE SECOND ONE IS DERIVED ─────────────────────────
 *
 * The payment row and the `saldo_pendiente_centavos` it reduces are written together, and the new
 * balance is computed from the OLD ONE IN THE ROW — re-read inside the transaction, not taken from
 * the caller's snapshot. A screen that had been open for a minute would otherwise write a balance
 * computed from a stale number, and the difference would be a debt that is quietly wrong by whatever
 * happened in between.
 *
 * ── OVERPAYMENT IS REFUSED ────────────────────────────────────────────────────────────────────
 *
 * Paying more than is owed is not a payment, it is a data-entry mistake or a credit the schema has
 * nowhere to put: `saldo_pendiente_centavos` would go negative and every figure derived from it
 * (percentage paid, "is it settled") would be nonsense. The refusal names the remaining amount so
 * the operator can type the right number.
 */
export function registrarPagoDeuda(ctx, body) {
  requireTenant(ctx.negocioId)
  if (!ctx.actorId) throw new IpcError('ACTOR_REQUERIDO', 401, 'La operación necesita un usuario en sesión')

  const b = body ?? {}
  const deudaId = assertId(b.deudaId ?? b.cuentaCorrienteDeudaId, 'deuda')
  const montoCentavos = assertCents(toCents(b.monto, 'monto'), 'monto')
  if (montoCentavos < 1) {
    throw new IpcError('PAGO_MONTO_INVALIDO', 400, 'El pago debe ser mayor a cero')
  }
  const metodoPago = assertEnLista(b.metodoPago ?? 'efectivo', METODOS_PAGO, 'Método de pago', 'PAGO_METODO_INVALIDO')
  const fecha = fechaIso(b.fecha, 'La fecha')
  const numeroCuota = enteroOpcional(b.numeroCuota, 'El número de cuota', { min: 1 })
  const ts = new Date().toISOString()

  return ctx.tx(() => {
    const deuda = ctx.db
      .prepare('SELECT * FROM cuentas_corrientes_deudas WHERE id = ? AND negocio_id = ?')
      .get(deudaId, ctx.negocioId)
    if (!deuda) throw new IpcError('DEUDA_NO_ENCONTRADA', 404, 'Deuda no encontrada')

    if (montoCentavos > deuda.saldo_pendiente_centavos) {
      throw new IpcError(
        'PAGO_EXCEDE_SALDO',
        400,
        `El pago de ${formatCents(montoCentavos)} supera el saldo pendiente de ` +
          `${formatCents(deuda.saldo_pendiente_centavos)}.`
      )
    }

    const info = ctx.db
      .prepare(
        `INSERT INTO pagos_deuda_contabilidad
           (cuenta_corriente_deuda_id, monto_centavos, fecha, metodo_pago, numero_cuota, observaciones,
            negocio_id, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(deudaId, montoCentavos, fecha, metodoPago, numeroCuota, textoOpcional(b.observaciones),
           ctx.negocioId, ctx.actorId, ts, ts)
    const pagoId = Number(info.lastInsertRowid)

    const saldoNuevo = deuda.saldo_pendiente_centavos - montoCentavos
    // `cuotas_pagadas` only advances when the payment NAMES a instalment. Counting every payment as
    // one would turn four partial payments of the same instalment into four instalments paid, and
    // the schedule would claim a debt is further along than it is.
    const cuotasPagadas = numeroCuota === null
      ? deuda.cuotas_pagadas
      : Math.max(deuda.cuotas_pagadas, numeroCuota)
    // Settled by the money, never by the operator: a debt with nothing left to pay IS paid, and
    // leaving it `activo` would keep it in the list of things to pay forever. The reverse is NOT
    // automatic — a debt marked `vencido` stays that way until a person says otherwise, because
    // nothing here knows the agreed schedule.
    const estado = saldoNuevo === 0 ? 'pagado' : deuda.estado === 'pagado' ? 'activo' : deuda.estado

    ctx.db
      .prepare(
        `UPDATE cuentas_corrientes_deudas
            SET saldo_pendiente_centavos = ?, cuotas_pagadas = ?, estado = ?, updated_at = ?
          WHERE id = ? AND negocio_id = ?`
      )
      .run(saldoNuevo, cuotasPagadas, estado, ts, deudaId, ctx.negocioId)

    auditar(ctx, 'pagos_deuda_contabilidad', pagoId, 'CREATE',
      { saldoAnterior: deuda.saldo_pendiente_centavos },
      { montoCentavos, saldoNuevo, metodoPago })

    return {
      pago: mapPago(ctx.db.prepare('SELECT * FROM pagos_deuda_contabilidad WHERE id = ?').get(pagoId)),
      deuda: mapDeuda(ctx.db.prepare('SELECT * FROM cuentas_corrientes_deudas WHERE id = ?').get(deudaId))
    }
  })
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// BALANCE Y PANEL
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The trial balance: every account with its debits, credits and signed balance.
 *
 * NOTHING IS SUMMED TWICE AND NOTHING IS INVENTED. `balanceGeneral` (in `cuentas.repo.js`) does the
 * grouping, and `saldoDeTipo` decides the sign per account type — the same two functions the
 * reports use. Re-implementing either here would create a second opinion about whether a liability
 * is positive, which is the one number in a balance sheet that must never be a guess.
 *
 * `cuadra` is the whole point of the report and it is reported rather than assumed: total debits
 * and total credits over the whole chart must be equal, because every entry that reached the
 * database was refused if it was not. A `false` here means an entry got in around `asentar`, and
 * saying so on the screen is more useful than a green tick nobody can audit.
 */
export function balance(ctx, { conSaldo = false } = {}) {
  requireTenant(ctx.negocioId)
  asegurarPlanSiFalta(ctx)

  const filas = balanceGeneral(ctx.db, ctx.negocioId)
  const cuentas = filas.map(mapCuenta).filter((c) => (conSaldo ? c.movimientos > 0 || c.debeCentavos !== 0 || c.haberCentavos !== 0 : true))

  const totalDebe = cuentas.reduce((s, c) => s + c.debeCentavos, 0)
  const totalHaber = cuentas.reduce((s, c) => s + c.haberCentavos, 0)

  // One bucket per type, which is what a balance sheet is: what the shop HAS (activo), what it OWES
  // (pasivo), what was put in (capital), what it earned (ingreso) and what it spent (gasto).
  const porTipo = {}
  for (const c of cuentas) {
    porTipo[c.tipo] = (porTipo[c.tipo] ?? 0) + c.saldoCentavos
  }

  return {
    cuentas,
    totalDebeCentavos: totalDebe,
    totalHaberCentavos: totalHaber,
    // `===` and not a tolerance: these are integer centavos summed the same way on both sides.
    cuadra: totalDebe === totalHaber,
    diferenciaCentavos: totalDebe - totalHaber,
    // The accounting equation, in the shop's own terms. `activo = pasivo + capital` plus the
    // period's result: an income account has a credit balance, so it is what makes the two sides
    // meet after a profitable period and it belongs in the sum rather than beside it.
    activoCentavos: porTipo.activo ?? 0,
    pasivoCentavos: porTipo.pasivo ?? 0,
    capitalCentavos: porTipo.capital ?? 0,
    ingresosCentavos: porTipo.ingreso ?? 0,
    gastosCentavos: porTipo.gasto ?? 0,
    resultadoCentavos: (porTipo.ingreso ?? 0) - (porTipo.gasto ?? 0),
    porTipoCentavos: porTipo
  }
}

/**
 * `contabilidad.dashboard` — the four figures an owner opens this section to see.
 *
 * EVERY ONE OF THEM IS DERIVED FROM THE LEDGER, in the same read, so the panel cannot disagree with
 * the balance screen or with the income statement: they are the same sums read through the same
 * functions. Nothing here is stored, and nothing is recomputed with different arithmetic.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is repeat the reports. `reportes.incomeStatement` already answers
 * the period's result over a date range and it answers it well; this panel answers "where does the
 * shop stand RIGHT NOW", which is a different question with no date range in it.
 */
export function dashboard(ctx) {
  requireTenant(ctx.negocioId)
  asegurarPlanSiFalta(ctx)

  const b = balance(ctx, {})

  const deudas = ctx.db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN estado <> 'pagado' THEN saldo_pendiente_centavos END), 0) AS pendiente,
         COALESCE(SUM(monto_original_centavos), 0)                                       AS original,
         COUNT(*)                                                                        AS total,
         SUM(CASE WHEN estado <> 'pagado' THEN 1 ELSE 0 END)                             AS abiertas
       FROM cuentas_corrientes_deudas
      WHERE negocio_id = ?`
    )
    .get(ctx.negocioId)

  const asientos = ctx.db
    .prepare('SELECT COUNT(*) AS n, COALESCE(MAX(fecha), NULL) AS ultimo FROM asientos_contables WHERE negocio_id = ?')
    .get(ctx.negocioId)

  return {
    // What the shop owns, what it owes, and the difference — the balance sheet in three lines.
    activoCentavos: b.activoCentavos,
    pasivoCentavos: b.pasivoCentavos,
    patrimonioCentavos: b.capitalCentavos + b.resultadoCentavos,
    capitalCentavos: b.capitalCentavos,
    // The period's result, without a period: income and expenses as the ledger stands.
    ingresosCentavos: b.ingresosCentavos,
    gastosCentavos: b.gastosCentavos,
    resultadoCentavos: b.resultadoCentavos,
    // The shop's own debts, which are NOT the same as what customers owe it — the screen says so.
    deudasPendientesCentavos: deudas.pendiente,
    deudasOriginalCentavos: deudas.original,
    deudasTotal: deudas.total,
    deudasAbiertas: deudas.abiertas ?? 0,
    // Whether the ledger balances, reported rather than assumed.
    cuadra: b.cuadra,
    asientosTotal: asientos.n,
    ultimoAsiento: asientos.ultimo,
    cuentasTotal: b.cuentas.length
  }
}
