/**
 * `user_identidades` — the data layer for "who may sign in, and with what".
 *
 * This module is the ONLY place that reads or writes a derived key. Nothing above it handles a
 * secret, and nothing below it invents one: `passwords.js` derives and verifies, this file
 * stores and finds. Splitting it that way means a change to the hash policy cannot reach a
 * repository, and a change to a query cannot reach the crypto.
 *
 * THE `provider` COLUMN IS THE GOOGLE SEAM. Every lookup and every insert names
 * `PROVIDER_LOCAL`, so adding a second provider is a new value and a new branch, not a second
 * login system. A Google identity would insert `('google', <sub>)` with `secret`/`salt` NULL —
 * the columns are nullable precisely so a provider that does not own a password has somewhere to
 * point — and `auth.login` would find the same `user_id` either way. That is the whole design
 * goal of the shape, and it is deliberately not implemented.
 */
import { IpcError } from '../bridge/errors.js'
import { esViolacionUnica } from '../db/errores-sqlite.js'
import { derivar, verificar, necesitaRehash, normalizarNombre } from './passwords.js'

/** The only provider this build accepts. The column exists so a second one does not. */
export const PROVIDER_LOCAL = 'local'

/** The web's roles, ported verbatim. Inventing a fourth would be a different product. */
export const ROLES = Object.freeze(['admin', 'supervisor', 'vendedor'])

const ROLES_SQL = ROLES.map((r) => `'${r}'`).join(', ')

function ahora() {
  return new Date().toISOString()
}

/**
 * The roles allowed to run a `usuarios` module: the owner and the supervisor.
 *
 * WHY NOT JUST THE OWNER. The web stores a `supervisor` role and renders role-based screens for
 * it, so refusing the module to a supervisor would make the ported role mean less here than
 * there. What a supervisor may NOT do is create an `admin` — that is the one escalation this
 * table guards, and it is checked in the repository so it cannot be forgotten by a caller.
 */
export const ROLES_QUE_ADMINISTRAN_USUARIOS = Object.freeze(['admin', 'supervisor'])

/**
 * A user row plus its identity, as the UI needs it. Never includes `secret` or `salt`.
 *
 * `nombreAcceso` is the sign-in HANDLE, and it is not `email`. The legacy seed gave the first
 * user `admin@minimarck.local` as its email, and that row is adopted rather than replaced, so a
 * person whose access name is `dueno` keeps an email that is not their handle. A handover picker
 * that fed `email` back into `auth.login` would therefore offer the incoming person a name that
 * cannot sign in — the list would look right and every handover would fail. The handle travels
 * with the row so the caller never has to guess which of the two is the one.
 */
export function usuarioPublico(fila) {
  if (!fila) return null
  return {
    id: fila.id,
    nombre: fila.nombre,
    email: fila.email,
    nombreAcceso: fila.nombreAcceso ?? null,
    rol: fila.rol,
    activo: fila.activo === 1,
    puedeIngresar: Boolean(fila.tiene_identidad),
    ultimoAcceso: fila.ultimo_acceso ?? null
  }
}

/** The full user row for a session id. */
export function usuarioPorId(conn, id) {
  return conn.db
    .prepare(
      `SELECT u.id, u.nombre, u.email, u.rol, u.activo, u.negocio_id, u.ultimo_acceso,
              (SELECT COUNT(*) FROM user_identidades i
                WHERE i.user_id = u.id AND i.provider = ? AND i.activo = 1
                  AND i.deleted_at IS NULL) AS tiene_identidad
         FROM users u
        WHERE u.id = ? AND u.deleted_at IS NULL`
    )
    .get(PROVIDER_LOCAL, id)
}

/**
 * The business, when the file has exactly one.
 *
 * Refuses ambiguity instead of picking, same rule `identity.js` already applies: a file with two
 * active businesses is a file that needs a chosen tenant, and `auth.register` is the operation
 * that can choose it — by naming the business it means. Passing `negocioId` to register is
 * therefore how a multi-business file resolves, without a new operation.
 */
export function negocioUnico(conn) {
  const filas = conn.db
    .prepare(`SELECT id, nombre FROM negocios WHERE activo = 1 AND deleted_at IS NULL ORDER BY id`)
    .all()
  if (filas.length === 0) return null
  if (filas.length > 1) return { multiple: true, filas }
  return filas[0]
}

/** Does any active local credential exist anywhere in the file? Decides register vs login. */
export function hayCredenciales(conn) {
  const fila = conn.db
    .prepare(
      `SELECT COUNT(*) AS n FROM user_identidades
        WHERE provider = ? AND activo = 1 AND deleted_at IS NULL AND secret IS NOT NULL`
    )
    .get(PROVIDER_LOCAL)
  return fila.n > 0
}

/** Look a sign-in name up to a user, refusing ambiguity rather than taking the lowest id. */
export function usuarioPorNombre(conn, nombre) {
  const externo = normalizarNombre(nombre)
  if (!externo) return null
  const filas = conn.db
    .prepare(
      `SELECT u.id, u.nombre, u.email, u.rol, u.activo, u.negocio_id, u.ultimo_acceso,
              i.id AS identidad_id, i.secret, i.salt, i.parametros, i.algoritmo
         FROM user_identidades i
         JOIN users u ON u.id = i.user_id
        WHERE i.provider = ? AND i.external_id = ?
          AND i.activo = 1 AND i.deleted_at IS NULL
          AND u.activo = 1 AND u.deleted_at IS NULL`
      )
    .all(PROVIDER_LOCAL, externo)
  if (filas.length === 0) return null
  if (filas.length > 1) {
    throw new IpcError(
      'IDENTIDAD_AMBIGUA', 500,
      'Hay más de una cuenta con ese nombre de acceso; hay que resolverla a mano.'
    )
  }
  return filas[0]
}

/** Write a fresh local credential for `userId`, replacing any credential it had. */
export function guardarCredencial(conn, userId, nombre, password, ts = ahora()) {
  const externo = normalizarNombre(nombre)
  const { salt, secret, algoritmo, parametros } = derivar(password)

  return conn.tx(() => {
    // Retire the old one rather than deleting it: `user_identidades` is paranoid, and a
    // credential that was once valid is a fact about the shop's history.
    conn.db
      .prepare(
        `UPDATE user_identidades SET deleted_at = ?, activo = 0, updated_at = ?
          WHERE user_id = ? AND provider = ? AND deleted_at IS NULL`
      )
      .run(ts, ts, userId, PROVIDER_LOCAL)

    try {
      const info = conn.db
        .prepare(
          `INSERT INTO user_identidades
             (user_id, provider, external_id, secret, salt, algoritmo, parametros,
              activo, ultimo_acceso, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`
        )
        .run(userId, PROVIDER_LOCAL, externo, secret, salt, algoritmo, parametros, ts, ts)
      return Number(info.lastInsertRowid)
    } catch (err) {
      // A sign-in name already in use answers the same code whichever way SQLite got there, so
      // the renderer never learns whether the name is taken or the password was wrong.
      if (esViolacionUnica(err)) {
        throw new IpcError('NOMBRE_EN_USO', 409, 'Ese nombre de acceso ya está en uso')
      }
      throw err
    }
  })
}

/**
 * Verify a password against a stored identity. Returns the user, or throws 401.
 *
 * The refusal is byte-for-byte identical for an unknown name, a wrong password and an empty
 * password — same code, same status, same sentence. Differing between them would turn the
 * sign-in panel into an oracle for which names exist on the shop's till.
 */
export function autenticar(conn, nombre, password) {
  const fila = usuarioPorNombre(conn, nombre)
  if (!fila || typeof password !== 'string' || !password || !verificar(password, fila)) {
    throw new IpcError('CREDENCIALES_INVALIDAS', 401, 'Nombre de acceso o contraseña incorrectos')
  }
  return { id: fila.id, nombre: fila.nombre, rol: fila.rol, negocio_id: fila.negocio_id, identidad_id: fila.identidad_id }
}

/** Stamp the successful sign-in. Never receives the password — it is not an argument. */
export function marcarAcceso(conn, userId, identidadId, ts = ahora()) {
  conn.db
    .prepare(`UPDATE user_identidades SET ultimo_acceso = ?, updated_at = ? WHERE id = ?`)
    .run(ts, ts, identidadId)
  conn.db
    .prepare(`UPDATE users SET ultimo_acceso = ?, updated_at = ? WHERE id = ?`)
    .run(ts, ts, userId)
}

/**
 * Re-derive the secret under the CURRENT policy when the stored one is older.
 *
 * Runs after a SUCCESSFUL verification, so it can only ever make a secret stronger, never
 * change which password opens the account. A failure here is swallowed deliberately: a login
 * that worked must not be reported as a login that failed because an upgrade could not be
 * written.
 */
export function actualizarSiProcede(conn, identidadId, nombre, password) {
  const fila = conn.db
    .prepare(`SELECT id, user_id, parametros, deleted_at FROM user_identidades WHERE id = ?`)
    .get(identidadId)
  if (!fila || fila.deleted_at) return false
  if (!necesitaRehash(fila.parametros)) return false
  try {
    guardarCredencial(conn, fila.user_id, nombre, password)
    return true
  } catch {
    return false
  }
}

/** List the business's people, newest last. The `usuarios` module is this query. */
export function listarUsuarios(conn, negocioId) {
  return conn.db
    .prepare(
      `SELECT u.id, u.nombre, u.email, u.rol, u.activo, u.ultimo_acceso,
              COUNT(i.id) AS tiene_identidad,
              MIN(i.external_id) AS nombreAcceso
         FROM users u
         LEFT JOIN user_identidades i
                ON i.user_id = u.id AND i.provider = ? AND i.activo = 1
               AND i.deleted_at IS NULL
        WHERE u.negocio_id = ? AND u.deleted_at IS NULL
        GROUP BY u.id
        ORDER BY u.rol = 'admin' DESC, u.id`
    )
    .all(PROVIDER_LOCAL, negocioId)
    .map(usuarioPublico)
}

/** Sign-in name of a user, for the handover picker: the owner does not have to type it. */
export function nombreDeAcceso(conn, userId) {
  const fila = conn.db
    .prepare(
      `SELECT external_id FROM user_identidades
        WHERE user_id = ? AND provider = ? AND activo = 1 AND deleted_at IS NULL
        ORDER BY id DESC LIMIT 1`
    )
    .get(userId, PROVIDER_LOCAL)
  return fila ? fila.external_id : null
}

/** Validate a role against the web's three, and refuse anything else. */
export function exigirRol(rol) {
  if (!ROLES.includes(rol)) {
    throw new IpcError('ROL_INVALIDO', 400, `Rol inválido: ${rol}`)
  }
  return rol
}

/** The single `usuarios` list a `vendedor` may see, which is nobody: a role check, not a guess. */
export function exigirAdministradorDeUsuarios(rol) {
  if (!ROLES_QUE_ADMINISTRAN_USUARIOS.includes(rol)) {
    throw new IpcError('SIN_PERMISO', 403, 'Sólo el dueño o un supervisor pueden ver los usuarios')
  }
}
