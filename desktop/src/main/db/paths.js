import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { resolveDataPaths, ensureDataDirs } from '../dataDir.js'

/**
 * Where the SQLite file lives, resolved ONCE per process (PLAT-2).
 *
 * The path arithmetic itself is NOT duplicated here: `dataDir.js` (S0) already owns
 * `resolveDataPaths`, and this module only decides *how many times* it is called and adds the
 * migrations directory. S0 left `resolveDataPaths` a pure function so the `MINIMARCK_DATA_DIR`
 * override could be tested without touching the Electron profile; that property is preserved.
 *
 * NEVER `process.cwd()`. An app launched from a shortcut, from Explorer, or by a `.bat` has an
 * arbitrary working directory, so a `path.join(process.cwd(), 'data')` writes the user's
 * database to wherever the shortcut happened to point — and two launches from two directories
 * produce two different, silently divergent databases. The base is always
 * `app.getPath('userData')` (or an explicit `MINIMARCK_DATA_DIR`), never the cwd.
 *
 * `fileURLToPath`, never `new URL(...).pathname`: on Windows the latter yields `/C:/Users/...`,
 * which is not a real path and produces a `ENOENT: 'C:\C:\...'`-class failure. This is the same
 * trap `scripts/verify-offline.mjs` and `vitest.config.js` already hit and fixed.
 */

/** Directory name the migration runner reads, relative to the migrations root. */
export const MIGRATIONS_DIRNAME = 'migrations'

/**
 * Default migrations root, resolved from this module's own location.
 *
 * Injectable on purpose. electron-vite BUNDLES main into `out/main/index.js`, so after a build
 * `import.meta.url` points into the bundle and this resolves to `out/main/migrations/`.
 *
 * That directory is populated by the `emitMigrations()` plugin in `electron.vite.config.js`, not
 * by hand and not by `extraResources`: this function resolves relative to the BUNDLE, so the SQL
 * has to sit inside the bundle's own output directory. `verify:migrations` asserts the emitted
 * tree matches `src/main/db/migrations/`, because the failure mode of getting it wrong is a
 * working app running against an empty database.
 */
export function defaultMigrationsDir() {
  return fileURLToPath(new URL(`./${MIGRATIONS_DIRNAME}/`, import.meta.url))
}

/**
 * Build a resolver that computes the paths once and then returns the same object.
 *
 * Memoising is the point: `db.schemaVersion`, the WAL checkpoint and the backup catalog must all
 * agree on one file for the life of the process, and re-deriving them per call would let a
 * changed `MINIMARCK_DATA_DIR` mid-run split the database in two.
 */
export function createPathResolver({ userDataPath, env = {}, migrationsDir } = {}) {
  if (!userDataPath) {
    throw new Error('createPathResolver: userDataPath is required (app.getPath("userData"))')
  }
  let cached = null
  return function resolveOnce() {
    if (cached) return cached
    const paths = ensureDataDirs(resolveDataPaths(userDataPath, env))
    const resolvedMigrationsDir = migrationsDir || defaultMigrationsDir()
    // The stat happens BEFORE the freeze, never after. The previous draft froze first and then
    // assigned `migrationsExist` on the frozen object, which throws in ESM (always strict) — so
    // `createPathResolver` raised a TypeError on its first call, `bootstrapDatabase` died on its
    // first statement, and the app could not start at all. A frozen object is exactly the thing
    // you must finish writing before you freeze it.
    cached = Object.freeze({
      ...paths,
      migrationsDir: resolvedMigrationsDir,
      migrationsExist: existsSync(resolvedMigrationsDir)
    })
    return cached
  }
}

/**
 * Reject any path that is not absolute. A relative data path is always a bug, and this is the
 * cheapest possible guard against reintroducing a cwd-relative path later.
 */
export function assertAbsolute(label, value) {
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path, got: ${value}`)
  }
  return value
}
