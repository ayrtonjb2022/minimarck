import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { IpcError } from '../bridge/errors.js'

/**
 * The versioned migration runner (design §D.6).
 *
 * `PRAGMA user_version` is the SINGLE source of truth for the schema version. There is exactly
 * one bookkeeping mechanism on purpose: a second one (a `version` table, a filename scan, a
 * marker row) is a rewrite waiting to happen, and the two inevitably disagree after an
 * interrupted run.
 *
 * Each file runs inside ONE `BEGIN IMMEDIATE` transaction that also inserts its ledger row and
 * sets `user_version`. All three move together or none do — verified, not assumed: `PRAGMA
 * user_version = N` writes the database header, which is transactional, so a migration that
 * throws leaves the version where it was. `tests/db/migrate.spec.js` asserts exactly that.
 *
 * Checksums are the guard against the failure mode this design would otherwise have: an
 * already-applied migration file edited in place. SQLite does not store DDL history, so nothing
 * else would notice, and the next launch would happily run a different schema against an
 * existing database. A changed checksum is REFUSED, and nothing is applied.
 */

/** The ledger is created and written by this module, so it is the one table it may always write. */
export const LEDGER_TABLE = 'schema_migrations'

/** `NNN_snake_name.sql` — the leading digits ARE the version, so the order is never ambiguous. */
const FILENAME_RE = /^(\d{3})_[A-Za-z0-9_-]+\.sql$/

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Read the migrations directory. Returns [] when the directory does not exist.
 *
 * An absent directory means "nothing to apply", not "everything is fine". `bootstrapDatabase`
 * warns about it, because a packaged build that failed to emit its migrations reports an empty
 * list the same way a genuinely empty project does, and the app then runs with no tables.
 */
export function readMigrations(dir) {
  if (!dir || !existsSync(dir)) return []
  const entries = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.sql')).sort()
  const out = []
  const seen = new Map()
  for (const filename of entries) {
    const m = FILENAME_RE.exec(filename)
    if (!m) {
      // A .sql file the runner cannot order is a packaging bug, not noise: ignoring it would
      // ship half a schema and report a version that lies about what ran.
      throw new IpcError('MIGRATION_BAD_FILENAME', 500, `Unorderable migration file: ${filename}`)
    }
    const version = Number(m[1])
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new IpcError('MIGRATION_BAD_FILENAME', 500, `Bad migration version in ${filename}`)
    }
    if (seen.has(version)) {
      throw new IpcError(
        'MIGRATION_DUPLICATE_VERSION', 500,
        `Two migration files claim version ${version}: ${seen.get(version)} and ${filename}`
      )
    }
    seen.set(version, filename)
    const sql = readFileSync(path.join(dir, filename), 'utf8')
    out.push({ version, name: filename.slice(4), filename, sql, checksum: sha256(sql) })
  }
  return out
}

/** Create the ledger if absent. Not transactional with anything — it predates all migrations. */
export function ensureLedger(conn) {
  conn.allowTable(LEDGER_TABLE)
  conn.db.exec(
    `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
       version    INTEGER PRIMARY KEY,
       name       TEXT NOT NULL,
       checksum   TEXT NOT NULL,
       applied_at TEXT NOT NULL
     )`
  )
  return conn
}

export function appliedMigrations(conn) {
  ensureLedger(conn)
  return conn.db
    .prepare(`SELECT version, name, checksum, applied_at FROM ${LEDGER_TABLE} ORDER BY version`)
    .all()
    .map((r) => ({ ...r }))
}

/**
 * Refuse a version sequence that starts above 1 or skips a number. A gap means a migration file
 * is missing from the package — the exact packaging bug that leaves a user's database on a
 * schema no code expects, with no error anywhere.
 */
function assertNoGaps(migrations) {
  let expected = 1
  for (const m of migrations) {
    if (m.version !== expected) {
      throw new IpcError(
        'MIGRATION_SEQUENCE_GAP', 500,
        `Migration sequence jumps from ${expected - 1} to ${m.version} (${m.filename})`
      )
    }
    expected += 1
  }
}

/**
 * Every already-applied version must still be present on disk with the SAME checksum, and the
 * ledger and `user_version` must agree. Anything else is refused before a single file runs.
 *
 * Runs BEFORE the gap check — see the ordering note in `migrate()`.
 */
function assertConsistent(conn, migrations, applied) {
  const byVersion = new Map(migrations.map((m) => [m.version, m]))
  const appliedVersions = applied.map((a) => a.version).sort((a, b) => a - b)
  const highest = appliedVersions.length ? appliedVersions[appliedVersions.length - 1] : 0
  const userVersion = conn.userVersion()

  if (userVersion !== highest) {
    throw new IpcError(
      'MIGRATION_VERSION_DIVERGENCE', 500,
      `user_version is ${userVersion} but the ledger's highest applied version is ${highest}`
    )
  }
  for (const row of applied) {
    const file = byVersion.get(row.version)
    if (!file) {
      throw new IpcError(
        'MIGRATION_MISSING_FILE', 500,
        `Migration ${row.version} (${row.name}) is applied but its file is no longer in the package`
      )
    }
    if (file.checksum !== row.checksum) {
      throw new IpcError(
        'MIGRATION_CHECKSUM_MISMATCH', 500,
        `Migration ${row.version} (${file.filename}) was already applied with a different checksum. ` +
          'An applied migration file must never be edited.'
      )
    }
  }
  // A file at or below user_version that the ledger does not know about means the two
  // bookkeeping mechanisms disagree, which is the one state this design refuses to guess at.
  for (const m of migrations) {
    if (m.version <= userVersion && !applied.some((a) => a.version === m.version)) {
      throw new IpcError(
        'MIGRATION_SEQUENCE_GAP', 500,
        `${m.filename} is version ${m.version} but the ledger has no record of it applying`
      )
    }
  }
}

/**
 * Apply every pending migration in ascending order. Idempotent by construction: a second call
 * with an unchanged directory applies nothing and returns the same `userVersion`.
 *
 * `antesDeAplicar` is the pre-migration snapshot hook, and it is OPTIONAL on purpose: a runner
 * test does not have to own a backup directory to prove a rollback, and every existing caller
 * keeps working unchanged. It is called ONCE — not once per file — and ONLY when something is
 * actually pending, because a launch that changes nothing has nothing to protect and a snapshot
 * per launch would fill the disk with copies of the same file.
 */
export function migrate(
  conn,
  { dir, now = () => new Date().toISOString(), antesDeAplicar } = {}
) {
  ensureLedger(conn)
  const migrations = readMigrations(dir)
  const applied = appliedMigrations(conn)
  // Order matters. Consistency is checked FIRST because it is the more specific diagnosis: if
  // an applied file vanished from the package, the file listing is left starting at 002, and a
  // gap check running first would misreport that as a missing `002` the developer never wrote.
  // The operator needs "your package is incomplete", not "somebody skipped a number".
  assertConsistent(conn, migrations, applied)
  assertNoGaps(migrations)

  const appliedVersions = new Set(applied.map((a) => a.version))
  const pending = migrations.filter((m) => !appliedVersions.has(m.version))
  const done = []

  // The allowlist is widened for EVERY table the migration set DECLARES, not only for the tables
  // this run happened to create.
  //
  // This was `pending`-scoped and it was a real, shipping bug: the authorizer opens deny-all, so a
  // second launch against an already-migrated database had an EMPTY allowlist and every write came
  // back `SQLITE_AUTH: not authorized`. The app could open a till and take a sale on first run and
  // could do nothing at all on every run after it.
  //
  // It is invisible in development, which is exactly why it survived: the payment drive always
  // starts from a throwaway database, so migration 001 is always pending and the allowlist is
  // always populated. It only appeared in the INSTALLED end-to-end run, where the database was
  // already at version 1 from the first launch. `scripts/repro-authz-second-launch.mjs` reproduces it
  // in two bootstraps of the same file, and `tests/db/migrate.spec.js` pins the second launch.
  //
  // Declaring the full set is also the more honest reading of the rule. The allowlist exists so a
  // write cannot reach a table the SCHEMA does not have, not so a write cannot reach a table this
  // particular process did not build. Widening it per-run conflated those two and produced a
  // database that could be read but not written.
  for (const m of migrations) {
    for (const table of tablesCreatedBy(m.sql)) conn.allowTable(table)
  }

  // The parachute, and the ONLY place it is fired. After `assertConsistent`/`assertNoGaps` — a run
  // that refuses changes nothing, so it must not leave a snapshot behind — and before the first
  // `BEGIN IMMEDIATE`, so what gets archived is the pre-migration state and not a half-applied one.
  if (pending.length > 0 && typeof antesDeAplicar === 'function') {
    antesDeAplicar({ versiones: pending.map((m) => m.version) })
  }

  for (const m of pending) {
    conn.tx(() => {
      conn.db.exec(m.sql)
      conn.db
        .prepare(
          `INSERT INTO ${LEDGER_TABLE} (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`
        )
        .run(m.version, m.name, m.checksum, now())
      // Same transaction as the DDL, so version and schema cannot diverge.
      conn.db.exec(`PRAGMA user_version = ${m.version}`)
    })
    done.push(m.version)
  }

  return { applied: done, userVersion: conn.userVersion(), available: migrations.length }
}

/** Table names a migration file creates, so the runner can widen the allowlist for them. */
export function tablesCreatedBy(sql) {
  const out = []
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?(\w.]+)?["'`\]]?\s*\(?/gi
  let m
  while ((m = re.exec(sql)) !== null) {
    const rest = sql.slice(m.index + m[0].length)
    const name = /^["'`[]?([A-Za-z_][A-Za-z0-9_]*)/.exec(rest)
    if (name) out.push(name[1])
  }
  // A schema-qualified or quoted name lands in group 1 above; the unquoted case is the common one.
  return out
}
