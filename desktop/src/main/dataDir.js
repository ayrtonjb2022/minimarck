import path from 'node:path'

/**
 * Where the database, its WAL sidecars and its backups live (PLAT-2).
 *
 * PURE function: it computes paths and NEVER mutates Electron's own profile path. The
 * `MINIMARCK_DATA_DIR` override changes only the BASE under which the `data/` subdirectory
 * is created; `app.getPath('userData')` (the Electron profile that stores the app's own
 * preferences) is left untouched. That separation is the point of the override: it lets a
 * test or a hand-recovery point the DATA somewhere else without relocating the profile.
 *
 * S0 lands the policy and its test. S1's `db/paths.js` consumes this to open the real file;
 * S0 itself opens no database (the S0 spike uses a throwaway temp file only).
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
