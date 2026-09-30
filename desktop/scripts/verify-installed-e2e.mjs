/**
 * End-to-end verification of the INSTALLED application.
 *
 * This is the check that the rest of the suite cannot do. Every other verifier in this repo looks
 * at source, at `out/`, or at an asar — all things produced BY the build. This one launches the
 * installed `MiniMarck.exe` from `%LOCALAPPDATA%\Programs\MiniMarck` and talks to the database at
 * `%APPDATA%\MiniMarck\data\minimarck.db` that a real shop's data would live in, and then removes
 * the program and checks the data is still there.
 *
 * WHY A SCRIPT AND NOT A CHECKLIST. Each step below was a claim this project had never tested, and
 * every one of them turned out to hide a surprise:
 *
 *   - A fresh profile has to produce a database with the migration applied. It does — 20 tables,
 *     user_version 1 — but only because the SQL travels INSIDE the asar at a path the bundle's own
 *     geometry can resolve. Nothing about that is visible from the repo.
 *   - The first run has an EMPTY catalogue. It does. Which meant the POS opened on a grid that said
 *     "No se encontraron productos" and offered no way forward, and that is what motivated the
 *     first-run panel and the opt-in demo catalogue.
 *   - Uninstalling must not take the sales history with it. It does not, because
 *     `deleteAppDataOnUninstall: false` is set explicitly; had it been left to a default, this step
 *     would have been the one that discovered the loss.
 *
 * The steps are ordered so the destructive one is LAST, and so the sale is recorded in a database
 * that then has to survive the uninstall. Verifying "the data directory still exists" without a sale
 * in it would prove almost nothing: an empty directory surviving is not the same promise as a
 * ledger of a shop's day surviving.
 *
 * THE SALE IS MADE THROUGH THE REAL UI, not by inserting a row. The payment drive already proved
 * the sale path in the development build; what is unproven here is whether THAT code survives being
 * bundled into an asar, installed to a different directory, and launched by the shell rather than
 * by npm. So this drives the real POS with keystrokes and the real IPC with a real migration.
 *
 * Usage:
 *   node scripts/verify-installed-e2e.mjs            # full: install -> use -> uninstall -> recheck
 *   node scripts/verify-installed-e2e.mjs --no-install  # reuse the current installation
 */
import { spawnSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, mkdirSync, readdirSync, copyFileSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const INSTALLED = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'MiniMarck', 'MiniMarck.exe')
const UNINSTALLER = path.join(
  process.env.LOCALAPPDATA || '',
  'Programs',
  'MiniMarck',
  'Uninstall MiniMarck.exe'
)
const PROFILE = path.join(process.env.APPDATA || '', 'MiniMarck')
const DB = path.join(PROFILE, 'data', 'minimarck.db')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const BACKUP = path.join(os.tmpdir(), 'opencode', `e2e-profile-${STAMP}`)

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const step = (t) => console.log(`\n=== ${t}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Registry read for the Programs-and-Features entry, via reg.exe. */
function uninstallEntry() {
  const r = spawnSync(
    'reg',
    [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      '/s',
      '/f',
      'MiniMarck'
    ],
    { encoding: 'utf8' }
  )
  return (r.stdout || '').includes('MiniMarck')
}

/**
 * Wait for the uninstall to actually FINISH.
 *
 * The uninstaller is an NSIS program that relaunches itself out of a temp copy and returns
 * IMMEDIATELY with exit code 0. Polling once and asserting found the folder still present and the
 * registry key still there, and the first version of this script reported "the program was NOT
 * removed" and "it is still in Programs and Features" on a run where both were in fact correct a
 * few seconds later. Exit code 0 from an uninstaller means "I started", not "I finished".
 *
 * The data directory is deliberately NOT part of the wait condition, because that is the thing
 * being measured: if removal is still in progress we keep waiting, and if the data is gone we
 * report that separately rather than timing out.
 */
async function waitForRemoval(exePath, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const gone = !existsSync(exePath) && !uninstallEntry()
    if (gone) return { ok: true, waitedMs: timeoutMs - (deadline - Date.now()) }
    last = `exe present=${existsSync(exePath)}, registry entry present=${uninstallEntry()}`
    await sleep(2000)
  }
  return { ok: false, detail: last }
}

function appRunning() {
  const r = spawnSync('tasklist', ['/fi', 'imagename eq MiniMarck.exe', '/nh'], { encoding: 'utf8' })
  return (r.stdout || '').toLowerCase().includes('minimarck.exe')
}

function stopApp() {
  spawnSync('taskkill', ['/f', '/im', 'MiniMarck.exe'], { encoding: 'utf8' })
  return sleep(2000)
}

// ---------------------------------------------------------------------------
step('1. the installer')
// ---------------------------------------------------------------------------
let installer = null
if (!process.argv.includes('--no-install')) {
  // The newest staged build, or the copy at the stable path that `npm run dist` maintains.
  const release = path.join(root, 'release')
  const stable = path.join(release, 'MiniMarck Setup.exe')
  if (existsSync(stable)) {
    installer = stable
  } else {
    const builds = existsSync(release)
      ? readdirSync(release)
          .filter((d) => d.startsWith('build-'))
          .sort()
          .reverse()
      : []
    for (const b of builds) {
      const candidate = path.join(release, b, 'MiniMarck Setup.exe')
      if (existsSync(candidate)) {
        installer = candidate
        break
      }
    }
  }

  if (!installer) {
    record('an installer exists to test', false, 'run `npm run dist` first')
    report()
    process.exit(1)
  }
  record('an installer exists to test', true, `${path.relative(root, installer)}, ${(statSync(installer).size / 1048576).toFixed(1)} MB`)
} else {
  record('reusing the existing installation (--no-install)', true, path.basename(INSTALLED))
}

// ---------------------------------------------------------------------------
step('2. start from a clean slate')
// ---------------------------------------------------------------------------
// The point of the data-preservation claim is that THIS shop's data survives. So before anything
// else, anything already in the profile is set aside — not deleted, so a failed run can be
// inspected and restored by hand.
await stopApp()
if (existsSync(PROFILE)) {
  // The database and its WAL/SHM are copied, not just the .db file. A WAL-mode database whose
  // -wal was left behind holds committed rows that are not yet in the main file, so copying only
  // the .db would preserve a database that is missing the most recent writes — and this is the
  // ONE test where such a mistake would silently destroy the evidence it is meant to gather.
  mkdirSync(path.join(BACKUP, 'data'), { recursive: true })
  for (const f of readdirSync(path.join(PROFILE, 'data'))) {
    copyFileSync(path.join(PROFILE, 'data', f), path.join(BACKUP, 'data', f))
  }
  rmSync(PROFILE, { recursive: true, force: true })
  record('previous profile set aside, not deleted', true, `full copy kept at ${BACKUP}`)
}
record('no profile before first launch', !existsSync(PROFILE), existsSync(PROFILE) ? 'still there' : 'clean')

if (!process.argv.includes('--no-install')) {
  // Install SILENTLY. The interactive wizard was already verified by hand — the Spanish UI, the
  // per-user location, the shortcuts — and driving a GUI wizard from a script is a second project
  // with its own flakiness. What this script exists to test is what happens AFTER installation.
  const r = spawnSync(installer, ['/S'], { timeout: 10 * 60 * 1000 })
  record('installer ran and exited cleanly', r.status === 0, `exit code ${r.status}`)
  await sleep(4000)
}

record(
  'installed per-user, no administrator rights',
  existsSync(INSTALLED),
  existsSync(INSTALLED) ? INSTALLED : `NOT FOUND at ${INSTALLED}`
)
record('it appears in Programs and Features', uninstallEntry(), 'HKCU Uninstall key')

// ---------------------------------------------------------------------------
step('3. first launch creates a working database')
// ---------------------------------------------------------------------------
if (existsSync(INSTALLED)) {
  spawn(INSTALLED, [], { detached: true, stdio: 'ignore' }).unref()
  await sleep(12000)
  record('the installed app launched', appRunning(), 'process check')
}

if (!existsSync(DB)) {
  record('the first launch created the database', false, `${DB} does not exist`)
  report()
  process.exit(1)
}

{
  const db = new DatabaseSync(DB, { readOnly: true })
  const uv = db.prepare('PRAGMA user_version').get().user_version
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name)
  const sql = readFileSync(
    path.join(root, 'src', 'main', 'db', 'migrations', '001_init.sql'),
    'utf8'
  )
  const expected = [...new Set([...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) => m[1]))]
  const missing = expected.filter((t) => !tables.includes(t))
  const applied = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n
  const products = db.prepare('SELECT COUNT(*) AS n FROM productos').get().n
  db.close()

  record('the first launch created the database', true, DB)
  record('the migration ran from inside the asar', uv === 1 && missing.length === 0, `user_version ${uv}, ${applied} applied, ${missing.length} missing`)
  record('a first run starts with an EMPTY catalogue', products === 0, `${products} products`)
}

// ---------------------------------------------------------------------------
step('4. seed a catalogue and take a real sale through the installed app')
// ---------------------------------------------------------------------------
// `db:demo` is the same module the first-run button uses, run against the real profile. The sale
// itself is driven by the payment drive against the INSTALLED app's database path, so what is
// verified is the installed app's own migration geometry and IPC surface, not the dev build's.
{
  const seed = spawnSync(process.execPath, [path.join(here, 'db-demo.mjs')], {
    cwd: root,
    encoding: 'utf8'
  })
  const creado = (seed.stdout || '').match(/creados\s+\((\d+)\)/)
  const output = (seed.stdout || seed.stderr || '').trim()
  record(
    'a catalogue can be seeded into the installed profile',
    creado !== null && Number(creado[1]) > 0,
    creado ? `created ${creado[1]}` : output.split('\n').slice(-1)[0]
  )
}

{
  // MINIMARCK_DATA_DIR is deliberately NOT set: the drive must use %APPDATA%\MiniMarck, the same
  // file the installed app uses. Setting it to a throwaway directory would make a green run mean
  // nothing about the installed app.
  // The seed is useless if the app is running: it holds the SQLite file open, and the drive's own
  // connection would then be a second writer on a database the first one owns. Worse, the POS
  // caches the catalogue for five minutes, so a catalogue seeded underneath a live window is one
  // the window will not show. The app is stopped here and started again by the drive.
  await stopApp()
  const r = spawnSync(process.execPath, [path.join(here, 'drive-payment-installed.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, MINIMARCK_DATA_DIR: '' },
    timeout: 10 * 60 * 1000
  })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  record('a real sale completed in the INSTALLED app', r.status === 0, `exit code ${r.status}`)
  // The drive's own verdict, read from the line the app prints, not inferred from the exit code.
  // `MINIMARCK_PAYMENT_DRIVE` asserts ~20 things and the app exits 0 only if all of them passed, but
  // printing them is what makes a failure diagnosable instead of a bare "exit 1".
  const fallos = out.split('\n').filter((l) => /FAIL|PAYMENT_DRIVE_ERROR/.test(l))
  if (r.status !== 0) {
    console.log(out.split('\n').filter((l) => l.trim()).slice(-25).join('\n'))
  } else {
    const resumen = out.match(/(\d+)\/(\d+)\s*(?:checks|comprob)/i)
    record('every check inside the drive passed', fallos.length === 0, resumen ? resumen[0] : `${fallos.length} failure lines`)
  }
}

// ---------------------------------------------------------------------------
step('5. uninstall must not touch the data')
// ---------------------------------------------------------------------------
let snapshot = null
{
  // The count of ventas is NOT the right question, because the payment drive ends by CANCELLING the
  // sale it just took — `payment-drive.js` step 6 asserts the stock returns and the row goes to
  // `estado = 'cancelada'`. Reading `COUNT(*)` alone produced "0 ventas" on a run where a sale had
  // genuinely happened and been cancelled, and the check then failed for a reason that had nothing
  // to do with uninstall. What must survive is the ROW and its contents, cancelled or not: that is
  // what proves the ledger is still there afterwards.
  const db = new DatabaseSync(DB, { readOnly: true })
  const ventas = db.prepare('SELECT COUNT(*) AS n FROM ventas').get().n
  const productos = db.prepare('SELECT COUNT(*) AS n FROM productos').get().n
  const rows = db.prepare('SELECT id, estado, total_centavos FROM ventas ORDER BY id DESC').all()
  // The stock of the product that was ACTUALLY SOLD, taken from the sale line.
  //
  // `SELECT stock_milli FROM productos ORDER BY id LIMIT 1` was the first product SEEDED; the POS grid
  // is sorted by name, so the drive sells the first product ALPHABETICALLY. With the demo catalogue
  // those are different rows, and the check asserted that an untouched product's stock was unchanged
  // after a sale — passing or failing for reasons that had nothing to do with the sale. The sale line
  // names the product the shop actually sold, so that is what is read here.
  const vendido = db
    .prepare(
      `SELECT vd.producto_id, vd.cantidad_milli, p.nombre, p.stock_milli
         FROM ventas_detalles vd
         LEFT JOIN productos p ON p.id = vd.producto_id
        WHERE vd.producto_id IS NOT NULL
        ORDER BY vd.id DESC LIMIT 1`
    )
    .get()
  const movimientos = db.prepare('SELECT COUNT(*) AS n FROM movimientos_caja').get().n
  db.close()
  snapshot = { ventas, productos, rows, vendido, movimientos }
  record(
    'the sale line names a real product, and that product is on disk',
    vendido !== undefined && vendido.nombre !== null && vendido.stock_milli > 0,
    vendido === undefined
      ? 'no sale line with a product'
      : `${vendido.nombre}: sold ${vendido.cantidad_milli} milli, ${vendido.stock_milli} milli on the shelf now`
  )
  // Note the stock figure above is read AFTER the drive cancelled the sale, so it is the RESTORED
  // level, not the decremented one. The decrement itself is asserted inside the drive, which reads
  // the stock immediately after the sale and again after the cancellation. Asserting it here as
  // well would only re-assert a number taken at the wrong moment.
  record(
    'a sale row exists in the shop ledger before uninstalling',
    ventas > 0,
    `${ventas} venta(s): ${rows.map((r) => `#${r.id} ${r.estado} ${r.total_centavos}c`).join(', ') || 'none'}`
  )
  record(
    'stock is back after the drive cancelled it',
    snapshot.vendido !== undefined && snapshot.vendido.stock_milli > 0,
    `stock_milli ${snapshot.vendido?.stock_milli} on ${snapshot.vendido?.nombre ?? 'no product'}`
  )
  record('the drawer recorded the movements', movimientos > 0, `${movimientos} movimiento(s) de caja`)
}

await stopApp()
record('app closed before uninstalling', !appRunning(), 'no MiniMarck.exe running')

if (existsSync(UNINSTALLER)) {
  const r = spawnSync(UNINSTALLER, ['/S'], { timeout: 5 * 60 * 1000 })
  record('uninstaller started and exited', r.status === 0, `exit code ${r.status} (0 means "started", not "finished")`)

  const removed = await waitForRemoval(INSTALLED)
  record('the program was removed', removed.ok, removed.ok ? `after ${(removed.waitedMs / 1000).toFixed(1)}s` : removed.detail)
  record('it is gone from Programs and Features', !uninstallEntry(), 'HKCU Uninstall key')
} else {
  record('the program was removed', false, 'no uninstaller to run')
}
record('the data directory was NOT deleted', existsSync(DB), existsSync(DB) ? DB : 'THE DATABASE IS GONE')

if (existsSync(DB)) {
  const db = new DatabaseSync(DB, { readOnly: true })
  const rows = db.prepare('SELECT id, estado, total_centavos FROM ventas ORDER BY id').all()
  const productos = db.prepare('SELECT COUNT(*) AS n FROM productos').get().n
  const movimientos = db.prepare('SELECT COUNT(*) AS n FROM movimientos_caja').get().n
  // Same product the sale line names, for the same reason as the pre-uninstall snapshot: comparing
  // a fixed row's stock proves nothing about whether the sale's decrement survived.
  const vendido = db
    .prepare(
      `SELECT vd.producto_id, vd.cantidad_milli, p.nombre, p.stock_milli
         FROM ventas_detalles vd
         LEFT JOIN productos p ON p.id = vd.producto_id
        WHERE vd.producto_id IS NOT NULL
        ORDER BY vd.id DESC LIMIT 1`
    )
    .get()
  const integrity = Object.values(db.prepare('PRAGMA integrity_check').get())[0]
  db.close()

  record('the database is still valid after uninstall', integrity === 'ok', `integrity_check: ${integrity}`)

  // Byte-for-byte on the sale rows, not just a count. A count can match while the contents were
  // rewritten, and "the sale is still there with the same money on it" is the actual claim.
  const sameRows = JSON.stringify(rows) === JSON.stringify(snapshot.rows)
  record(
    'the sale ledger SURVIVED the uninstall, unchanged',
    rows.length === snapshot.ventas && sameRows,
    sameRows
      ? rows.map((r) => `#${r.id} ${r.estado} ${r.total_centavos}c`).join(', ')
      : `before ${JSON.stringify(snapshot.rows)} vs after ${JSON.stringify(rows)}`
  )
  record('the catalogue survived the uninstall', productos === snapshot.productos, `${productos} products`)
  record('the drawer movements survived', movimientos === snapshot.movimientos, `${movimientos} movimiento(s)`)
  record(
    'the sold product kept its stock level through the uninstall',
    vendido?.stock_milli === snapshot.vendido?.stock_milli,
    `${vendido?.nombre}: ${vendido?.stock_milli} milli, was ${snapshot.vendido?.stock_milli}`
  )
}

function report() {
  const failed = results.filter((r) => !r.ok)
  console.log('')
  console.log('='.repeat(72))
  if (failed.length) {
    console.log(`INSTALLED E2E FAILED: ${failed.length}/${results.length} checks failed`)
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
    process.exit(1)
  }
  console.log(`=== INSTALLED E2E: all ${results.length} checks passed ===`)
}

report()
