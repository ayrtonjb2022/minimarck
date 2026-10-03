/**
 * `npm run db:reset` — delete the development database and its SQLite sidecars.
 *
 * The guard lives in `src/main/db/reset.js` so it can be unit tested; this file is only the CLI
 * shell around it. The important behaviour is the REFUSAL, not the deletion.
 *
 * A stale database is the normal consequence of editing a migration that has already been applied
 * anywhere: the checksum guard in `migrate.js` refuses to run, which is correct, and the fix is to
 * throw the file away. Before this script, that fix was a manual judgement call every time the
 * schema changed. It is a command now, and the command refuses when the app has shipped.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const force = process.argv.includes('--force')

const { resolveDataPaths } = await import(
  pathToFileURL(path.join(root, 'src', 'main', 'dataDir.js')).href
)
const { planReset, performReset, shippedSignals } = await import(
  pathToFileURL(path.join(root, 'src', 'main', 'db', 'reset.js')).href
)

// Git tags are the one signal that cannot be read from package.json. Failure is non-fatal and
// treated as "no tags": a missing git binary must not block deleting a throwaway dev database,
// and if tags really exist the version check still holds the guard.
let tags = []
try {
  const out = execFileSync('git', ['tag', '--list'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  tags = out.split('\n').map((t) => t.trim()).filter(Boolean)
} catch {
  tags = []
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const signals = shippedSignals(pkg, tags)

// The REAL profile path, not a temp dir. This is the whole point of the script: it must clear the
// database the app actually opens, or it deletes nothing that was blocking the launch. Electron is
// not started to ask it, because the answer is already known and is already implemented —
// `resolveDataPaths` is what `bootstrapDatabase` itself calls, so the two cannot disagree.
const paths = resolveDataPaths(process.env.APPDATA ? path.join(process.env.APPDATA, 'MiniMarck') : '', process.env)

console.log('db:reset — MiniMarck development database')
console.log(`  app version : ${signals.version}${signals.private ? ' (private, unpublished)' : ''}`)
console.log(`  database    : ${paths.dbFile}`)
console.log(`  override    : ${paths.overridden ? paths.base : 'none'}`)
console.log('')

const plan = planReset({ paths, signals, force })
if (!plan.allowed) {
  console.error(plan.message)
  console.error('')
  process.exit(1)
}

if (plan.shipped) {
  console.warn(`WARNING: --force was passed and this app HAS shipped (${plan.reasons.join('; ')}).`)
  console.warn('Deleting anyway. If this database held real sales, they are gone.')
  console.log('')
}

const result = performReset(paths, { force })

if (!result.ok) {
  console.error('')
  console.error('db:reset FAILED — the database is still there or partially removed.')
  console.error('The most likely cause is the app running and holding the file open. Close it and retry.')
  process.exit(1)
}

console.log('')
console.log(
  `db:reset OK — deleted ${result.deleted.length} file(s), ${result.absent.length} already absent.`
)
console.log('The next launch will migrate from scratch and seed a fresh business.')
