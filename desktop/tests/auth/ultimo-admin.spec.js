/**
 * THE SHOP IS NEVER LEFT WITHOUT AN ACTIVE OWNER — and the proof is that the ENGINE refuses, not
 * that a function somebody remembered to call refuses.
 *
 * WHY THESE TESTS EXIST INSTEAD OF A UNIT TEST ON A GUARD FUNCTION. §L is frozen at 89 operations
 * and has no `usuarios.update` and no `usuarios.remove`, so nothing in this build can deactivate,
 * demote or delete a person. A guard written in JavaScript and called from nowhere would make
 * every one of these tests pass while changing nothing a user can do — which is the shape of a
 * green test that proves a fiction. So the rule is enforced in `003_ultimo_admin.sql` as two
 * SQLite triggers, and these tests go through raw SQL for the same reason a shopkeeper's
 * maintenance script would: the claim has to survive a caller that is not this codebase.
 *
 * WHAT EACH ASSERTION IS FOR:
 *
 *   - ALL THREE ACTIONS, refused. Delete, deactivate, demote. A rule that only covers the obvious
 *     one is a rule with two holes in it, and both holes are a shop nobody can sign in to.
 *   - THE SECOND OWNER IS ENOUGH. With two admins, the first one goes without complaint. A trigger
 *     that refused whenever the row is an admin would be a shop that can never hand the keys to a
 *     second person, which is a different lockout.
 *   - THE REFUSAL CHANGES NOTHING. The row is still there, still active, still `admin`, after the
 *     attempt. A refusal that half-applied would be worse than none.
 *   - A BUSINESS THAT ALREADY HAS NO OWNER IS NOT MADE WORSE. The rule protects what exists; it
 *     does not repair what is missing, and it does not freeze the people who are left.
 *   - THE COUNT IS PER BUSINESS, not per file.
 *   - The two UPDATEs this app really writes — the sign-in stamp and the first-launch rename —
 *     never reach the trigger, so the rule costs nothing on the hot path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../../src/main/db/connection.js'
import { migrate } from '../../src/main/db/migrate.js'
import { esUltimoAdmin } from '../../src/main/db/errores-sqlite.js'
import { tienda } from '../db/fixtures/tienda.js'

const MIGRACIONES = fileURLToPath(new URL('../../src/main/db/migrations', import.meta.url))
const TS = '2026-01-01T00:00:00.000Z'

/** Run a statement and hand back the error it raised, or null when it did not raise one. */
function intentar(fn) {
  try {
    fn()
    return null
  } catch (err) {
    return err
  }
}

function nuevoNegocio(conn, nombre, ruc = null) {
  return Number(
    conn.db
      .prepare(
        `INSERT INTO negocios (nombre, ruc, tipo_comercio, configuracion, activo, created_at, updated_at)
         VALUES (?, ?, 'otro', '{}', 1, ?, ?)`
      )
      .run(nombre, ruc, TS, TS).lastInsertRowid
  )
}

function nuevoUsuario(conn, negocioId, { nombre, email, rol = 'vendedor', activo = 1 }) {
  return Number(
    conn.db
      .prepare(
        `INSERT INTO users (nombre, email, rol, activo, negocio_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(nombre, email, rol, activo, negocioId, TS, TS).lastInsertRowid
  )
}

const duenosActivos = (conn, negocioId) =>
  conn.db
    .prepare(
      `SELECT COUNT(*) AS n FROM users
        WHERE negocio_id = ? AND rol = 'admin' AND activo = 1 AND deleted_at IS NULL`
    )
    .get(negocioId).n

describe('the last active owner cannot be removed', () => {
  let e
  beforeEach(() => { e = tienda() })
  afterEach(() => e.cerrar())

  const admin = () => e.conn.db.prepare(`SELECT id FROM users WHERE rol = 'admin' ORDER BY id LIMIT 1`).get()

  it('refuses a HARD DELETE of the only admin', () => {
    const id = admin().id
    expect(duenosActivos(e.conn, e.negocioId)).toBe(1)

    const err = intentar(() => e.conn.db.prepare('DELETE FROM users WHERE id = ?').run(id))
    expect(esUltimoAdmin(err)).toBe(true)

    // The refusal changed nothing: still there, still active, still the owner.
    expect(e.conn.db.prepare('SELECT id, rol, activo, deleted_at FROM users WHERE id = ?').get(id))
      .toMatchObject({ id, rol: 'admin', activo: 1, deleted_at: null })
  })

  it('refuses DEACTIVATING the only admin', () => {
    const id = admin().id
    const err = intentar(() => e.conn.db.prepare('UPDATE users SET activo = 0 WHERE id = ?').run(id))
    expect(esUltimoAdmin(err)).toBe(true)
    expect(e.conn.db.prepare('SELECT activo FROM users WHERE id = ?').get(id).activo).toBe(1)
  })

  it('refuses DEMOTING the only admin to supervisor or vendedor', () => {
    for (const rol of ['supervisor', 'vendedor']) {
      const id = admin().id
      const err = intentar(() => e.conn.db.prepare('UPDATE users SET rol = ? WHERE id = ?').run(rol, id))
      expect(esUltimoAdmin(err)).toBe(true)
      expect(e.conn.db.prepare('SELECT rol FROM users WHERE id = ?').get(id).rol).toBe('admin')
    }
  })

  it('refuses the SOFT delete this schema actually uses', () => {
    const id = admin().id
    const err = intentar(() => e.conn.db.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').run(TS, id))
    expect(esUltimoAdmin(err)).toBe(true)
    expect(e.conn.db.prepare('SELECT deleted_at FROM users WHERE id = ?').get(id).deleted_at).toBeNull()
  })

  it('undoes the STATEMENT, not the transaction, for a caller that catches it', () => {
    const id = admin().id
    // A RAW transaction, not `conn.tx()`: this repo's wrapper rolls back and rethrows on any
    // error, which is the right thing for a repository to do and says nothing about the trigger.
    // The claim being proved here is about SQLite's own semantics — what happens to a maintenance
    // script that catches the refusal and carries on with the rest of its work.
    e.conn.db.exec('BEGIN IMMEDIATE')
    e.conn.db.prepare('UPDATE negocios SET nombre = ? WHERE id = ?').run('Renombrada', e.negocioId)
    const err = intentar(() => e.conn.db.prepare('UPDATE users SET activo = 0 WHERE id = ?').run(id))
    e.conn.db.exec('COMMIT')

    // `RAISE(ABORT, …)` undid the statement and left the transaction OPEN, so the rename the caller
    // legitimately made before it is still there. `RAISE(ROLLBACK, …)` would have taken it too,
    // and the commit above would have failed with "no transaction is active".
    expect(esUltimoAdmin(err)).toBe(true)
    expect(e.conn.db.prepare('SELECT nombre FROM negocios WHERE id = ?').get(e.negocioId).nombre).toBe('Renombrada')
    expect(e.conn.db.prepare('SELECT activo FROM users WHERE id = ?').get(id).activo).toBe(1)
  })
})

describe('a second owner is enough', () => {
  let e
  beforeEach(() => { e = tienda() })
  afterEach(() => e.cerrar())

  it('lets the first owner go once there are two, and the second is then protected', () => {
    const primero = adminId(e)
    const segundo = nuevoUsuario(e.conn, e.negocioId, {
      nombre: 'Second Owner', email: 'segundo@minimarck.local', rol: 'admin'
    })
    expect(duenosActivos(e.conn, e.negocioId)).toBe(2)

    // Deactivating the first: allowed. One active owner is left, which is what the rule asks for.
    expect(intentar(() => e.conn.db.prepare('UPDATE users SET activo = 0 WHERE id = ?').run(primero))).toBeNull()
    expect(e.conn.db.prepare('SELECT activo FROM users WHERE id = ?').get(primero).activo).toBe(0)

    // Demoting the second would take it to zero. Refused, and the row is untouched.
    const err = intentar(() => e.conn.db.prepare('UPDATE users SET rol = ? WHERE id = ?').run('vendedor', segundo))
    expect(esUltimoAdmin(err)).toBe(true)
    expect(e.conn.db.prepare('SELECT rol FROM users WHERE id = ?').get(segundo).rol).toBe('admin')
  })

  it('the second owner can be demoted when a THIRD is still there', () => {
    const segundo = nuevoUsuario(e.conn, e.negocioId, { nombre: 'B', email: 'b@minimarck.local', rol: 'admin' })
    nuevoUsuario(e.conn, e.negocioId, { nombre: 'C', email: 'c@minimarck.local', rol: 'admin' })

    expect(intentar(() => e.conn.db.prepare('UPDATE users SET rol = ? WHERE id = ?').run('vendedor', segundo))).toBeNull()
    expect(e.conn.db.prepare('SELECT rol FROM users WHERE id = ?').get(segundo).rol).toBe('vendedor')
    expect(duenosActivos(e.conn, e.negocioId)).toBe(2)
  })
})

describe('the count is per business, not per file', () => {
  let e
  beforeEach(() => { e = tienda() })
  afterEach(() => e.cerrar())

  it('one shop cannot spend another shop\'s owner', () => {
    const segundo = nuevoUsuario(e.conn, e.negocioId, { nombre: 'B', email: 'b@minimarck.local', rol: 'admin' })
    const negocioVecino = nuevoNegocio(e.conn, 'Vecina')
    const duenoAjeno = nuevoUsuario(e.conn, negocioVecino, {
      nombre: 'Dueña vecina', email: 'vecina@minimarck.local', rol: 'admin'
    })

    // Two admins exist in the FILE. Only one of them belongs to the business being emptied, and
    // "somewhere in this file there is an admin" is not the rule: "THIS shop has an owner" is.
    expect(intentar(() => e.conn.db.prepare('UPDATE users SET activo = 0 WHERE id = ?').run(segundo))).toBeNull()

    const err = intentar(() => e.conn.db.prepare('UPDATE users SET activo = 0 WHERE id = ?').run(adminId(e)))
    expect(esUltimoAdmin(err)).toBe(true)

    // And the neighbour's owner is untouched by either attempt.
    expect(e.conn.db.prepare('SELECT activo FROM users WHERE id = ?').get(duenoAjeno).activo).toBe(1)
    expect(duenosActivos(e.conn, negocioVecino)).toBe(1)
  })
})

describe('a business that already has no owner is not made worse', () => {
  let e
  beforeEach(() => { e = tienda() })
  afterEach(() => e.cerrar())

  it('leaves its people editable and deletable, because the rule protects and does not repair', () => {
    // A shop whose owner is already gone — by hand, or from a build older than this migration.
    // Refusing every write to the people who remain would leave that shop MORE locked than it
    // already is. The honest repair is `auth.register` on first launch, not a trigger.
    const huerfano = nuevoNegocio(e.conn, 'Sin dueño')
    const alguien = nuevoUsuario(e.conn, huerfano, { nombre: 'Empleado', email: 'alguien@minimarck.local' })
    expect(duenosActivos(e.conn, huerfano)).toBe(0)

    // Nothing here is an owner, so nothing here is protected.
    expect(intentar(() => e.conn.db.prepare('UPDATE users SET nombre = ? WHERE id = ?').run('Renombrado', alguien))).toBeNull()
    expect(intentar(() => e.conn.db.prepare('UPDATE users SET rol = ? WHERE id = ?').run('supervisor', alguien))).toBeNull()
    expect(intentar(() => e.conn.db.prepare('UPDATE users SET activo = 0 WHERE id = ?').run(alguien))).toBeNull()
    expect(intentar(() => e.conn.db.prepare('DELETE FROM users WHERE id = ?').run(alguien))).toBeNull()
    expect(e.conn.db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(alguien).n).toBe(0)

    // And hiring an owner back is allowed: an INSERT is not one of the three actions.
    const nuevoDueño = nuevoUsuario(e.conn, huerfano, { nombre: 'Dueña nueva', email: 'nueva@minimarck.local', rol: 'admin' })
    expect(duenosActivos(e.conn, huerfano)).toBe(1)
    expect(nuevoDueño).toBeGreaterThan(0)
  })
})

describe('the rule does not stand between the app and its own writes', () => {
  let e
  beforeEach(() => { e = tienda() })
  afterEach(() => e.cerrar())

  it('the sign-in stamp and the first-launch rename never reach the trigger', () => {
    // `UPDATE OF rol, activo, deleted_at` means a statement that mentions NONE of the three does
    // not fire the check at all. `marcarAcceso` runs on EVERY sign-in, so a COUNT(*) there would
    // be a tax on the hot path to protect against something it cannot do.
    const id = adminId(e)
    expect(intentar(() => e.conn.db.prepare('UPDATE users SET ultimo_acceso = ? WHERE id = ?').run(TS, id))).toBeNull()
    expect(intentar(() => e.conn.db.prepare('UPDATE users SET nombre = ? WHERE id = ?').run('Otro Nombre', id))).toBeNull()
    expect(intentar(() => e.conn.db.prepare('UPDATE users SET email = ? WHERE id = ?').run('nuevo@minimarck.local', id))).toBeNull()
    // Even re-writing `activo = 1` on a row that is already active is not the change the trigger
    // is about, and the rule does not get in the way of a repair.
    expect(intentar(() => e.conn.db.prepare('UPDATE users SET activo = 1 WHERE id = ?').run(id))).toBeNull()
    expect(e.conn.db.prepare('SELECT nombre FROM users WHERE id = ?').get(id).nombre).toBe('Otro Nombre')
  })
})

describe('the refusal is a recognisable error, not a mystery string', () => {
  let e
  beforeEach(() => { e = tienda() })
  afterEach(() => e.cerrar())

  it('esUltimoAdmin matches the marker and refuses everything else', () => {
    expect(esUltimoAdmin(new Error('ULTIMO_ADMIN: no se puede dejar el negocio sin dueño activo'))).toBe(true)
    expect(esUltimoAdmin(new Error('ULTIMO_ADMIN: no se puede borrar el único dueño activo del negocio'))).toBe(true)

    // The wrapper code every SQLite error carries is NOT enough. `node:sqlite` puts it on a NOT
    // NULL violation and on a UNIQUE one too, and a predicate that answered true for those would
    // report "last owner" to a caller debugging something else entirely.
    expect(esUltimoAdmin({ code: 'ERR_SQLITE_ERROR', errcode: 2067, message: 'UNIQUE constraint failed: x' })).toBe(false)
    expect(esUltimoAdmin({ code: 'ERR_SQLITE_ERROR', errcode: 1299, message: 'NOT NULL constraint failed: users.rol' })).toBe(false)
    expect(esUltimoAdmin({ code: 'ERR_SQLITE_ERROR', message: 'near "FROM": syntax error' })).toBe(false)
    expect(esUltimoAdmin(new Error('algo sin el marcador'))).toBe(false)
    expect(esUltimoAdmin(null)).toBe(false)
    expect(esUltimoAdmin(undefined)).toBe(false)
  })

  it('a word that merely CONTAINS the marker, from something else, is not this error', () => {
    // The prefix is matched after a non-word character, so a column or a filename that happens to
    // carry the token cannot be read as the trigger's own refusal.
    expect(esUltimoAdmin(new Error('ULTIMO_ADMIN_RENAMED: otra cosa'))).toBe(false)
  })

  it('the two triggers exist in the schema a shop file actually gets', () => {
    // Not "the trigger behaves right" — three describes above already prove that — but that it
    // SHIPS. A trigger defined in a test's SQL and missing from the migration would leave every
    // other test green and the rule absent from every real database.
    expect(readdirSync(MIGRACIONES).filter((f) => f.endsWith('.sql'))).toContain('003_ultimo_admin.sql')
    const disparados = e.conn
      .db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`)
      .all()
      .map((r) => r.name)
    expect(disparados).toContain('trg_users_no_dejar_sin_dueno_borrar')
    expect(disparados).toContain('trg_users_no_dejar_sin_dueno_actualizar')
  })

  it('a database built by the runner from scratch refuses the delete, with no app code involved', () => {
    // The end-to-end shape: an empty file, `migrate()` on its own, one seeded admin, and a
    // `DELETE FROM users` issued by code that has never heard of this feature.
    const conn = openDatabase(':memory:', { tables: [] })
    try {
      migrate(conn, { dir: MIGRACIONES })
      conn.allowTable('users')
      nuevoNegocio(conn, 'Tienda')
      const id = nuevoUsuario(conn, 1, { nombre: 'Dueña', email: 'duena@minimarck.local', rol: 'admin' })
      expect(intentar(() => conn.db.prepare('DELETE FROM users WHERE id = ?').run(id))).not.toBeNull()
      expect(esUltimoAdmin(intentar(() => conn.db.prepare('DELETE FROM users WHERE id = ?').run(id)))).toBe(true)
      expect(conn.db.prepare('SELECT COUNT(*) AS n FROM users').get().n).toBe(1)
    } finally {
      conn.checkpointAndClose()
    }
  })
})

/** The first active admin of the seeded business. */
function adminId(e) {
  return e.conn.db
    .prepare(
      `SELECT id FROM users WHERE negocio_id = ? AND rol = 'admin' AND activo = 1 AND deleted_at IS NULL ORDER BY id LIMIT 1`
    )
    .get(e.negocioId).id
}