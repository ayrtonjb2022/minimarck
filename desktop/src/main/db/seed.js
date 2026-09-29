import { IpcError } from '../bridge/errors.js'

/**
 * First-run seed: the default business and one `admin` operator. Nothing else (PLAT-1).
 *
 * Deliberately NOT a demo-data seeder. A shop's database must contain what the shop has, so
 * products, categories, a chart of accounts and sample sales belong to the *importer* (S16) and
 * to S4/S5's own flows, not to a startup routine that would put fictitious stock in a real till.
 *
 * Idempotent by construction: every insert is guarded by an existence check, and the whole seed
 * is one transaction, so a launch that is killed halfway leaves either both rows or neither.
  *
  * A NO-OP WHEN THERE IS NO SCHEMA. `negocios` and `users` come from `001_init.sql`; this module
  * never creates a table itself. When the schema is absent, `seed()` reports `schema_not_present`
  * and writes nothing rather than fabricating tables here, which would let a seeder's idea of the
  * schema drift away from the migration that owns it.
  */

/** The tables this seeder owns. Whoever constructs the connection declares these. */
export const SEED_TABLES = Object.freeze(['negocios', 'users'])

export const DEFAULT_NEGOCIO = Object.freeze({
  nombre: 'Mi Negocio',
  tipo_comercio: 'otro',
  ruc: null
})

export const DEFAULT_ADMIN = Object.freeze({
  nombre: 'Administrador',
  email: 'admin@minimarck.local',
  rol: 'admin'
})

function tableExists(conn, table) {
  const row = conn.db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table)
  return Boolean(row)
}

export function isSchemaPresent(conn) {
  return SEED_TABLES.every((t) => tableExists(conn, t))
}

/**
 * Seed once. `actor` overrides the default operator record; S4 supplies the real one from the
 * local marker.
 *
 * NO SECRET IS WRITTEN. Decision #275 removes authentication from the desktop entirely, but
 * design §D.3 still declares `users.password TEXT NOT NULL`. That contradiction belongs to S2,
 * which owns the schema and its census, and S2 must decide whether that column is dropped or
 * made nullable. Writing a placeholder bcrypt hash here would silently resolve it the wrong
 * way and then look like a real credential in the user's database, so this function does not
 * write one and `seed()` reports the column requirement back to the caller instead.
 */
export function seed(conn, { negocio = DEFAULT_NEGOCIO, admin = DEFAULT_ADMIN, now = () => new Date().toISOString() } = {}) {
  if (!isSchemaPresent(conn)) {
    return { seeded: false, reason: 'schema_not_present', negocioId: null, userId: null }
  }

  const alreadyNeg = conn.db.prepare('SELECT id FROM negocios WHERE nombre = ?').get(negocio.nombre)
  const alreadyUser = conn.db.prepare('SELECT id FROM users WHERE email = ?').get(admin.email)
  if (alreadyNeg && alreadyUser) {
    return {
      seeded: false,
      reason: 'already_seeded',
      negocioId: alreadyNeg.id,
      userId: alreadyUser.id
    }
  }

  const ts = now()
  // The `users.password` contradiction, checked BEFORE the insert rather than after it.
  //
  // The report below used to run after the transaction succeeded, which made it unreachable
  // exactly when it mattered: design §D.3 declares `users.password TEXT NOT NULL`, so the INSERT
  // that omits the column fails with a raw `NOT NULL constraint failed: users.password` and the
  // caller never learns that this is a known, owned contradiction rather than a corrupt file.
  //
  // So detect the blocking shape up front. A `password` column that is NOT NULL with no default
  // cannot be satisfied without writing a credential we refuse to invent, and S2 — which owns
  // the schema census — is the slice that has to decide whether to drop it or make it nullable.
  // Failing here says exactly that, instead of surfacing SQLite's wording.
  // `notnull` is aliased to `required_flag` on purpose: SQLite has a `NOTNULL` postfix OPERATOR,
  // so `AS notnull` is a parse error, not an identifier.
  const passwordColumn = conn.db
    .prepare(
      `SELECT name, "notnull" AS required_flag, dflt_value FROM pragma_table_info('users') WHERE name = 'password'`
    )
    .get()
  if (passwordColumn && passwordColumn.required_flag === 1 && passwordColumn.dflt_value === null) {
    throw new IpcError(
      'SEED_PASSWORD_COLUMN_BLOCKS',
      500,
      'users.password is NOT NULL with no default, so the first-run admin cannot be created ' +
        'without a credential this seeder will not invent. S2 owns that decision: drop the ' +
        'column or make it nullable.'
    )
  }

  const ids = conn.tx(() => {
    let negocioId = alreadyNeg ? alreadyNeg.id : null
    if (!negocioId) {
      const info = conn.db
        .prepare(
          `INSERT INTO negocios (nombre, ruc, tipo_comercio, configuracion, activo, created_at, updated_at)
           VALUES (?, ?, ?, '{}', 1, ?, ?)`
        )
        .run(negocio.nombre, negocio.ruc, negocio.tipo_comercio, ts, ts)
      negocioId = Number(info.lastInsertRowid)
    }
    let userId = alreadyUser ? alreadyUser.id : null
    if (!userId) {
      const info = conn.db
        .prepare(
          `INSERT INTO users (nombre, email, rol, activo, negocio_id, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?, ?)`
        )
        .run(admin.nombre, admin.email, admin.rol, negocioId, ts, ts)
      userId = Number(info.lastInsertRowid)
    }
    return { negocioId, userId }
  })

  // Surfaced rather than thrown: the seed succeeded, and refusing to open the app over a
  // schema detail S2 owns would be worse than reporting it.
  const columns = conn.db.prepare(`SELECT name FROM pragma_table_info('users')`).all().map((r) => r.name)
  const needsPassword = columns.includes('password')

  return { seeded: true, reason: 'seeded', ...ids, unresolved: needsPassword ? ['users.password'] : [] }
}

/** Refuse a tenant-less write rather than defaulting `negocio_id` to something (SEC-6). */
export function requireTenant(negocioId) {
  if (negocioId === null || negocioId === undefined) {
    throw new IpcError('TENANT_REQUIRED', 400, 'negocioId is required; S4 resolves it from the local marker')
  }
  return negocioId
}
