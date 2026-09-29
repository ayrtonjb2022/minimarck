import { DatabaseSync, constants as SQLITE } from 'node:sqlite'
import { statSync, existsSync } from 'node:fs'
import { IpcError } from '../bridge/errors.js'

/**
 * The SQLite connection, the pragmas the design mandates, the table allowlist, and the
 * transaction runner. This is the module `PLAT-6` (WAL checkpoint on quit) belongs to.
 *
 * The connection pragma set is design §C.5 verbatim: `journal_mode=WAL`, `foreign_keys=ON`,
 * `busy_timeout=5000`. WAL is what makes the "copy the .db by hand" recovery path work;
 * `foreign_keys=ON` is what makes the real FKs in §D.3 mean anything (SQLite defaults it OFF
 * per connection, silently); `busy_timeout` is what turns a contended write into a 5s wait
 * instead of an instant `SQLITE_BUSY`.
 */

/**
 * Authorizer action codes, taken from the runtime's own `constants` export.
 *
 * NEVER hand-type these. They are small integers whose meaning is only in SQLite's C header,
 * and a plausible-looking wrong number compiles, runs, and gates nothing. Two of them were
 * measured wrong in this session's first probe: `SQLITE_DENY` is **1**, not the 8 that appears
 * in most code samples, and returning 8 does not deny — it raises
 * "Authorizer callback returned a invalid authorization code", a *malformed callback* error
 * rather than a denial. A test asserting only "the insert threw" passes for both, so it proves
 * nothing; `tests/db/connection.spec.js` asserts `errcode === 23` to prove a real DENY happened.
 */
const {
  SQLITE_INSERT, SQLITE_UPDATE, SQLITE_DELETE,
  SQLITE_CREATE_TABLE, SQLITE_DROP_TABLE, SQLITE_ALTER_TABLE,
  SQLITE_CREATE_INDEX, SQLITE_DROP_INDEX,
  SQLITE_ATTACH, SQLITE_DETACH,
  SQLITE_OK, SQLITE_DENY
} = SQLITE

/**
 * Which callback argument carries the TABLE NAME, per action. Measured against SQLite 3.53.1,
 * not assumed.
 *
 * This table is the whole reason the gate is not a one-liner. The authorizer passes five
 * arguments with action-dependent meanings, and they are NOT uniform:
 *
 *   INSERT / UPDATE / DELETE / CREATE TABLE / DROP TABLE  -> arg1 is the table
 *   ALTER TABLE                                           -> arg1 is the DATABASE ("main"), arg2 is the table
 *   CREATE INDEX / DROP INDEX                             -> arg1 is the INDEX, arg2 is the table
 *
 * A gate written as `arg1 === table` therefore passes EVERY `ALTER TABLE` and every index
 * operation while still blocking plain inserts — a security control that looks armed and is not.
 * Each row below is `[action, tableArgIndex]`.
 */
const TABLE_SCOPED_ACTIONS = new Map([
  [SQLITE_INSERT, 1],
  [SQLITE_UPDATE, 1],
  [SQLITE_DELETE, 1],
  [SQLITE_CREATE_TABLE, 1],
  [SQLITE_DROP_TABLE, 1],
  [SQLITE_ALTER_TABLE, 2],
  [SQLITE_CREATE_INDEX, 2],
  [SQLITE_DROP_INDEX, 2]
])

/** One machine, one process, one database file (§P non-goals 2 and 10). Always refused. */
const ATTACH_ACTIONS = new Set([SQLITE_ATTACH, SQLITE_DETACH])

/** Tables SQLite itself maintains. Never gated: blocking these breaks the engine. */
function isInternalTable(name) {
  return typeof name === 'string' && name.startsWith('sqlite_')
}

/**
 * The authorizer. Deny-by-default on *mutating* statements against a table that is not in the
 * allowlist; reads are never gated, because denying a read would break the app rather than
 * protect it, and a read cannot corrupt the file.
 *
 * The allowlist starts EMPTY. A slice that owns a table declares it when it constructs the
 * connection, or via `allowTable()` while a migration is creating it. Forgetting to declare a
 * table is a loud, immediate failure — `SQLITE_DENY`, not a silently written row.
 */
function createAuthorizer(allowed) {
  return function authorizer(action, arg1, arg2) {
    if (ATTACH_ACTIONS.has(action)) return SQLITE_DENY
    const argIndex = TABLE_SCOPED_ACTIONS.get(action)
    if (argIndex === undefined) return SQLITE_OK
    const table = argIndex === 1 ? arg1 : arg2
    if (isInternalTable(table)) return SQLITE_OK
    return allowed.has(table) ? SQLITE_OK : SQLITE_DENY
  }
}

/**
 * `node:sqlite` is synchronous, so a transaction body is an uninterruptible critical section:
 * no `await` can interleave another writer. That is strictly stronger than the MySQL row lock
 * it replaces (design §C.4). It also means a body that is accidentally `async` is a silent,
 * catastrophic bug — the `COMMIT` would run before the body's first real statement. So the
 * runner refuses a thenable result instead of committing a half-finished transaction.
 */
class TxRunner {
  #depth = 0
  #db
  constructor(db) {
    this.#db = db
  }

  get depth() {
    return this.#depth
  }

  /** Re-entrant: a nested call JOINS the outer transaction rather than opening a second one. */
  tx(fn) {
    if (this.#depth > 0) return fn()
    this.#db.exec('BEGIN IMMEDIATE') // take the write lock NOW, not on first write
    this.#depth = 1
    let committed = false
    try {
      const result = fn()
      if (result && typeof result.then === 'function') {
        throw new IpcError(
          'TX_BODY_ASYNC', 500,
          'tx() body returned a Promise. node:sqlite is synchronous: an async body would commit before it finished.'
        )
      }
      this.#db.exec('COMMIT')
      committed = true
      this.#depth = 0
      return result
    } catch (domainErr) {
      // The DOMAIN error always wins. A rollback failure is real information but secondary:
      // it must never replace STOCK_INSUFICIENTE with a raw SQLITE_ERROR (design §C.4, SALE-1).
      let rollbackErr = null
      try {
        this.#db.exec('ROLLBACK')
      } catch (e) {
        rollbackErr = e
      } finally {
        this.#depth = 0
      }
      if (rollbackErr) {
        domainErr.rollbackFailed = true
        domainErr.rollbackError = rollbackErr.message
        // Surfaced in Settings > Diagnóstico from S17; logged now so it is never lost.
        console.error('[db] ROLLBACK failed:', rollbackErr.message)
      }
      void committed
      throw domainErr
    }
  }

  /** Read transaction. Same shape, `BEGIN DEFERRED` — WAL readers never block the writer. */
  read(fn) {
    if (this.#depth > 0) return fn()
    this.#db.exec('BEGIN DEFERRED')
    this.#depth = 1
    try {
      const result = fn()
      this.#db.exec('COMMIT')
      this.#depth = 0
      return result
    } catch (err) {
      try {
        this.#db.exec('ROLLBACK')
      } catch {
        /* the read transaction is discardable; the original error is what matters */
      } finally {
        this.#depth = 0
      }
      throw err
    }
  }
}

const DEFAULT_PRAGMAS = Object.freeze({
  journalMode: 'WAL',
  foreignKeys: 'ON',
  busyTimeoutMs: 5000
})

function walSize(walFile) {
  try {
    return existsSync(walFile) ? statSync(walFile).size : 0
  } catch {
    return null
  }
}

/**
 * Open the database. `tables` is the allowlist and defaults to EMPTY (deny-all on writes).
 *
 * Ordering note, measured rather than assumed: `enableDefensive(true)` does NOT prevent
 * `PRAGMA journal_mode = WAL` — verified both orders on SQLite 3.53.1. WAL is set first here so
 * the destructive pragma (defensive mode blocks `writable_schema` and friends) is the last
 * thing that can change the file's behaviour.
 */
export function openDatabase(dbFile, { tables = [], walFile, pragmas = {}, defensive = true } = {}) {
  const db = new DatabaseSync(dbFile)
  const p = { ...DEFAULT_PRAGMAS, ...pragmas }

  db.exec(`PRAGMA journal_mode = ${p.journalMode}`)
  db.exec(`PRAGMA foreign_keys = ${p.foreignKeys}`)
  db.exec(`PRAGMA busy_timeout = ${p.busyTimeoutMs}`)

  const allowed = new Set(tables)
  db.setAuthorizer(createAuthorizer(allowed))
  if (defensive) db.enableDefensive(true)

  const txRunner = new TxRunner(db)
  let open = true

  function userVersion() {
    return Number(db.prepare('PRAGMA user_version').get().user_version)
  }

  function pragma(name) {
    return db.prepare(`PRAGMA ${name}`).get()
  }

  /**
   * `PLAT-6` — make the on-disk `.db` self-contained before the process exits.
   *
   * `PRAGMA wal_checkpoint(TRUNCATE)` folds every committed frame back into the main database
   * file and then truncates the `-wal` to zero length. That is what makes "quit, copy
   * `minimarck.db` to another machine, open it" work: without it the committed rows are in
   * `minimarck.db-wal` and copying the `.db` alone loses them.
   *
   * EVIDENCE, and a trap worth knowing: the pragma's `(busy, log, checkpointed)` result row
   * reads `{0,0,0}` under `node:sqlite` even with a 100 KB WAL backlog — measured on SQLite
   * 3.53.1 with `wal_autocheckpoint = 0`. Those counters are therefore NOT asserted anywhere.
   * The real evidence is the `-wal` byte count going to zero plus a read from a copy of the
   * `.db` with no sidecars present, which is what `tests/db/wal-durability.spec.js` does
   * across a real process boundary.
   */
  function checkpointAndClose() {
    if (!open) return { checkpointed: false, closed: false, reason: 'already_closed' }
    const before = walSize(walFile)
    let detail = null
    let checkpointError = null
    try {
      detail = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    } catch (err) {
      // A failed checkpoint must not prevent the close: a clean ROLLBACK-on-close is better
      // than a process that refuses to exit. The error is reported, never swallowed.
      checkpointError = err.message
    }
    let closed = false
    let closeError = null
    try {
      db.close()
      open = false
      closed = true
    } catch (err) {
      closeError = err.message
    }
    return {
      checkpointed: checkpointError === null,
      closed,
      // The counters are reported for the log line and never trusted as the assertion.
      detail: detail ? { ...detail } : null,
      walBytesBefore: before,
      walBytesAfter: walSize(walFile),
      checkpointError,
      closeError
    }
  }

  return {
    db,
    // Callable, not a runner object. The design's repository contract is `ctx.tx(fn)`, so
    // `conn.tx(fn)` matching it exactly removes a whole class of confusion: an earlier draft
    // exposed the runner as `conn.tx` and every call site then needed `conn.tx.tx(fn)`, which
    // reads like a bug and is one missed `.tx` away from being one.
    tx: (fn) => txRunner.tx(fn),
    read: (fn) => txRunner.read(fn),
    /** Nesting depth, for assertions and diagnostics. */
    txDepth: () => txRunner.depth,
    file: dbFile,
    walFile,
    userVersion,
    pragma,
    isOpen: () => open,
    /** Declare a table writable. The migration runner calls this as it creates each table. */
    allowTable(name) {
      allowed.add(name)
      return this
    },
    allowedTables: () => Object.freeze([...allowed]),
    checkpointAndClose
  }
}
