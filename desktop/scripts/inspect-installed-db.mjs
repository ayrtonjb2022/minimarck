/**
 * Inspect the SQLite database the INSTALLED app is using.
 *
 * This talks to `node:sqlite`, the engine built into Node 22+, rather than shelling out to a
 * `sqlite3` binary. Two reasons that matters here: the project has no sqlite CLI dependency and
 * adding one to answer a question would be absurd, and `node:sqlite` is the same SQLite that
 * Electron's main process uses, so a schema this script can read is a schema the app can read.
 *
 * It is read-only. It opens with `readOnly: true` because the installed app is RUNNING right now
 * and the point of the inspection is to observe, not to interfere. Nothing here mutates data that
 * a shop might depend on.
 *
 * Usage: node scripts/inspect-installed-db.mjs [path]
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const arg = process.argv[2]
const dbPath = arg
  ? path.resolve(arg)
  : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'MiniMarck', 'data', 'minimarck.db')

console.log(`DATABASE: ${dbPath}`)
if (!existsSync(dbPath)) {
  console.log('  does not exist — the app has not created it yet')
  process.exit(1)
}
const st = statSync(dbPath)
console.log(`  size ${(st.size / 1024).toFixed(1)} KB   created ${st.birthtime.toISOString()}   modified ${st.mtime.toISOString()}`)

const db = new DatabaseSync(dbPath, { readOnly: true })

const userVersion = db.prepare('PRAGMA user_version').get().user_version
const appId = db.prepare('PRAGMA application_id').get().application_id
const pageCount = db.prepare('PRAGMA page_count').get().page_count
const journalMode = db.prepare('PRAGMA journal_mode').get().journal_mode
const integrity = db.prepare('PRAGMA integrity_check').get()

console.log('')
console.log(`  user_version   : ${userVersion}`)
console.log(`  application_id : 0x${Number(appId).toString(16)}`)
console.log(`  journal_mode   : ${journalMode}`)
console.log(`  page_count     : ${pageCount}`)
console.log(`  integrity_check: ${Object.values(integrity)[0]}`)

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name)

console.log('')
console.log(`  TABLES (${tables.length}): ${tables.join(', ')}`)

// The migration state is the thing that actually proves the packaged SQL ran. A database file
// existing is not evidence of anything; a database at the expected user_version with the expected
// tables IS.
//
// The expected table names are READ FROM THE MIGRATION SQL, never hardcoded here. The first
// version of this script hardcoded a list like `['ventas', 'venta_items', 'deudores', ...]` and
// then reported "MISSING deudores, pago_deudor, caja_movimientos, config" against a perfectly
// healthy database - the schema calls those tables `clientes_deudores`, `pagos_deuda` and
// `movimientos_caja`, and has no `config` table at all. A verifier that invents its own idea of
// the schema and then reports the difference is worse than no verifier, because it manufactures a
// failure that sends someone hunting for a migration bug that does not exist. The source of truth
// for "what tables should exist" is the same SQL that is supposed to have created them.
const SQL_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', 'src', 'main', 'db', 'migrations')
let expected = []
let sqlSource = 'not found'
try {
  const files = readdirSync(SQL_DIR).filter((f) => f.toLowerCase().endsWith('.sql'))
  const sql = files.map((f) => readFileSync(path.join(SQL_DIR, f), 'utf8')).join('\n')
  const names = new Set()
  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)/gi)) {
    names.add(m[1])
  }
  expected = [...names].sort()
  sqlSource = files.join(', ')
} catch {
  /* reported below as an unknown expectation, not as a schema failure */
}

console.log('')
console.log(`  EXPECTED TABLES read from ${sqlSource}: ${expected.length} found in SQL`)
if (expected.length === 0) {
  console.log('  MIGRATIONS: could not read the migration SQL, so table coverage was NOT checked')
} else {
  const missing = expected.filter((t) => !tables.includes(t))
  const extra = tables.filter((t) => !expected.includes(t) && t !== 'sqlite_sequence')
  if (missing.length === 0) {
    console.log(`  MIGRATIONS: OK — all ${expected.length} tables from the migration SQL exist`)
  } else {
    console.log(`  MIGRATIONS: MISSING ${missing.join(', ')} — the packaged SQL did not fully apply`)
  }
  if (extra.length > 0) {
    console.log(`  EXTRA tables not created by this migration: ${extra.join(', ')}`)
  }
}

if (userVersion < 1) {
  console.log(`  MIGRATIONS: FAILED — user_version is ${userVersion}, so no migration ever committed`)
} else {
  const applied = db.prepare('SELECT * FROM schema_migrations ORDER BY rowid').all()
  console.log(`  MIGRATIONS APPLIED: ${applied.map((r) => r.version ?? r.name ?? JSON.stringify(r)).join(', ')}`)
}

// Row counts, which is what turns "the schema is right" into "the shop has real data in it".
console.log('')
console.log('  ROW COUNTS:')
for (const t of tables) {
  try {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n
    if (n > 0) console.log(`    ${t.padEnd(24)} ${n}`)
  } catch {
    /* a virtual or FTS-backed table may not accept COUNT; skipping is correct, not a failure */
  }
}

// A couple of human-readable samples, so the report can show an actual sale rather than asserting
// that one might exist.
try {
  const ventas = db.prepare('SELECT COUNT(*) AS n FROM ventas').get().n
  if (ventas > 0) {
    const cols = db.prepare('SELECT * FROM ventas ORDER BY rowid DESC LIMIT 3').all()
    console.log('')
    console.log('  LAST 3 SALES:')
    for (const c of cols) console.log(`    ${JSON.stringify(c)}`)
  }
} catch {
  /* the column set is this project's business, not the inspector's */
}

try {
  const prods = db.prepare('SELECT COUNT(*) AS n FROM productos').get().n
  if (prods > 0) {
    console.log('')
    console.log('  PRODUCTS:')
    for (const p of db.prepare('SELECT * FROM productos ORDER BY rowid LIMIT 8').all()) {
      console.log(`    ${JSON.stringify(p)}`)
    }
  } else {
    console.log('')
    console.log('  PRODUCTS: none — this is the empty-catalogue state a first run starts from')
  }
} catch {
  /* products table missing is already reported above */
}

db.close()
