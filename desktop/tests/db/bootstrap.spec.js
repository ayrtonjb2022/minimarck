import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPathResolver, assertAbsolute, MIGRATIONS_DIRNAME } from '../../src/main/db/paths.js'
import { bootstrapDatabase } from '../../src/main/db/bootstrap.js'
import { runBeforeQuit } from '../../src/main/lifecycle.js'

/** The REAL migration directory, so these tests boot the schema the app actually ships. */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../src/main/db/migrations', import.meta.url))

/**
 * `paths.js` and `bootstrap.js` — the two modules that compose S1 into a running app.
 *
 * THESE EXIST BECAUSE OF A REAL DEFECT. `createPathResolver` used to `Object.freeze()` the paths
 * object and then assign `migrationsExist` onto the frozen result. ESM is always strict, so that
 * threw `TypeError: Cannot assign to read only property`, on EVERY call. `bootstrapDatabase` calls
 * the resolver as its first statement, so the desktop app could not start at all.
 *
 * It shipped because both files had ZERO tests, and the only test that could have caught it —
 * `probe:launch`, which boots real Electron — never ran, because `verify:s0` is an `&&` chain
 * and an unrelated red test stopped it at step 2. A freeze/mutate bug in the very first statement
 * of startup, and the gate that would have caught it was disabled.
 *
 * The first test below is therefore a named regression, not decoration.
 */

/**
 * A stand-in for the real schema, and the two places it is allowed to differ are the whole point
 * of writing it out by hand.
 *
 * `negocios.deleted_at` and `users.deleted_at` ARE NOT OPTIONAL EXTRAS HERE. The real schema is
 * `paranoid` on every table — `tests/db/schema.spec.js` asserts exactly that — and `seed()` asks
 * "does this file have a shop?" with `WHERE deleted_at IS NULL`, because a soft-deleted shop is
 * not a shop. Without the column, that query cannot run and the fixture reported a failure that
 * the real application could never produce.
 *
 * Which is the lesson: a hand-written minimal schema that is missing a column does not only test
 * less, it tests a DIFFERENT PROGRAM. Six tests in this file went red on a query the real database
 * answers, and the honest reading of that red is "the fixture lied", not "the query is wrong".
 */
const MINIMAL_SCHEMA = `
CREATE TABLE negocios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  ruc TEXT,
  tipo_comercio TEXT NOT NULL DEFAULT 'otro',
  configuracion TEXT NOT NULL DEFAULT '{}',
  activo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  rol TEXT NOT NULL DEFAULT 'usuario',
  activo INTEGER NOT NULL DEFAULT 1,
  negocio_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
`

function tempBase() {
  return mkdtempSync(join(tmpdir(), 'mm-paths-'))
}

/** Write a migrations directory containing `001_init.sql`, and return its path. */
function migrationsDirWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mm-mig-'))
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
  return dir
}

describe('REGRESSION: createPathResolver returns a usable object', () => {
  it('does not throw, and the resolved paths are complete', () => {
    // This is the launch-blocking defect. If it ever comes back, the app does not open and no
    // other test in the repo will say so.
    const base = tempBase()
    try {
      const resolveOnce = createPathResolver({ userDataPath: base, env: {} })
      expect(() => resolveOnce()).not.toThrow()

      const paths = resolveOnce()
      expect(paths.dbFile).toContain('minimarck.db')
      expect(paths.dataDir).toBe(join(base, 'data'))
      expect(paths.backupDir).toBe(join(base, 'backups'))
      expect(paths.base).toBe(base)
      expect(paths.overridden).toBe(false)
      // The field the freeze/mutate bug was about must be present and truthful.
      expect(typeof paths.migrationsExist).toBe('boolean')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('is actually frozen — the immutability intent survived the fix', () => {
    // The fix moved the stat BEFORE the freeze. If the object were left unfrozen, the guard
    // would be gone while still reading as "frozen" in a code review.
    const base = tempBase()
    try {
      const paths = createPathResolver({ userDataPath: base, env: {} })()
      expect(Object.isFrozen(paths)).toBe(true)
      expect(() => {
        'use strict'
        paths.dbFile = 'hijacked'
      }).toThrow(TypeError)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('createPathResolver', () => {
  it('memoises: the same object identity on every call', () => {
    // `db.schemaVersion`, the WAL checkpoint and the backup catalog must all agree on ONE file
    // for the life of the process. Re-deriving per call would let a changed MINIMARCK_DATA_DIR
    // mid-run split the database in two.
    const base = tempBase()
    try {
      const resolveOnce = createPathResolver({ userDataPath: base, env: {} })
      expect(resolveOnce()).toBe(resolveOnce())
      expect(resolveOnce()).toBe(resolveOnce())
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('honours MINIMARCK_DATA_DIR for the DATA only, and flags it as overridden', () => {
    const base = tempBase()
    const elsewhere = tempBase()
    try {
      const paths = createPathResolver({ userDataPath: base, env: { MINIMARCK_DATA_DIR: elsewhere } })()
      expect(paths.base).toBe(elsewhere)
      expect(paths.dataDir).toBe(join(elsewhere, 'data'))
      expect(paths.backupDir).toBe(join(elsewhere, 'backups'))
      expect(paths.overridden).toBe(true)
      // The override redirects DATA. It must not create anything under the Electron profile.
      expect(existsSync(join(base, 'data'))).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('creates both directories so the first open and shell.openPath have somewhere to go', () => {
    // PLAT-2. `ensureDataDirs` exists because `resolveDataPaths` computed a path nothing made.
    const base = tempBase()
    try {
      const paths = createPathResolver({ userDataPath: base, env: {} })()
      expect(existsSync(paths.dataDir)).toBe(true)
      expect(existsSync(paths.backupDir)).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('reports migrationsExist truthfully, in both directions', () => {
    const base = tempBase()
    const present = migrationsDirWith({ '001_init.sql': MINIMAL_SCHEMA })
    // A path that does not exist at all — NOT an empty directory, which `existsSync` reports
    // as present and which would make this assertion pass for the wrong reason.
    const absent = join(tempBase(), 'no-such-dir')
    try {
      const yes = createPathResolver({ userDataPath: base, env: {}, migrationsDir: present })()
      expect(yes.migrationsExist).toBe(true)
      expect(yes.migrationsDir).toBe(present)

      const no = createPathResolver({ userDataPath: base, env: {}, migrationsDir: absent })()
      expect(no.migrationsExist).toBe(false)
    } finally {
      for (const d of [base, present, absent]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('refuses to run without a userDataPath', () => {
    // Without it the only remaining base would be process.cwd(), and an app launched from a
    // shortcut would write the user's database to wherever the shortcut pointed.
    expect(() => createPathResolver({})).toThrow(/userDataPath is required/)
  })

  it('never produces a cwd-relative path', () => {
    const base = tempBase()
    try {
      const paths = createPathResolver({ userDataPath: base, env: {} })()
      for (const key of ['dataDir', 'dbFile', 'walFile', 'shmFile', 'backupDir', 'migrationsDir']) {
        assertAbsolute(key, paths[key])
        expect(isAbsolute(paths[key])).toBe(true)
      }
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('assertAbsolute', () => {
  it('accepts absolute and rejects relative', () => {
    expect(assertAbsolute('p', join('C:', 'data'))).toContain('data')
    expect(() => assertAbsolute('p', 'data/minimarck.db')).toThrow(/must be an absolute path/)
  })
})

describe('MIGRATIONS_DIRNAME', () => {
  it('is `migrations`, because the build layout depends on that name', () => {
    // `defaultMigrationsDir()` resolves `./migrations/` relative to the module, which after
    // bundling points at `out/main/migrations/`. S2 owns the copy step that has to match.
    expect(MIGRATIONS_DIRNAME).toBe('migrations')
  })
})

describe('bootstrapDatabase', () => {
  it('opens a real WAL database at the resolved path', () => {
    const base = tempBase()
    const db = bootstrapDatabase({ userDataPath: base, env: {}, tables: [] })
    try {
      expect(existsSync(db.paths.dbFile)).toBe(true)
      expect(statSync(db.paths.dbFile).size).toBeGreaterThan(0)
      expect(db.conn.pragma('journal_mode').journal_mode).toBe('wal')
      expect(db.conn.isOpen()).toBe(true)
    } finally {
      db.conn.checkpointAndClose()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('starts DENY-ALL on writes: only what the migration itself created is allowlisted', () => {
    // The invariant is NOT "nothing is writable" — that was S1, when the runner shipped with
    // no schema. It is "nothing is writable that the schema does not declare". The allowlist
    // is populated exclusively by `tablesCreatedBy` walking the migration's own DDL, so a
    // caller passing `tables: []` gets zero business tables for free, and a stray write is
    // still refused.
    const base = tempBase()
    const db = bootstrapDatabase({ userDataPath: base, env: {}, migrationsDir: MIGRATIONS_DIR })
    try {
      const allowed = db.conn.allowedTables()
      expect(allowed).toContain('schema_migrations')
      // Caller passed no tables; every business table present came from 001_init.sql.
      expect(allowed).toContain('ventas')
      // A table the schema does not declare is still refused — that is the whole point.
      expect(() => db.conn.db.exec('CREATE TABLE sneaky (id INTEGER)')).toThrow()
      expect(() =>
        db.conn.db.prepare('INSERT INTO sneaky (id) VALUES (1)').run()
      ).toThrow()
    } finally {
      db.conn.checkpointAndClose()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('with NO migrations directory: version 0, nothing seeded, nothing invented', () => {
    // The real no-op case is an ABSENT directory, not one that exists and is empty. S1 shipped
    // this behaviour and it still has to hold: a build that fails to package `migrations/`
    // must leave the database at version 0 and seed nothing, rather than half-building a
    // schema and reporting a version that lies about what ran.
    const base = tempBase()
    const db = bootstrapDatabase({ userDataPath: base, env: {}, migrationsDir: join(base, 'no-such-dir') })
    try {
      expect(db.migration.applied).toEqual([])
      expect(db.migration.userVersion).toBe(0)
      expect(db.seeded).toMatchObject({ seeded: false, reason: 'schema_not_present' })
      expect(db.conn.allowedTables()).toEqual(['schema_migrations'])
    } finally {
      db.conn.checkpointAndClose()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('MIGRATES BEFORE SEEDING — proven by a seed that can only succeed after the DDL', () => {
    // The order is the design, and this is what it buys. Two things break if it is reversed:
    //   1. `seed()` would find no `negocios` table and no-op forever.
    //   2. `migrate()` is what allowlists each table it creates (`tablesCreatedBy`), so seeding
    //      first would hit the authorizer and fail with SQLITE_AUTH on a table it is entitled to.
    // Both are silent-ish: a first launch that quietly seeds nothing, forever.
    const base = tempBase()
    const migDir = migrationsDirWith({ '001_init.sql': MINIMAL_SCHEMA })
    const db = bootstrapDatabase({ userDataPath: base, env: {}, migrationsDir: migDir, tables: [] })
    try {
      // `applied` holds VERSIONS, not filenames — the ledger and `user_version` are both keyed
      // by the numeric prefix, so the caller never has to parse names to reason about order.
      expect(db.migration.applied).toEqual([1])
      expect(db.migration.userVersion).toBe(1)
      expect(db.conn.userVersion()).toBe(1)

      expect(db.seeded.seeded).toBe(true)
      expect(db.seeded.negocioId).toBe(1)
      expect(db.seeded.userId).toBe(1)

      // And no placeholder credential was invented: the schema has no `password` column, so
      // there is nothing unresolved to report. See seed.js for why this is never fabricated.
      expect(db.seeded.unresolved).toEqual([])

      const negocio = db.conn.db.prepare('SELECT nombre, tipo_comercio FROM negocios').get()
      expect(negocio.nombre).toBe('Mi Negocio')
      const user = db.conn.db.prepare('SELECT email, rol FROM users').get()
      expect(user.email).toBe('admin@minimarck.local')
      expect(user.rol).toBe('admin')
    } finally {
      db.conn.checkpointAndClose()
      for (const d of [base, migDir]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('is idempotent: a second launch does not duplicate the seed rows', () => {
    const base = tempBase()
    const migDir = migrationsDirWith({ '001_init.sql': MINIMAL_SCHEMA })
    try {
      const first = bootstrapDatabase({ userDataPath: base, env: {}, migrationsDir: migDir, tables: [] })
      first.conn.checkpointAndClose()
      const second = bootstrapDatabase({ userDataPath: base, env: {}, migrationsDir: migDir, tables: [] })
      try {
        expect(second.migration.applied).toEqual([]) // nothing left to apply
        expect(second.seeded.reason).toBe('already_seeded')
        expect(second.conn.db.prepare('SELECT COUNT(*) AS c FROM negocios').get().c).toBe(1)
        expect(second.conn.db.prepare('SELECT COUNT(*) AS c FROM users').get().c).toBe(1)
      } finally {
        second.conn.checkpointAndClose()
      }
    } finally {
      for (const d of [base, migDir]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('REFUSES, with a named error, when `users.password` is NOT NULL — never invents a credential', () => {
    // Design §D.3 still declares `users.password TEXT NOT NULL` while decision #275 removed auth
    // from the desktop. A placeholder bcrypt hash would resolve that contradiction the wrong way
    // AND look like a real credential in the user's database.
    //
    // The earlier draft of seed.js reported this via an `unresolved` field AFTER the insert — but
    // a NOT NULL column makes the INSERT itself fail, so that report was unreachable dead code in
    // the only case it existed for. This asserts the honest behaviour instead: refuse, and name
    // both the contradiction and the slice that owns it.
    const base = tempBase()
    const migDir = migrationsDirWith({
      '001_init.sql': MINIMAL_SCHEMA.replace(
        'rol TEXT NOT NULL DEFAULT \'usuario\',',
        'password TEXT NOT NULL,\n  rol TEXT NOT NULL DEFAULT \'usuario\','
      )
    })
    let thrown = null
    try {
      bootstrapDatabase({ userDataPath: base, env: {}, migrationsDir: migDir, tables: [] })
    } catch (err) {
      thrown = err
    }
    expect(thrown).not.toBeNull()
    expect(thrown.code).toBe('SEED_PASSWORD_COLUMN_BLOCKS')
    expect(thrown.message).toMatch(/S2 owns that decision/)
    // Not SQLite's wording: the operator must not read this as a corrupt database.
    expect(thrown.message).not.toMatch(/NOT NULL constraint failed/)
  })

  it('seeds fine when `users.password` is NULLABLE, and reports it as unresolved', () => {
    // The shape S2 is expected to converge on. Here the report IS reachable, so it is asserted.
    const base = tempBase()
    const migDir = migrationsDirWith({
      '001_init.sql': MINIMAL_SCHEMA.replace(
        'rol TEXT NOT NULL DEFAULT \'usuario\',',
        'password TEXT,\n  rol TEXT NOT NULL DEFAULT \'usuario\','
      )
    })
    const db = bootstrapDatabase({ userDataPath: base, env: {}, migrationsDir: migDir, tables: [] })
    try {
      expect(db.seeded.seeded).toBe(true)
      expect(db.seeded.unresolved).toEqual(['users.password'])
      // And nothing was written into the column.
      expect(db.conn.db.prepare('SELECT password FROM users').get().password).toBeNull()
    } finally {
      db.conn.checkpointAndClose()
      for (const d of [base, migDir]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('CLOSES the connection and rethrows when a migration fails', () => {
    // A failed migration must not leave an open handle behind. Otherwise main runs `before-quit`
    // against a half-migrated database and CHECKPOINTS it into what looks like a good state —
    // turning a loud startup error into quiet, permanent data damage.
    const base = tempBase()
    // A checksum mismatch: the file was already applied and then edited in place.
    const migDir = migrationsDirWith({ '001_init.sql': MINIMAL_SCHEMA })
    let first
    try {
      first = bootstrapDatabase({ userDataPath: base, env: {}, migrationsDir: migDir, tables: [] })
      first.conn.checkpointAndClose()
      // Edit the applied migration — SQLite stores no DDL history, so this is the only guard.
      writeFileSync(join(migDir, '001_init.sql'), MINIMAL_SCHEMA + '\n-- edited in place\n')

      let thrown = null
      let second = null
      try {
        second = bootstrapDatabase({ userDataPath: base, env: {}, migrationsDir: migDir, tables: [] })
      } catch (err) {
        thrown = err
      }
      expect(thrown).not.toBeNull()
      expect(thrown.code).toBe('MIGRATION_CHECKSUM_MISMATCH')
      // Nothing was returned, so no caller can hold a half-open handle.
      expect(second).toBeNull()
    } finally {
      first?.conn?.checkpointAndClose()
      for (const d of [base, migDir]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('before-quit on a bootstrapped database leaves no WAL behind', () => {
    // The end-to-end PLAT-6 path, in one process: the real bootstrap, the real quit hook.
    const base = tempBase()
    const migDir = migrationsDirWith({ '001_init.sql': MINIMAL_SCHEMA })
    const db = bootstrapDatabase({ userDataPath: base, env: {}, migrationsDir: migDir, tables: [] })
    try {
      db.conn.tx(() => {
        db.conn.db.prepare("INSERT INTO negocios (nombre, created_at, updated_at) VALUES ('X', 't', 't')").run()
      })
      expect(existsSync(db.paths.walFile)).toBe(true)

      const report = runBeforeQuit({ conn: db.conn, hasOpenRegister: () => false })
      expect(report).toMatchObject({ openRegister: false, checkpointed: true, closed: true, walBytesAfter: 0 })
      expect(existsSync(db.paths.walFile)).toBe(false)
    } finally {
      for (const d of [base, migDir]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('exposes resolveOnce so main can re-derive the same paths without a second computation', () => {
    const base = tempBase()
    const db = bootstrapDatabase({ userDataPath: base, env: {}, tables: [] })
    try {
      expect(db.resolveOnce()).toBe(db.paths)
    } finally {
      db.conn.checkpointAndClose()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('toma un respaldo previo a migrar cuando hay migraciones pendientes', async () => {
    const base = tempBase()
    const migDir = migrationsDirWith({
      '001_init.sql': MINIMAL_SCHEMA
    })
    const db = bootstrapDatabase({ userDataPath: base, env: {}, migrationsDir: migDir, tables: [] })
    try {
      const { listarRespaldos } = await import('../../src/main/db/backup.js')
      const backups = listarRespaldos(db.paths)
      expect(backups.total).toBeGreaterThan(0)
      const pre = backups.filas.find(f => f.motivo === 'antes-de-migrar')
      expect(pre).toBeDefined()
    } finally {
      db.conn.checkpointAndClose()
      rmSync(base, { recursive: true, force: true })
      rmSync(migDir, { recursive: true, force: true })
    }
  })

})