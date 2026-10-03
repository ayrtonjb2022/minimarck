import { mkdirSync } from 'node:fs'
import os from 'node:os'
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
 * THE SAME `userData` PATH, DERIVED WITHOUT ELECTRON.
 *
 * WHY IT EXISTS. The offline recovery tool (`scripts/auth-reset-admin.mjs`) needs to open the shop's
 * database from a plain Node process, and `app.getPath('userData')` is only available inside Electron.
 * The first version of that tool ran under Electron to ask, and that turned out to cost more than it
 * bought — on Windows, `electron.exe` is a GUI-subsystem binary whose main process receives an EMPTY
 * stdin even when the parent redirects a real file into it (measured: 18 bytes through Node, 0 bytes
 * through Electron, same file, same handle). A tool that cannot read a password from a pipe cannot be
 * scripted, and it inherits Chromium's profile-cache permissions errors for no benefit.
 *
 * So the path is derived. And DERIVING IT IS DANGEROUS, because that is exactly what
 * `app.setName(APP_NAME)` exists to prevent — unpackaged, Electron derives it from the package name
 * and the app once resolved every shop to the SHARED `…\AppData\Roaming\Electron\` profile. That is
 * recorded at the top of this file and it is the reason this function is written the way it is:
 *
 *   - it is PURE, taking the environment, the platform and the home directory as arguments, so the
 *     rule can be asserted without touching the machine;
 *   - it returns the SAME directory Electron would, by the same rule Chromium uses — `APPDATA` on
 *     Windows, `Library/Application Support` on macOS, `.config` on Linux, all joined with `APP_NAME`;
 *   - and it NEVER decides anything on its own. The caller must confirm the database exists inside
 *     the result before opening it, and a caller that cannot find one prints every candidate it
 *     tried. A wrong guess is loud and harmless; a wrong guess that silently opens a file is the only
 *     unacceptable outcome, and it takes a caller that ignores the check to produce it.
 *
 * `env` DEFAULTS TO `process.env`, and that default is load-bearing rather than convenient. It was
 * `{}`, and the bug it caused was the worst kind: a caller with no arguments — which is how the
 * recovery tool calls it — got an empty environment, `APPDATA` came back undefined, and the function
 * fell through to the homedir guess. On an ordinary Windows machine that guess HAPPENS to be the same
 * directory, so the tool worked on the machine that tested it and pointed at the wrong place for
 * anyone whose APPDATA is relocated. A default that is right most of the time is exactly the default
 * that a test on one machine cannot catch.
 *
 * @param {{env?: Record<string,string|undefined>, platform?: string, homedir?: string}} opciones
 * @returns {string} the `userData` directory Electron would report after `app.setName(APP_NAME)`
 */
export function resolveUserDataSinElectron({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir()
} = {}) {
  // `MINIMARCK_DATA_DIR` is deliberately NOT consulted here. It relocates the DATA, not the
  // profile, and a recovery tool pointed at a relocated shop has to be told so explicitly with the
  // same variable the app uses — silently preferring it would make the tool edit a different
  // database than the app it is recovering.
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(homedir, 'AppData', 'Roaming')
    return path.join(appData, APP_NAME)
  }
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', APP_NAME)
  }
  return path.join(homedir, '.config', APP_NAME)
}

/**
 * Create the data and backup directories (PLAT-2).
 *
 * Kept separate from resolveDataPaths so that stays a PURE function of its inputs. This is the
 * step that was missing: `resolveDataPaths` computed
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
