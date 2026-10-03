import { IpcError } from '../../bridge/errors.js'
import { requireTenant } from '../seed.js'

/**
 * Suppliers: the other half of a purchase, and the name a payable is owed to.
 *
 * All five contract operations are implemented here, and that is worth a sentence because
 * `App.jsx` used to list `/proveedores` among the screens "the frozen 89-op contract does not
 * contain". It does contain them — `proveedores.list/get/create/update/remove` — they had simply
 * never been given a handler, and a missing handler was misreported as a missing permission. The
 * distinction matters: the contract is a promise about what this desktop MAY do, and telling the
 * operator that buying from a supplier is out of contract is a lie about this codebase's own rules.
 *
 * WHAT THIS TABLE DOES NOT CARRY, ON PURPOSE: a balance. `deudores` computes
 * `deuda_pendiente_centavos` in the `v_clientes_deudores` view rather than storing it, and a
 * supplier's payable is derived the same way — from `compras`, in the subqueries below. A stored
 * balance on the counterparty row is a second source of truth that drifts the instant a purchase is
 * cancelled. See §4 of `001_init.sql` for the same argument applied to debtors.
 *
 * THE COLUMNS ARE THE WEB'S, EXACTLY. `nombre`, `ruc`, `telefono`, `email`, `direccion`, `contacto`,
 * `notas`, `activo` — no `user_id` (the table has no such column, and the web model has no such
 * field either), and no `stock_minimo_milli` (that column lives on `productos`; a minimum stock
 * belongs to a thing you can count, not to a person you call).
 *
 * DIVERGENCES FROM THE WEB, all of them deliberate and all recorded in `DIVERGENCES.md`:
 *   - `remove` REFUSES a supplier who has purchases standing. The web calls `proveedor.destroy()`
 *     with no such check (its model is `paranoid`, so the delete is soft too), and the result is a
 *     purchase whose counterparty has silently vanished from every list, cannot be opened, and
 *     cannot be searched. Soft or hard, that is a record pointing at nothing. Here it is a 409 that
 *     says to deactivate them instead — `activo = 0` keeps the name resolvable.
 *   - Search covers `telefono`, `email`, `ruc` and `contacto` as well as `nombre`. The web matches
 *     `nombre` only, and a shop that has two suppliers whose names differ by one accent still knows
 *     both phone numbers. A superset, so no recorded data differs.
 *   - The accepted field set is explicit. `create`/`update` in the web are `Proveedor.create(req.body)`
 *     and `proveedor.update(req.body)` — every column the client sends, including `id`. Here a
 *     request that sends an unknown field is ignored rather than written.
 *   - `nombre` is validated to the web's own 2..150 length, and `email` to the web's own pattern.
 */
/**
 * One `auditoria` row, for a master record that has no `user_id` column of its own.
 *
 * This is the mechanism the design named: `auditoria` is the only table in the frozen schema that
 * records WHO acted, and a supplier is exactly the kind of row where "who deactivated this
 * supplier, and when" is the question somebody asks months later. The purchase lines in
 * `compras.repo.js` use the same table for the same reason.
 */
function auditar(ctx, registroId, accion, anteriores, nuevos) {
  const ts = new Date().toISOString()
  ctx.db
    .prepare(
      `INSERT INTO auditoria
         (tabla, registro_id, accion, valores_anteriores, valores_nuevos, user_id, negocio_id, created_at, updated_at)
       VALUES ('proveedores', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(registroId, accion, JSON.stringify(anteriores ?? {}), JSON.stringify(nuevos ?? {}),
         ctx.actorId, ctx.negocioId, ts, ts)
}

export function listar(ctx, { search = '', activo, limit = 50, offset = 0 } = {}) {
  requireTenant(ctx.negocioId)

  const cond = ['p.negocio_id = ?', 'p.deleted_at IS NULL']
  const args = [ctx.negocioId]

  const q = search === null || search === undefined ? '' : String(search).trim()
  if (q !== '') {
    // Case-insensitively, because a shop types "distribuidora" and means "Distribuidora". Each
    // term is escaped, so a `%` or `_` typed into the box is a literal character to look for and
    // not a wildcard — the web interpolates the raw string into `Op.like`, where `100%` silently
    // becomes "anything ending in 100".
    cond.push(
      "(p.nombre LIKE ? ESCAPE '\\' OR p.ruc LIKE ? ESCAPE '\\' OR p.telefono LIKE ? ESCAPE '\\'" +
        " OR p.email LIKE ? ESCAPE '\\' OR p.contacto LIKE ? ESCAPE '\\')"
    )
    const patron = `%${escaparLike(q.toLowerCase())}%`
    args.push(patron, patron, patron, patron, patron)
  }
  // The web's `?activo=true|false` filter, including the ability to ask for BOTH, which its
  // `where.activo = activo === "true"` cannot express.
  if (activo !== undefined && activo !== null && activo !== '' && activo !== 'todos') {
    cond.push('p.activo = ?')
    args.push(activo === true || activo === 'true' || activo === 1 ? 1 : 0)
  }
  const where = cond.join(' AND ')

  const total = ctx.db
    .prepare(`SELECT COUNT(*) AS n FROM proveedores p WHERE ${where}`)
    .get(...args).n
  const filas = ctx.db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM compras c
                WHERE c.proveedor_id = p.id AND c.negocio_id = p.negocio_id
                  AND c.deleted_at IS NULL AND c.estado <> 'cancelada')            AS compras_totales,
              (SELECT COALESCE(SUM(c.total_centavos), 0) FROM compras c
                WHERE c.proveedor_id = p.id AND c.negocio_id = p.negocio_id
                  AND c.deleted_at IS NULL AND c.estado = 'pendiente')            AS compras_pendientes_centavos,
              (SELECT MAX(c.fecha) FROM compras c
                WHERE c.proveedor_id = p.id AND c.negocio_id = p.negocio_id
                  AND c.deleted_at IS NULL AND c.estado <> 'cancelada')            AS ultima_compra_at
         FROM proveedores p
        WHERE ${where}
        ORDER BY p.nombre COLLATE NOCASE ASC, p.id ASC
        LIMIT ? OFFSET ?`
    )
    .all(...args, limit, offset)
  return { filas: filas.map(mapProveedor), total }
}

/**
 * One supplier, with the purchases made from them, newest first.
 *
 * The purchases are here because a supplier screen that cannot answer "what do I owe this one?" is
 * a contact list. The owed figure is the same number the list reports — `pendiente` purchases,
 * which is exactly what a credit purchase is recorded as — so the header and the detail can never
 * disagree.
 */
export function obtener(ctx, id) {
  requireTenant(ctx.negocioId)
  const pid = assertId(id, 'proveedor')

  const row = ctx.db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM compras c
                WHERE c.proveedor_id = p.id AND c.negocio_id = p.negocio_id
                  AND c.deleted_at IS NULL AND c.estado <> 'cancelada')            AS compras_totales,
              (SELECT COALESCE(SUM(c.total_centavos), 0) FROM compras c
                WHERE c.proveedor_id = p.id AND c.negocio_id = p.negocio_id
                  AND c.deleted_at IS NULL AND c.estado = 'pendiente')            AS compras_pendientes_centavos,
              (SELECT MAX(c.fecha) FROM compras c
                WHERE c.proveedor_id = p.id AND c.negocio_id = p.negocio_id
                  AND c.deleted_at IS NULL AND c.estado <> 'cancelada')            AS ultima_compra_at
         FROM proveedores p
        WHERE p.id = ? AND p.negocio_id = ? AND p.deleted_at IS NULL`
    )
    .get(pid, ctx.negocioId)
  if (!row) {
    throw new IpcError('PROVEEDOR_NO_ENCONTRADO', 404, 'El proveedor no existe en este negocio')
  }

  const compras = ctx.db
    .prepare(
      `SELECT id, folio, fecha, total_centavos, estado, observaciones
         FROM compras
        WHERE proveedor_id = ? AND negocio_id = ? AND deleted_at IS NULL
        ORDER BY fecha DESC, id DESC
        LIMIT 100`
    )
    .all(pid, ctx.negocioId)
  return { ...mapProveedor(row), compras }
}

/** Create a supplier. Every field is the web's; `nombre` is the only required one. */
export function crear(ctx, body) {
  requireTenant(ctx.negocioId)
  if (!ctx.actorId) {
    throw new IpcError('ACTOR_REQUERIDO', 401, 'La operación necesita un usuario en sesión')
  }
  if (!body || typeof body !== 'object') {
    throw new IpcError('PROVEEDOR_CUERPO_INVALIDO', 400, 'El proveedor debe enviar un cuerpo de petición')
  }

  const campos = leerCampos(body, { parcial: false })
  const ts = new Date().toISOString()
  // Every column gets a value, always. `leerCampos` only records the keys the request actually
  // mentioned, so an absent field is absent from `campos` and would be bound as `undefined` —
  // which node:sqlite refuses outright, with the unhelpful "cannot be bound to parameter 3". On a
  // CREATE the absent value is `null` (and `activo` is 1), which is what "not supplied" means.
  const columnas = ['nombre', 'ruc', 'telefono', 'email', 'direccion', 'contacto', 'notas', 'activo']
  const valores = columnas.map((columna) =>
    Object.hasOwn(campos, columna) ? campos[columna] : columna === 'activo' ? 1 : null
  )

  return ctx.tx(() => {
    const info = ctx.db
      .prepare(
        `INSERT INTO proveedores
           (nombre, ruc, telefono, email, direccion, contacto, notas, activo,
            negocio_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      // `proveedores` has NO `user_id` column and none is invented: the `auditoria` row written
      // below records who acted, which answers "who added this supplier" better than a column
      // nothing reads ever would.
      .run(...valores, ctx.negocioId, ts, ts)
    const id = Number(info.lastInsertRowid)
    auditar(ctx, id, 'CREATE', {}, { ...campos, activo: campos.activo ?? 1 })
    return obtener(ctx, id)
  })
}

/**
 * Edit a supplier.
 *
 * A PARTIAL update: a field that arrives `undefined` is left alone, a field that arrives `null` or
 * `''` is cleared. The difference between "I did not mention it" and "I am removing it" is the
 * whole reason this is not a blanket overwrite, and collapsing the two is how a supplier's phone
 * number disappears because a form omitted a field it did not edit.
 *
 * A supplier with purchases can still be deactivated. That is the correct way to stop buying from
 * someone without erasing the record of having bought from them.
 */
export function actualizar(ctx, id, body) {
  requireTenant(ctx.negocioId)
  const pid = assertId(id, 'proveedor')
  if (!body || typeof body !== 'object') {
    throw new IpcError('PROVEEDOR_CUERPO_INVALIDO', 400, 'El proveedor debe enviar un cuerpo de petición')
  }

  const campos = leerCampos(body, { parcial: true })
  const cambios = Object.keys(campos)
  if (cambios.length === 0) {
    // Nothing to change. Answering with the current row rather than an empty object means a save
    // button cannot report success for a request that touched nothing.
    return obtener(ctx, pid)
  }

  const asignaciones = cambios.map((c) => `${c} = ?`)
  const ts = new Date().toISOString()
  return ctx.tx(() => {
    // The row as it stands, so the audit line says what the value WAS and not merely that
    // something changed. Reading it inside the transaction keeps the two from straddling a
    // concurrent edit.
    const previo = ctx.db
      .prepare('SELECT * FROM proveedores WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL')
      .get(pid, ctx.negocioId)
    if (!previo) {
      throw new IpcError('PROVEEDOR_NO_ENCONTRADO', 404, 'El proveedor no existe en este negocio')
    }
    const info = ctx.db
      .prepare(
        `UPDATE proveedores SET ${asignaciones.join(', ')}, updated_at = ?
          WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL`
      )
      .run(...cambios.map((c) => campos[c]), ts, pid, ctx.negocioId)
    if (info.changes === 0) {
      throw new IpcError('PROVEEDOR_NO_ENCONTRADO', 404, 'El proveedor no existe en este negocio')
    }
    // Only the fields this request actually touched go into `valores_anteriores`; the whole row
    // would drown the one value somebody is trying to find later.
    const antes = Object.fromEntries(Object.keys(campos).map((c) => [c, previo[c] ?? null]))
    auditar(ctx, pid, 'UPDATE', antes, { ...campos })
    return obtener(ctx, pid)
  })
}

/**
 * Remove a supplier — softly, and only when no purchase points at them.
 *
 * A cancelled purchase is not a purchase: it moved no stock and posted no entry, so a supplier
 * whose every purchase was cancelled is removable, and that is the case where removal is most
 * likely to be what the operator actually meant.
 *
 * The soft delete is what keeps the name reserved. There is no unique index on `proveedores.nombre`
 * in the frozen schema and none is invented, so a deleted supplier's name is NOT protected by the
 * database — what the soft delete buys is that the row, and every purchase that names it, stays
 * resolvable to a person rather than to a missing id.
 */
export function remove(ctx, id) {
  requireTenant(ctx.negocioId)
  const pid = assertId(id, 'proveedor')

  return ctx.tx(() => {
    const row = ctx.db
      .prepare('SELECT * FROM proveedores WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL')
      .get(pid, ctx.negocioId)
    if (!row) {
      throw new IpcError('PROVEEDOR_NO_ENCONTRADO', 404, 'El proveedor no existe en este negocio')
    }

    const enPie = ctx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM compras
          WHERE proveedor_id = ? AND negocio_id = ? AND deleted_at IS NULL AND estado <> 'cancelada'`
      )
      .get(pid, ctx.negocioId).n
    if (enPie > 0) {
      throw new IpcError(
        'PROVEEDOR_CON_COMPRAS',
        409,
        `El proveedor tiene ${enPie} compra(s) en pie y no se puede eliminar; desactivalo en su lugar`
      )
    }

    const ts = new Date().toISOString()
    const info = ctx.db
      .prepare(
        'UPDATE proveedores SET deleted_at = ?, activo = 0, updated_at = ? WHERE id = ? AND negocio_id = ?'
      )
      .run(ts, ts, pid, ctx.negocioId)
    if (info.changes === 0) {
      throw new IpcError('PROVEEDOR_NO_ENCONTRADO', 404, 'El proveedor no existe en este negocio')
    }
    // A soft delete still happened, and "somebody removed this supplier" is the fact worth keeping.
    auditar(ctx, pid, 'DELETE', { nombre: row.nombre, activo: row.activo, deletedAt: null },
            { nombre: row.nombre, activo: 0, deletedAt: ts })
    return { eliminado: true, id: pid, nombre: row.nombre }
  })
}

/**
 * The one place the accepted field set is written down.
 *
 * `parcial` decides what a blank field means. On create, a blank is `null` — an absent value. On
 * update, a field that is not mentioned at all is not in the result and is therefore left alone,
 * while a field that arrives blank is `null` and clears the column. `activo` is a boolean, so it
 * takes `'0'`/`'false'` as false rather than being read as a non-empty string.
 */
function leerCampos(body, { parcial }) {
  const campos = {}

  if (body.nombre !== undefined) {
    const nombre = texto(body.nombre)
    if (nombre === null || nombre.length < 2 || nombre.length > 150) {
      // The web's own `len: [2, 150]` validation, refused here with the same bound so a name the
      // web would have rejected is not silently stored in the desktop.
      throw new IpcError('PROVEEDOR_NOMBRE_INVALIDO', 400, 'El nombre del proveedor debe tener entre 2 y 150 caracteres')
    }
    campos.nombre = nombre
  } else if (!parcial) {
    throw new IpcError('PROVEEDOR_NOMBRE_REQUERIDO', 400, 'El proveedor necesita un nombre')
  }

  for (const clave of ['ruc', 'telefono', 'direccion', 'contacto', 'notas']) {
    if (body[clave] !== undefined) campos[clave] = texto(body[clave])
  }

  if (body.email !== undefined) {
    const email = texto(body.email)
    // The web's `isEmailOrEmpty` pattern, character for character, so an address accepted on the
    // web is accepted here. A blank is still a blank.
    if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new IpcError('PROVEEDOR_EMAIL_INVALIDO', 400, 'El email del proveedor no tiene un formato válido')
    }
    campos.email = email
  }

  if (body.activo !== undefined) {
    campos.activo = body.activo === true || body.activo === 1 || body.activo === '1' || body.activo === 'true' ? 1 : 0
  } else if (!parcial) {
    campos.activo = 1
  }

  return campos
}

/** snake_case row -> the camelCase shape the web's API returns, which is what a renderer expects. */
function mapProveedor(row) {
  if (!row) return null
  return {
    id: row.id,
    nombre: row.nombre,
    ruc: row.ruc,
    telefono: row.telefono,
    email: row.email,
    direccion: row.direccion,
    contacto: row.contacto,
    notas: row.notas,
    activo: row.activo === 1,
    comprasTotales: row.compras_totales ?? 0,
    comprasPendientesCentavos: row.compras_pendientes_centavos ?? 0,
    ultimaCompraAt: row.ultima_compra_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** A trimmed string, or `null` for absent and blank alike — the database stores `null`, never `''`. */
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
