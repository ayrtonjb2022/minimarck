import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRegistry } from '../../src/main/bridge/registry.js'
import { OPS, OPS_COUNT, TOPICS } from '../../src/shared/ipc-contract.js'
import { registerDbHandlers } from '../../src/main/ipc/db.js'
import { bootstrapDatabase } from '../../src/main/db/bootstrap.js'
import { readMigrations } from '../../src/main/db/migrate.js'
import { fileURLToPath } from 'node:url'

/**
 * The real migration set on disk, so "the version on disk" is derived and never retyped.
 *
 * Anchored on this file's own URL, not on `process.cwd()`: vitest runs this file with the
 * REPOSITORY as the CWD, so a `path.resolve('src/main/...')` silently pointed at a directory
 * that does not exist and `readMigrations` returned `[]` — which made the derived expectation
 * vacuously true in the first attempt at this change. A version assertion that reads an empty
 * list is worse than a hardcoded one.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../src/main/db/migrations', import.meta.url))

/**
 * The IPC allowlist (SEC-2). The security claim is that the renderer cannot express SQL,
 * name a table, or reach the filesystem — enforced by the frozen OPS contract plus the
 * registry's two gates (unknown group/op, and not-implemented-in-this-build).
 */

describe('frozen OPS contract', () => {
  it('contains exactly 89 operations', () => {
    // 88, until `ventas.cancel`. The literal is the point: `OPS_COUNT` is derived from `OPS`, so
    // asserting it against itself would pass no matter what the contract said. This test is the
    // place where growing the contract has to be noticed.
    expect(OPS_COUNT).toBe(89)
  })

  it('exposes NO channel that could carry SQL, a table name, or a file path', () => {
    // The allowlist is the whole security claim: if none of these exist as operations,
    // the renderer has no way to express SQL even if it tried.
    const sqlEscape = ['query', 'exec', 'sql', 'raw', 'run', 'pragma', 'statement', 'prepare', 'readFile', 'writeFile', 'table']
    for (const [group, ops] of Object.entries(OPS)) {
      for (const op of ops) {
        // No operation is a raw-SQL / escape primitive.
        expect(sqlEscape, `${group}.${op}`).not.toContain(op.toLowerCase())
        // No operation is a full SQL statement (i.e. carries its own keywords + space).
        // A bare business verb like `update` or `remove` is legitimate and present in the
        // contract; what must never appear is a statement that names a table or clause.
        expect(op.toLowerCase(), `${group}.${op}`).not.toMatch(
          /^(select|insert\s+into|update\s+\w|delete\s+from|drop\s+table|alter\s+table)/
        )
      }
    }
  })

  it('uses business verbs, not SQL, as its operation vocabulary', () => {
    // The positive statement of the same claim: the contract is CRUD-over-aggregates.
    const all = Object.values(OPS).flat()
    for (const verb of ['list', 'get', 'create', 'update', 'remove', 'cancel', 'close', 'open']) {
      expect(all).toContain(verb)
    }
  })
})

describe('registry allowlist (SEC-2)', () => {
  it('rejects an unknown group with UNKNOWN_GROUP', () => {
    const r = createRegistry()
    expect(() => r.resolve('evil', 'dropTables')).toThrowError(/Unknown group/)
  })

  it('rejects an unknown op within a real group with UNKNOWN_OP', () => {
    const r = createRegistry()
    expect(() => r.resolve('ventas', 'dropEverything')).toThrowError(/Unknown op/)
  })

  it('resolves a contract member with no handler to NOT_IMPLEMENTED, not a crash', () => {
    const r = createRegistry()
    try {
      r.resolve('ventas', 'create')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e.code).toBe('NOT_IMPLEMENTED')
      expect(e.status).toBe(501)
    }
  })

  it('refuses to register an operation that is not in the frozen contract', () => {
    const r = createRegistry()
    expect(() => r.register('ventas', { dbQuery: () => 'nope' })).toThrowError(/not in the frozen OPS contract/)
  })

  it('resolves a registered handler and runs it with the payload', async () => {
    const r = createRegistry()
    r.register('ventas', { list: (payload) => ({ echoed: payload.page ?? 1 }) })
    const fn = r.resolve('ventas', 'list')
    expect(await fn({ page: 3 }, {})).toEqual({ echoed: 3 })
  })
})

describe('S1 registered surface', () => {
  // These two tests were S0-era and asserted things S1 deliberately changed. Both are rewritten
  // here against the REAL production wiring — `bootstrapDatabase()` — rather than a hand-built
  // stub of the handler's inputs, because the S0 version of this file passed for two slices
  // while never exercising the composition that actually runs at startup.
  const IMPLEMENTED = new Set(['db.info', 'db.schemaVersion'])

  it('registers ONLY db.info and db.schemaVersion — db.reconcile stays unregistered on purpose', () => {
    const r = createRegistry()
    const base = mkdtempSync(join(tmpdir(), 'mm-surface-'))
    const db = bootstrapDatabase({ userDataPath: base, env: {}, tables: [] })
    try {
      registerDbHandlers(r, db)
      for (const group of Object.keys(OPS)) {
        for (const op of OPS[group]) {
          // Every other contract op must be unimplemented so later slices own them honestly.
          // `db.reconcile` is in this set on purpose: S1 now has a REAL database open, so a
          // synthetic "nothing to reconcile" answer would be worse than a 501.
          expect(r.isImplemented(group, op), `${group}.${op}`).toBe(IMPLEMENTED.has(`${group}.${op}`))
        }
      }
      // And the consequence, which is the honest part: it resolves, then 501s.
      expect(r.isImplemented('db', 'reconcile')).toBe(false)
    } finally {
      db.conn.checkpointAndClose()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('db.info reports the REAL open database, not synthetic placeholders', () => {
    const base = mkdtempSync(join(tmpdir(), 'mm-registry-'))
    const db = bootstrapDatabase({ userDataPath: base, env: {}, tables: [] })
    try {
      const r = createRegistry()
      registerDbHandlers(r, db)
      const info = r.resolve('db', 'info')({})

      expect(info.dbFile).toContain('minimarck.db')
      expect(info.dataDir).toBe(join(base, 'data'))
      expect(info.exists).toBe(true) // S1 opens it; S0 reported false
      expect(info.sizeBytes).toBeGreaterThan(0) // a real file, not null
      // Read from the live connection now, not hardcoded.
      expect(info.journalMode).toBe('wal')
      // Every migration file must be APPLIED, so the version is the file count — derived, not
      // typed. This used to be the literal `1`, which meant adding `002_identidades.sql` made
      // this test red for the right reason: the version on disk had to be re-derived, not
      // retyped. A literal here would have been a number that quietly stops meaning anything.
      expect(info.schemaVersion).toBe(readMigrations(MIGRATIONS_DIR).length)
      expect(info.schemaVersion).toBe(db.conn.userVersion())
      expect(typeof info.sqlite).toBe('string')
      // `tables: []` was passed and the caller still cannot write a business table directly:
      // the 20 that are writable were allowlisted by `tablesCreatedBy` walking 001_init.sql,
      // not by the caller's empty array.
      expect(db.conn.allowedTables()).not.toEqual(['schema_migrations'])
      expect(db.conn.allowedTables()).toContain('ventas')
      expect(info.writableTables).toBe(db.conn.allowedTables().length)
      // A table the schema does not declare stays refused.
      expect(() => db.conn.db.exec('CREATE TABLE sneaky (id INTEGER)')).toThrow()
    } finally {
      db.conn.checkpointAndClose()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('db.schemaVersion reports the real PRAGMA user_version and an empty pending list', () => {
    const base = mkdtempSync(join(tmpdir(), 'mm-version-'))
    const db = bootstrapDatabase({ userDataPath: base, env: {}, tables: [] })
    try {
      const r = createRegistry()
      registerDbHandlers(r, db)
      const v = r.resolve('db', 'schemaVersion')({})
      expect(v.userVersion).toBe(readMigrations(MIGRATIONS_DIR).length)
      expect(v.userVersion).toBe(db.conn.userVersion())
      // `migrated` must agree with the real version, and `available` with the real file count.
      expect(v.migrated).toBe(true)
      expect(v.available).toBe(readMigrations(MIGRATIONS_DIR).length)
      expect(v.pending).toBe(0)
      // `lastRun` is what THIS launch applied. On a FRESH userDataPath that is EVERY migration,
      // not `[]` and not a hand-written number: 001_init.sql runs now, and so does
      // 002_identidades.sql beside it. Asserted as the real `db.migration.applied` so the
      // expectation tracks the directory instead of drifting one migration behind again.
      expect(v.lastRun.applied).toEqual(db.migration.applied)
      expect(v.lastRun.applied).toEqual([1, 2, 3])
    } finally {
      db.conn.checkpointAndClose()
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('event topics (SEC-2)', () => {
  it('exposes exactly the four allowed topics', () => {
    expect(TOPICS).toEqual(['backup:progress', 'import:progress', 'db:changed', 'theme:changed'])
  })
})

describe('registry encapsulation', () => {
  it('does NOT expose the mutable handlers map', () => {
    // The map is the one structure holding a callable reference to every business handler
    // in the app. The allowlist check runs before dispatch so an entry could not be reached
    // even if one were attached — but nothing needs the map, and a closure that cannot leak
    // cannot leak.
    const r = createRegistry()
    expect(r.handlers).toBeUndefined()
    expect(Object.keys(r).sort()).toEqual(['isImplemented', 'register', 'resolve'])
  })
})
