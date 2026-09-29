import { createPathResolver } from './paths.js'
import { openDatabase } from './connection.js'
import { migrate } from './migrate.js'
import { seed } from './seed.js'

/**
 * Startup, in the order the design requires: resolve paths once -> open -> migrate -> seed.
 *
 * The order is the design, not a convenience. Migrating before the seed means the seed runs
 * against the schema its own INSERT statements were written for, so S2 changing a column is a
 * startup error with a stack trace instead of a silently missing column at runtime. Seeding
 * before migrating would be the reverse: the tables would not exist yet.
  *
  * `tables` is EMPTY here, and that is deliberate rather than unfinished. The allowlist starts
  * deny-all on writes; each applied migration allowlists the tables its own SQL created, via
  * `tablesCreatedBy` over the migration text. The caller cannot widen it by passing a list, which
  * is why a malicious or buggy `tables` argument cannot grant a write on a table the schema
  * never declared. The census is 20 business tables plus the `schema_migrations` ledger.
  */
export function bootstrapDatabase({
  userDataPath,
  env = {},
  migrationsDir,
  tables = [],
  now
} = {}) {
  const resolveOnce = createPathResolver({ userDataPath, env, migrationsDir })
  const paths = resolveOnce()
  assertResolvable(paths)

  const conn = openDatabase(paths.dbFile, { walFile: paths.walFile, tables })
  let migration
  let seeded
  try {
    migration = migrate(conn, { dir: paths.migrationsDir, now })
    seeded = seed(conn, { now })
  } catch (err) {
    // A failed migration must not leave an open connection behind: main would then run
    // before-quit against a half-migrated database and checkpoint it into a good state.
    try {
      conn.checkpointAndClose()
    } catch {
      /* the original migration error is what the caller needs to see */
    }
    throw err
  }

  return { paths, conn, migration, seeded, resolveOnce }
}

function assertResolvable(paths) {
  if (!paths.migrationsExist) {
    // S2 ships `001_init.sql`, so a missing directory is no longer a legitimate transitional
    // state — it means the build did not package the migrations and the app is about to run
    // with an empty database. `verify:migrations` catches that in CI; this is the runtime echo
    // for anyone whose build was assembled by hand. It stays non-fatal so that a genuinely
    // empty database remains inspectable instead of blocking startup, but it is a warning now,
    // not an informational log.
    console.warn(
      '[db] no migrations directory; schema stays at version 0 and the app has NO TABLES. ' +
        'If this is a packaged build, the migrations were not emitted — run `npm run verify:migrations`.'
    )
  }
  if (!paths.backupDir) throw new Error('resolveDataPaths did not produce a backupDir')
}
