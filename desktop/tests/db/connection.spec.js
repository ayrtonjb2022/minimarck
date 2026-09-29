import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../../src/main/db/connection.js'
import { IpcError } from '../../src/main/bridge/errors.js'

/**
 * PLAT-4 / PLAT-6 foundations, plus the transaction runner contract (design §C.4).
 *
 * Every test here runs against a REAL `node:sqlite` file in a real temp directory. A mocked
 * connection would prove nothing about the two things this file exists to prove: that a domain
 * error survives a ROLLBACK, and that the authorizer's argument positions are what the gate
 * assumes they are.
 */

let base
let dbFile
let walFile

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'mm-conn-'))
  dbFile = path.join(base, 'minimarck.db')
  walFile = path.join(base, 'minimarck.db-wal')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('pragmas (design §C.5)', () => {
  it('opens in WAL with foreign keys ON and a 5s busy timeout', () => {
    const conn = openDatabase(dbFile, { walFile })
    try {
      expect(conn.pragma('journal_mode').journal_mode).toBe('wal')
      expect(conn.pragma('foreign_keys').foreign_keys).toBe(1)
      expect(conn.pragma('busy_timeout').timeout).toBe(5000)
    } finally {
      conn.checkpointAndClose()
    }
  })

  it('actually enforces foreign keys (SQLite defaults them OFF per connection)', () => {
    const conn = openDatabase(dbFile, { walFile, tables: ['parent', 'child'] })
    try {
      conn.db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)')
      conn.db.exec('CREATE TABLE child (id INTEGER PRIMARY KEY, p INTEGER REFERENCES parent(id))')
      // If foreign_keys were off, this would silently insert an orphan row.
      expect(() => conn.db.prepare('INSERT INTO child (id, p) VALUES (1, 999)').run())
        .toThrow(/FOREIGN KEY|foreign key/i)
    } finally {
      conn.checkpointAndClose()
    }
  })
})

describe('TxRunner (design §C.4)', () => {
  it('commits and returns the callback result', () => {
    const conn = openDatabase(dbFile, { walFile, tables: ['t'] })
    try {
      conn.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
      const out = conn.tx(() => {
        conn.db.prepare("INSERT INTO t (id, v) VALUES (1, 'a')").run()
        return 'done'
      })
      expect(out).toBe('done')
      expect(conn.db.prepare('SELECT COUNT(*) c FROM t').get().c).toBe(1)
    } finally {
      conn.checkpointAndClose()
    }
  })

  it('rolls back on a domain error AND rethrows the DOMAIN error, not the rollback failure', () => {
    // This is the SALE-1 requirement: the caller must see STOCK_INSUFICIENTE, never a raw
    // SQLITE_ERROR, and the writes must be gone either way.
    const conn = openDatabase(dbFile, { walFile, tables: ['t'] })
    try {
      conn.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
      const domainErr = new IpcError('STOCK_INSUFICIENTE', 422, 'insufficient stock')
      expect(() => conn.tx(() => {
        conn.db.prepare("INSERT INTO t (id, v) VALUES (1, 'partial')").run()
        throw domainErr
      })).toThrow(domainErr)
      expect(conn.db.prepare('SELECT COUNT(*) c FROM t').get().c).toBe(0)
    } finally {
      conn.checkpointAndClose()
    }
  })

  it('re-enters instead of opening a nested transaction', () => {
    const conn = openDatabase(dbFile, { walFile, tables: ['t'] })
    try {
      conn.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
      conn.tx(() => {
        conn.db.prepare('INSERT INTO t (id) VALUES (1)').run()
        conn.tx(() => conn.db.prepare('INSERT INTO t (id) VALUES (2)').run())
        expect(conn.txDepth()).toBe(1)
      })
      // Two rows, one commit: a nested BEGIN would have failed outright.
      expect(conn.db.prepare('SELECT COUNT(*) c FROM t').get().c).toBe(2)
    } finally {
      conn.checkpointAndClose()
    }
  })

  it('refuses an async body instead of committing a half-finished transaction', () => {
    // node:sqlite is synchronous, so an `async` body would COMMIT before its first real
    // statement. Silently committing there is a corrupted ledger, so the runner rejects it.
    const conn = openDatabase(dbFile, { walFile, tables: ['t'] })
    try {
      conn.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
      expect(() => conn.tx(() => Promise.resolve(1))).toThrow(/Promise/)
      expect(conn.db.prepare('SELECT COUNT(*) c FROM t').get().c).toBe(0)
      expect(conn.txDepth()).toBe(0)
    } finally {
      conn.checkpointAndClose()
    }
  })

  it('read() runs a deferred transaction and still discards on error', () => {
    const conn = openDatabase(dbFile, { walFile, tables: ['t'] })
    try {
      conn.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
      expect(conn.read(() => conn.db.prepare('SELECT COUNT(*) c FROM t').get().c)).toBe(0)
      expect(() => conn.read(() => { throw new Error('read blew up') })).toThrow('read blew up')
      expect(conn.txDepth()).toBe(0)
    } finally {
      conn.checkpointAndClose()
    }
  })
})

describe('the write allowlist (deny by default)', () => {
  /**
   * Create the schema with a WIDE allowlist, then reopen NARROW.
   *
   * The gate is armed as soon as the connection opens, so a test cannot use one connection to
   * both create a table and assert that writing it is refused: the `CREATE TABLE` is itself a
   * gated mutation and is denied first. Two passes — schema installed, then a narrower runtime
   * allowlist over the same file — is also exactly the production shape (S2 installs the schema,
   * then each slice declares the tables it writes).
   */
  function withSchema(sql, { setupTables, runtimeTables, assert }) {
    const setup = openDatabase(dbFile, { walFile, tables: setupTables })
    try {
      setup.db.exec(sql)
    } finally {
      setup.checkpointAndClose()
    }
    const conn = openDatabase(dbFile, { walFile, tables: runtimeTables })
    try {
      assert(conn)
    } finally {
      conn.checkpointAndClose()
    }
  }

  it('denies a write to a table that was never declared', () => {
    withSchema(
      'CREATE TABLE denied (id INTEGER PRIMARY KEY); CREATE TABLE allowed (id INTEGER PRIMARY KEY)',
      {
        setupTables: ['denied', 'allowed'],
        runtimeTables: ['allowed'],
        assert: (conn) => {
          expect(() => conn.db.prepare('INSERT INTO allowed (id) VALUES (1)').run()).not.toThrow()
          expect(() => conn.db.prepare('INSERT INTO denied (id) VALUES (1)').run())
            .toThrow(/authoriz|not authorized/i)
        }
      }
    )
  })

  it('produces a REAL SQLITE_DENY (errcode 23), not a malformed-callback error', () => {
    // The distinction this protects: returning a wrong constant raises "Authorizer callback
    // returned a invalid authorization code" — a broken gate — and a test that only asserts
    // "it threw" passes for both. errcode 23 / "authorization denied" proves the gate armed.
    withSchema('CREATE TABLE t (id INTEGER PRIMARY KEY)', {
      setupTables: ['t'],
      runtimeTables: [],
      assert: (conn) => {
        let caught = null
        try {
          conn.db.prepare('INSERT INTO t (id) VALUES (1)').run()
        } catch (err) {
          caught = err
        }
        expect(caught).not.toBeNull()
        expect(caught.errcode).toBe(23)
        expect(caught.message).toMatch(/not authorized|authorization denied/i)
        expect(caught.message).not.toMatch(/invalid authorization code/i)
      }
    })
  })

  it('gates ALTER TABLE by its TABLE argument, not its database argument', () => {
    // Measured on SQLite 3.53.1: ALTER TABLE reports a1="main" (the DATABASE) and a2="t" (the
    // table). A gate written as `arg1 === table` therefore lets every ALTER TABLE through
    // while still blocking inserts — an armed-looking, disarmed control. Both directions are
    // asserted so a refactor cannot move the index silently.
    withSchema(
      'CREATE TABLE allowed (id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE other (id INTEGER PRIMARY KEY, v TEXT)',
      {
        setupTables: ['allowed', 'other'],
        runtimeTables: ['allowed'],
        assert: (conn) => {
          expect(() => conn.db.exec('ALTER TABLE allowed ADD COLUMN extra TEXT')).not.toThrow()
          expect(() => conn.db.exec('ALTER TABLE other ADD COLUMN extra TEXT'))
            .toThrow(/authoriz|not authorized/i)
        }
      }
    )
  })

  it('gates CREATE/DROP INDEX by the table it belongs to', () => {
    withSchema(
      'CREATE TABLE allowed (id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE other (id INTEGER PRIMARY KEY, v TEXT)',
      {
        setupTables: ['allowed', 'other'],
        runtimeTables: ['allowed'],
        assert: (conn) => {
          expect(() => conn.db.exec('CREATE INDEX ix_allowed_v ON allowed(v)')).not.toThrow()
          expect(() => conn.db.exec('CREATE INDEX ix_other_v ON other(v)'))
            .toThrow(/authoriz|not authorized/i)
        }
      }
    )
  })

  it('honours allowTable() as the migration runner uses it', () => {
    withSchema('CREATE TABLE t (id INTEGER PRIMARY KEY)', {
      setupTables: ['t'],
      runtimeTables: [],
      assert: (conn) => {
        expect(() => conn.db.prepare('INSERT INTO t (id) VALUES (1)').run()).toThrow()
        conn.allowTable('t')
        expect(() => conn.db.prepare('INSERT INTO t (id) VALUES (1)').run()).not.toThrow()
        expect(conn.allowedTables()).toContain('t')
      }
    })
  })

  it('refuses ATTACH/DETACH unconditionally (one file, one process)', () => {
    const conn = openDatabase(dbFile, { walFile, tables: ['t'] })
    try {
      expect(() => conn.db.exec("ATTACH DATABASE 'other.db' AS other")).toThrow(/authoriz/i)
    } finally {
      conn.checkpointAndClose()
    }
  })
})

describe('checkpointAndClose (PLAT-6)', () => {
  it('truncates the WAL to zero bytes and closes', () => {
    const conn = openDatabase(dbFile, { walFile, tables: ['t'] })
    conn.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    // wal_autocheckpoint=0 so the WAL is guaranteed to still hold frames at the assertion
    // point; with the default 1000-page threshold it may already have been folded in.
    conn.db.exec('PRAGMA wal_autocheckpoint = 0')
    conn.db.prepare('INSERT INTO t (id) VALUES (?)').run(1)
    expect(existsSync(walFile)).toBe(true)

    const result = conn.checkpointAndClose()
    expect(result.checkpointed).toBe(true)
    expect(result.closed).toBe(true)
    expect(result.walBytesAfter).toBe(0)
    expect(conn.isOpen()).toBe(false)
  })

  it('is idempotent: a second call reports already_closed instead of throwing', () => {
    const conn = openDatabase(dbFile, { walFile })
    conn.checkpointAndClose()
    expect(conn.checkpointAndClose()).toMatchObject({ closed: false, reason: 'already_closed' })
  })

  it('userVersion() reads PRAGMA user_version, and it is the migration runner\'s state', () => {
    const conn = openDatabase(dbFile, { walFile })
    try {
      expect(conn.userVersion()).toBe(0)
      conn.db.exec('PRAGMA user_version = 7')
      expect(conn.userVersion()).toBe(7)
    } finally {
      conn.checkpointAndClose()
    }
  })
})
