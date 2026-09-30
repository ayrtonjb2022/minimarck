import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../../src/main/db/connection.js'
import { readMigrations, migrate, tablesCreatedBy, LEDGER_TABLE } from '../../src/main/db/migrate.js'

/**
 * The migration runner (design §D.6), against REAL migration files in a REAL temp directory.
 *
 * `node:sqlite` has no mocking seam for `PRAGMA user_version`, and this is precisely the
 * behaviour worth testing: that the version moves in the SAME transaction as the DDL. Writing
 * these against a fake connection would test the fake.
 */

let base
let dbFile
let walFile
let migrationsDir

/** Fixed clock: `applied_at` is asserted on, and a real clock would make it untestable. */
const NOW = () => '2026-01-01T00:00:00.000Z'

function writeMigration(file, sql) {
  writeFileSync(path.join(migrationsDir, file), sql, 'utf8')
}

/**
 * Assert on `IpcError.code`, never on the message.
 *
 * `IpcError` keeps `{ code, status, message }` separate on purpose: only those three cross IPC,
 * and the message is free to be reworded. A test that greps the message for the code breaks the
 * first time someone improves the wording — and, worse, passes for the WRONG error if some
 * other failure happens to mention the same word.
 */
function expectCode(fn, code) {
  let caught = null
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(caught, `expected ${code} to be thrown, got ${caught === null ? 'no error' : caught.message}`).not.toBeNull()
  expect(caught.code).toBe(code)
  return caught
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'mm-migrate-'))
  dbFile = path.join(base, 'minimarck.db')
  walFile = path.join(base, 'minimarck.db-wal')
  migrationsDir = path.join(base, 'migrations')
  mkdirSync(migrationsDir, { recursive: true })
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('readMigrations', () => {
  it('returns [] for a missing directory — the correct state before S2 ships 001', () => {
    expect(readMigrations(path.join(base, 'nope'))).toEqual([])
  })

  it('orders by the numeric prefix, not the filename', () => {
    writeMigration('001_init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY)')
    writeMigration('010_ten.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY)')
    writeMigration('002_two.sql', 'CREATE TABLE c (id INTEGER PRIMARY KEY)')
    expect(readMigrations(migrationsDir).map((m) => m.version)).toEqual([1, 2, 10])
  })

  it('refuses a .sql file it cannot order rather than skipping it', () => {
    // Silently ignoring an unorderable migration ships half a schema and then reports a
    // version that lies about what ran.
    writeMigration('init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY)')
    expectCode(() => readMigrations(migrationsDir), 'MIGRATION_BAD_FILENAME')
  })

  it('refuses two files claiming the same version', () => {
    writeMigration('001_init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY)')
    writeMigration('001_other.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY)')
    expectCode(() => readMigrations(migrationsDir), 'MIGRATION_DUPLICATE_VERSION')
  })
})

describe('migrate', () => {
  it('applies pending migrations in order and sets user_version', () => {
    writeMigration('001_init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY)')
    writeMigration('002_more.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY)')
    const conn = openDatabase(dbFile, { walFile, tables: [] })
    try {
      const out = migrate(conn, { dir: migrationsDir, now: NOW })
      expect(out.applied).toEqual([1, 2])
      expect(out.userVersion).toBe(2)
      expect(conn.userVersion()).toBe(2)
      const tables = conn.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('a','b')")
        .all()
        .map((r) => r.name)
      expect(tables.sort()).toEqual(['a', 'b'])
    } finally {
      conn.checkpointAndClose()
    }
  })

  it('is a no-op on the second run (idempotent)', () => {
    writeMigration('001_init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY)')
    const first = openDatabase(dbFile, { walFile })
    try {
      expect(migrate(first, { dir: migrationsDir, now: NOW }).applied).toEqual([1])
    } finally {
      first.checkpointAndClose()
    }
    // A NEW connection, as a real relaunch would be.
    const second = openDatabase(dbFile, { walFile })
    try {
      const out = migrate(second, { dir: migrationsDir, now: NOW })
      expect(out.applied).toEqual([])
      expect(out.userVersion).toBe(1)
      const rows = second.db.prepare(`SELECT COUNT(*) c FROM ${LEDGER_TABLE}`).get().c
      expect(rows).toBe(1)
    } finally {
      second.checkpointAndClose()
    }
  })

  it('applies only the pending tail when a new file arrives', () => {
    writeMigration('001_init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY)')
    const first = openDatabase(dbFile, { walFile })
    try {
      migrate(first, { dir: migrationsDir, now: NOW })
    } finally {
      first.checkpointAndClose()
    }
    writeMigration('002_more.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY)')
    const second = openDatabase(dbFile, { walFile })
    try {
      const out = migrate(second, { dir: migrationsDir, now: NOW })
      expect(out.applied).toEqual([2])
      expect(out.userVersion).toBe(2)
    } finally {
      second.checkpointAndClose()
    }
  })

  it('rolls back BOTH the DDL and user_version when a migration throws', () => {
    // The core guarantee: PRAGMA user_version is transactional, so a half-applied migration
    // cannot leave the version claiming a schema that was rolled away.
    writeMigration('001_ok.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY)')
    writeMigration(
      '002_broken.sql',
      'CREATE TABLE b (id INTEGER PRIMARY KEY); CREATE TABLE b (id INTEGER PRIMARY KEY)'
    )
    const conn = openDatabase(dbFile, { walFile })
    try {
      // A raw SQLite error, deliberately: this is the engine refusing a duplicate table, and
      // the point of the test is the ROLLBACK, not the error's shape.
      expect(() => migrate(conn, { dir: migrationsDir, now: NOW })).toThrow()
      expect(conn.userVersion()).toBe(1)
      const bExists = conn.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='b'")
        .get()
      expect(bExists).toBeUndefined()
      const ledger = conn.db
        .prepare(`SELECT version FROM ${LEDGER_TABLE} ORDER BY version`)
        .all()
        .map((r) => r.version)
      expect(ledger).toEqual([1])
    } finally {
      conn.checkpointAndClose()
    }
  })

  it('REFUSES to apply anything when an applied migration file was edited', () => {
    writeMigration('001_init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY)')
    const first = openDatabase(dbFile, { walFile })
    try {
      migrate(first, { dir: migrationsDir, now: NOW })
    } finally {
      first.checkpointAndClose()
    }
    // In-place edit of an applied migration: the classic "it works on my machine" schema drift.
    writeMigration('001_init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT)')
    writeMigration('002_more.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY)')
    const second = openDatabase(dbFile, { walFile })
    try {
      expectCode(() => migrate(second, { dir: migrationsDir, now: NOW }), 'MIGRATION_CHECKSUM_MISMATCH')
      // Nothing ran: 002 is not applied.
      expect(second.userVersion()).toBe(1)
      const b = second.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='b'").get()
      expect(b).toBeUndefined()
    } finally {
      second.checkpointAndClose()
    }
  })

  it('refuses a version gap — a missing file is a packaging bug, not a no-op', () => {
    writeMigration('001_init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY)')
    writeMigration('003_never_shipped.sql', 'CREATE TABLE c (id INTEGER PRIMARY KEY)')
    const conn = openDatabase(dbFile, { walFile })
    try {
      expectCode(() => migrate(conn, { dir: migrationsDir, now: NOW }), 'MIGRATION_SEQUENCE_GAP')
      expect(conn.userVersion()).toBe(0)
    } finally {
      conn.checkpointAndClose()
    }
  })

  it('refuses when an applied migration file disappeared from the package', () => {
    writeMigration('001_init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY)')
    writeMigration('002_more.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY)')
    const first = openDatabase(dbFile, { walFile })
    try {
      migrate(first, { dir: migrationsDir, now: NOW })
    } finally {
      first.checkpointAndClose()
    }
    rmSync(path.join(migrationsDir, '001_init.sql'))
    const second = openDatabase(dbFile, { walFile })
    try {
      expectCode(() => migrate(second, { dir: migrationsDir, now: NOW }), 'MIGRATION_MISSING_FILE')
    } finally {
      second.checkpointAndClose()
    }
  })

  it('refuses when the ledger and user_version disagree', () => {
    writeMigration('001_init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY)')
    const conn = openDatabase(dbFile, { walFile })
    try {
      migrate(conn, { dir: migrationsDir, now: NOW })
      // Hand-corrupt the version, as an interrupted third-party tool would.
      conn.db.exec('PRAGMA user_version = 5')
      expectCode(() => migrate(conn, { dir: migrationsDir, now: NOW }), 'MIGRATION_VERSION_DIVERGENCE')
    } finally {
      conn.checkpointAndClose()
    }
  })

  it('records name, checksum and applied_at in the ledger', () => {
    writeMigration('001_init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY)')
    const conn = openDatabase(dbFile, { walFile })
    try {
      migrate(conn, { dir: migrationsDir, now: NOW })
      const row = conn.db.prepare(`SELECT * FROM ${LEDGER_TABLE}`).get()
      expect(row.version).toBe(1)
      expect(row.name).toBe('init.sql')
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/)
      expect(row.applied_at).toBe('2026-01-01T00:00:00.000Z')
    } finally {
      conn.checkpointAndClose()
    }
  })
})

describe('tablesCreatedBy', () => {
  it('finds the table a migration creates, so the runner can widen the allowlist', () => {
    expect(tablesCreatedBy('CREATE TABLE IF NOT EXISTS ventas (id INTEGER PRIMARY KEY)'))
      .toEqual(['ventas'])
    expect(tablesCreatedBy('CREATE TABLE "productos" (id INTEGER); CREATE TABLE linea (id INTEGER)'))
      .toEqual(['productos', 'linea'])
    expect(tablesCreatedBy('SELECT 1')).toEqual([])
  })
})

describe('the allowlist survives a launch with nothing to migrate', () => {
  /**
   * The regression that shipped: the authorizer was widened inside the `pending` loop, so the
   * second launch of a real installation had an empty allowlist and every write came back
   * `SQLITE_AUTH: not authorized`. A shop could open the till and sell once, then never again.
   *
   * The payment drive could not see it because it always starts from a throwaway database where
   * migration 001 is pending. This test opens the SAME file twice, which is the only shape that
   * catches it, and asserts on the authorizer's verdict rather than on the allowlist's contents —
   * the contents are an implementation detail, the verdict is the behaviour.
   */
  it('still permits writes when migrate() applies nothing', () => {
    writeMigration('001_init.sql', 'CREATE TABLE auditoria (id INTEGER PRIMARY KEY, tabla TEXT NOT NULL)')

    const first = openDatabase(dbFile, { walFile })
    try {
      migrate(first, { dir: migrationsDir, now: NOW })
      first.tx(() => first.db.prepare(`INSERT INTO auditoria (tabla) VALUES ('primera')`).run())
    } finally {
      first.checkpointAndClose()
    }

    const second = openDatabase(dbFile, { walFile })
    try {
      const result = migrate(second, { dir: migrationsDir, now: NOW })
      expect(result.applied).toEqual([])
      expect(result.userVersion).toBe(1)

      expect(() =>
        second.tx(() => second.db.prepare(`INSERT INTO auditoria (tabla) VALUES ('segunda')`).run())
      ).not.toThrow()

      const rows = second.db.prepare('SELECT tabla FROM auditoria ORDER BY id').all()
      expect(rows.map((r) => r.tabla)).toEqual(['primera', 'segunda'])
    } finally {
      second.checkpointAndClose()
    }
  })

  it('widens the allowlist for tables declared by APPLIED migrations, not just pending ones', () => {
    // Same three lines as the test above would be re-testing behaviour, not the rule behind it: the
    // allowlist is built from the full migration SET, so a table whose migration ran on a previous
    // launch is writable now. The assertion is on a fresh connection, which is the only way to see
    // a stale allowlist.
    writeMigration(
      '001_init.sql',
      'CREATE TABLE productos (id INTEGER PRIMARY KEY, nombre TEXT NOT NULL); ' +
        'CREATE TABLE auditoria (id INTEGER PRIMARY KEY, tabla TEXT NOT NULL)'
    )
    const first = openDatabase(dbFile, { walFile })
    try {
      migrate(first, { dir: migrationsDir, now: NOW })
    } finally {
      first.checkpointAndClose()
    }

    const second = openDatabase(dbFile, { walFile })
    try {
      migrate(second, { dir: migrationsDir, now: NOW })
      expect(() =>
        second.tx(() => second.db.prepare(`INSERT INTO productos (nombre) VALUES ('Gaseosa')`).run())
      ).not.toThrow()
    } finally {
      second.checkpointAndClose()
    }
  })
})
