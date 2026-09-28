import { mkdirSync } from 'node:fs'
import path from 'node:path'

/**
 * The Electron profile name, and therefore the `userData` directory the data lives in.
 *
 * Unpackaged, Electron derives that path from the package name, so the app was resolving
 * to the SHARED `…\AppData\Roaming\Electron\` profile that every other Electron app on the
 * machine also uses. `app.setName(APP_NAME)` in main fixes it. Exported as a constant so
 * the assertion is testable and a rename cannot silently relocate a user's database.
 */
export const APP_NAME = 'MiniMarck'

/**
 * Where the database, its WAL sidecars and its backups live (PLAT-2).
 *
 * PURE function: it computes paths and NEVER mutates Electron's own profile path. The
 * `MINIMARCK_DATA_DIR` override changes only the BASE under which the `data/` subdirectory
 * is created; `app.getPath('userData')` (the Electron profile that stores the app's own
 * preferences) is left untouched. That separation is the point of the override: it lets a
 * test or a hand-recovery point the DATA somewhere else without relocating the profile.
 *
 * S0 lands the policy, creates the directories, and proves them writable. S1's
 * `db/paths.js` consumes this to open the real file; S0 itself opens no database (the S0
 * spike uses a throwaway temp file only).
 */
export function resolveDataPaths(userDataPath, env = {}) {
  const base = env.MINIMARCK_DATA_DIR || userDataPath
  const dataDir = path.join(base, 'data')
  return {
    dataDir,
    dbFile: path.join(dataDir, 'minimarck.db'),
    walFile: path.join(dataDir, 'minimarck.db-wal'),
    shmFile: path.join(dataDir, 'minimarck.db-shm'),
    backupDir: path.join(base, 'backups'),
    // Which base actually won, so Settings > Diagnóstico can show the resolved location.
    base,
    overridden: Boolean(env.MINIMARCK_DATA_DIR)
  }
}

/**
 * Create the data and backup directories (PLAT-2).
 *
 * Kept separate from resolveDataPaths so that stays a PURE function of its inputs. This is
 * the step that was missing: `resolveDataPaths` computed
 * `…\AppData\Roaming\Electron\data\minimarck.db` and nothing ever made that directory, so
 * `shell.openPath(dataDir)` on the "Abrir carpeta de datos" menu item had nothing to open
 * and S1's first `new DatabaseSync()` would have thrown ENOENT. It is also the reason
 * PLAT-2 is no longer policy-only: this is testable, and the test writes a real file.
 */
export function ensureDataDirs(paths) {
  mkdirSync(paths.dataDir, { recursive: true })
  mkdirSync(paths.backupDir, { recursive: true })
  return paths
}
