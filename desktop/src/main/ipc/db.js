import { existsSync, statSync } from 'node:fs'
import { resolveDataPaths } from '../dataDir.js'

/**
 * S0 read-only `db.*` handlers — the CONTRACT ONLY; the data layer is S1+.
 *
 * These deliberately open NO database (that is S1's job, and S0 has no migrations yet).
 * They report the resolved data paths and whether a file is present, so the Settings
 * > Diagnóstico panel and the S0 probe have something honest to show. `schemaVersion`
 * reports 0 / "not migrated" because no migration has run — it does not fake a version.
 */
export function registerDbHandlers(registry, { userDataPath, env }) {
  const paths = resolveDataPaths(userDataPath, env)
  registry.register('db', {
    info: () => {
      let sizeBytes = null
      if (existsSync(paths.dbFile)) sizeBytes = statSync(paths.dbFile).size
      return {
        dbFile: paths.dbFile,
        dataDir: paths.dataDir,
        backupDir: paths.backupDir,
        overridden: paths.overridden,
        exists: existsSync(paths.dbFile),
        sizeBytes,
        journalMode: null, // unknown until S1 opens the file and reads the pragma
        electron: process.versions.electron,
        node: process.versions.node,
        sqlite: process.versions.sqlite
      }
    },
    schemaVersion: () => ({
      userVersion: 0,
      migrated: false,
      note: 'S0 ships no migrations; the schema arrives in S1/S2.'
    }),
    reconcile: () => ({
      status: 'not_migrated',
      findings: [],
      note: 'db.reconcile is implemented in S17; nothing to reconcile before S1.'
    })
  })
  return paths
}
