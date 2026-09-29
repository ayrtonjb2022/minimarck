import { existsSync, statSync } from 'node:fs'

/**
 * The `db.*` handlers, now backed by a REAL open connection.
 *
 * S0 registered these as honest placeholders that opened no database: it had no migration
 * runner and no schema, so `schemaVersion` reported 0 and `db.info` reported
 * `journalMode: null`. S1 owns the data layer, so both of those are now read from SQLite.
 *
 * What deliberately did NOT change: `db.reconcile` is NOT implemented here. It is a frozen
 * contract member owned by S17, and now that a real database is open, S0's synthetic
 * `{ status: 'not_migrated' }` would be worse than useless — the Settings > Diagnóstico panel
 * would report "nothing to reconcile" about a database that may well need reconciling. It is
 * left unregistered so the registry's own gate answers `NOT_IMPLEMENTED` 501, which is the
 * truthful answer and the same envelope every other future-slice op already gets.
 */
export function registerDbHandlers(registry, { paths, conn, migration, seeded }) {
  registry.register('db', {
    info: () => {
      let sizeBytes = null
      if (existsSync(paths.dbFile)) sizeBytes = statSync(paths.dbFile).size
      return {
        dbFile: paths.dbFile,
        dataDir: paths.dataDir,
        backupDir: paths.backupDir,
        overridden: paths.overridden,
        exists: true,
        sizeBytes,
        // Real now, read from the open connection rather than hardcoded.
        journalMode: conn.pragma('journal_mode').journal_mode,
        schemaVersion: conn.userVersion(),
        writableTables: conn.allowedTables().length,
        electron: process.versions.electron,
        node: process.versions.node,
        sqlite: process.versions.sqlite
      }
    },

    /**
     * The REAL schema version, from `PRAGMA user_version` — the single source of truth the
     * migration runner moves atomically with each DDL change.
     *
     * `migrated` is `userVersion > 0`, not "a migrations directory exists". A database whose
     * version is 0 genuinely has no schema, and reporting otherwise is the sort of optimistic
     * read that turns into a confusing runtime error three slices later.
     */
    schemaVersion: () => {
      const userVersion = conn.userVersion()
      return {
        userVersion,
        migrated: userVersion > 0,
        available: migration?.available ?? 0,
        pending: Math.max(0, (migration?.available ?? 0) - userVersion),
        lastRun: { applied: migration?.applied ?? [], userVersion: migration?.userVersion ?? userVersion }
      }
    }

    // `db.reconcile` is intentionally ABSENT — see the file header. It resolves (it is a
    // frozen contract member) and then 501s through registry.resolve(), which is the honest
    // answer until S17 implements it.
  })

  if (seeded?.seeded) {
    console.log(`[db] seeded negocio=${seeded.negocioId} user=${seeded.userId}`)
  }
  return paths
}
