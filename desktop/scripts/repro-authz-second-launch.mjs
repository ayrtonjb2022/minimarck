/**
 * Is the write allowlist rebuilt on EVERY startup, or only when a migration actually runs?
 *
 * The authorizer opens deny-all, and `migrate()` widens it for the tables each migration creates. If
 * that widening only happens for migrations that are PENDING, then a second launch against an
 * already-migrated database has an EMPTY allowlist and every write fails with `SQLITE_AUTH`
 * "not authorized" — which would mean the app works on first run and cannot open a till on any run
 * after it. That is precisely the failure the INSTALLED end-to-end run hit.
 *
 * Two bootstraps of the same database file, then the same write through each.
 *
 * `auditoria` is the probe table on purpose: `tabla` and `accion` are the only NOT NULL columns,
 * both are free of foreign keys, and no CHECK ties them together, so a rejection can only mean the
 * authorizer said no. An earlier version of this file probed `movimientos_caja` with a partial
 * INSERT and reported "denied writes" on the FIRST launch — which was a NOT NULL constraint, not
 * authorization, and would have sent the investigation after the wrong bug entirely.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const migrationsDir = path.resolve(here, '..', 'src', 'main', 'db', 'migrations')
const isAuthorizationDenial = (message) => /not authorized/i.test(message ?? '')

const dir = mkdtempSync(path.join(tmpdir(), 'authz-repro-'))
// `pathToFileURL`, not a bare absolute path: on Windows an absolute path has a `c:` scheme, which the
// ESM loader rejects with ERR_UNSUPPORTED_ESM_URL_SCHEME. Same reason `db-reset.mjs` does this.
const { bootstrapDatabase } = await import(
  pathToFileURL(path.resolve(here, '..', 'src', 'main', 'db', 'bootstrap.js')).href
)

// -- first launch: migration 001 is PENDING, so the allowlist should be widened --------------
const first = bootstrapDatabase({ userDataPath: dir, migrationsDir })
console.log(`FIRST  bootstrap: applied=[${first.migration.applied}] user_version=${first.migration.userVersion}`)
const firstWrite = tryWrite(first)
console.log(`  write allowed? ${describe(firstWrite)}`)
first.conn.checkpointAndClose()

// -- second launch: nothing is pending, so does the allowlist survive? ----------------------
const second = bootstrapDatabase({ userDataPath: dir, migrationsDir })
console.log(`SECOND bootstrap: applied=[${second.migration.applied}] user_version=${second.migration.userVersion}`)
const secondWrite = tryWrite(second)
console.log(`  write allowed? ${describe(secondWrite)}`)
try {
  second.conn.checkpointAndClose()
} catch {
  /* housekeeping */
}
rmSync(dir, { recursive: true, force: true })

console.log('')
if (!firstWrite.ok) {
  console.log(`INCONCLUSIVE: the first launch denied the write too (${firstWrite.error}).`)
  console.log('             Fix that first — a repro that fails on launch 1 proves nothing about launch 2.')
  process.exit(2)
}
if (secondWrite.ok) {
  console.log('NOT REPRODUCED: writes are allowed on both launches.')
  process.exit(0)
}
if (!isAuthorizationDenial(secondWrite.error)) {
  console.log(`INCONCLUSIVE: the second launch failed for a non-authorization reason (${secondWrite.error}).`)
  process.exit(2)
}

console.log('CONFIRMED: the allowlist is rebuilt only when a migration RUNS.')
console.log('           A second launch against an up-to-date database has an empty allowlist, so')
console.log('           every write fails with SQLITE_AUTH "not authorized".')
console.log('           Dev never sees it because the payment drive always starts from a throwaway')
console.log('           database, where migration 001 is always pending.')
process.exit(1)

function tryWrite(boot) {
  try {
    boot.conn.tx(() =>
      boot.conn.db
        .prepare(`INSERT INTO auditoria (tabla, accion) VALUES ('productos', 'CREATE')`)
        .run()
    )
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

function describe(result) {
  if (result.ok) return 'YES'
  const kind = isAuthorizationDenial(result.error) ? 'authorization denied' : 'schema error'
  return `NO — ${result.error} (${kind})`
}
