/**
 * Assert the packaged migration tree matches the source tree.
 *
 * This exists because the failure mode of getting it wrong is invisible: the app launches, the
 * window renders, and the database sits at `user_version = 0` with no tables. No crash, no log
 * line the user would read, and every screen fails later with a confusing "no such table".
 *
 * Same reasoning as `assert-preload-format.mjs`: a sandboxed preload silently failing to load is
 * also invisible, so the format is asserted against the EMITTED output, not the source.
 *
 * Three things are checked, because each has a distinct way of going wrong:
 *   1. the .sql files are present and named identically  -> a rename or a missing copy
 *   2. byte-for-byte identical to the source            -> a truncated or stale emit
 *   3. `defaultMigrationsDir()` really points at them   -> a layout change nobody noticed
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const SRC = path.join(root, 'src', 'main', 'db', 'migrations')
const OUT = path.join(root, 'out', 'main', 'migrations')

const checks = []
/**
 * Records a check result. Accepts a sync or async `fn`.
 *
 * It must await an async `fn`. A first version did not, and the async check below registered as
 * PASS on every run because a rejected promise never reached the `catch` — which made the script
 * structurally incapable of failing on the one thing it exists to prove. If a verifier cannot
 * fail it is worse than no verifier, because it converts a real risk into a false green.
 */
async function check(name, fn) {
  try {
    await fn()
    checks.push({ name, ok: true })
  } catch (error) {
    checks.push({ name, ok: false, error: error.message })
  }
}

const run = async () => {

const sqlFiles = (dir) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.sql')).sort() : []

await check('source migrations exist', () => {
  const files = sqlFiles(SRC)
  if (files.length === 0) throw new Error(`no .sql files in ${SRC}; run the build after adding 001_init.sql`)
})

await check('migrations were emitted to out/main/migrations', () => {
  const src = sqlFiles(SRC)
  const out = sqlFiles(OUT)
  if (out.length === 0) {
    throw new Error(`${OUT} has no .sql files — electron.vite.config.js is not emitting them`)
  }
  const missing = src.filter((f) => !out.includes(f))
  if (missing.length) throw new Error(`not packaged: ${missing.join(', ')}`)
  const extra = out.filter((f) => !src.includes(f))
  if (extra.length) throw new Error(`packaged but not in source: ${extra.join(', ')}`)
})

await check('emitted migrations are byte-for-byte identical to source', () => {
  for (const file of sqlFiles(SRC)) {
    const a = readFileSync(path.join(SRC, file))
    const b = readFileSync(path.join(OUT, file))
    if (!a.equals(b)) {
      throw new Error(`${file} differs: ${a.length} bytes in source, ${b.length} bytes packaged`)
    }
  }
})

await check('defaultMigrationsDir() resolves to the emitted directory', async () => {
  // Two separate claims, so both are checked rather than one standing in for the other.
  //
  // (a) From SOURCE, the function is correct. `pathToFileURL`, not a bare path: dynamic
  // `import()` on Windows rejects a raw `C:\...` path with "Only URLs with a scheme in: file,
  // data, and node are supported".
  const { defaultMigrationsDir } = await import(
    pathToFileURL(path.join(root, 'src', 'main', 'db', 'paths.js')).href
  )
  const fromSource = defaultMigrationsDir()
  if (sqlFiles(fromSource).length === 0) {
    throw new Error(`defaultMigrationsDir() from source -> ${fromSource}, which has no .sql files`)
  }

  // (b) From the BUNDLE, the same expression must land on the emitted directory. The function
  // resolves `./migrations/` against its own module URL, so the answer is determined entirely by
  // where `paths.js` ended up: `out/main/index.js` implies `out/main/migrations/`.
  //
  // This is the part that actually matters and it CANNOT be proven by importing the source: the
  // source's `import.meta.url` always points into `src/`, so importing it would pass even if the
  // build emitted nothing. A first version of this check did exactly that and was green for the
  // wrong reason. What is asserted is the geometry the bundler actually produces.
  const entry = path.join(root, 'out', 'main', 'index.js')
  if (!existsSync(entry)) {
    throw new Error(`${entry} not found; main was not emitted where the main process expects it`)
  }
  const fromBundle = fileURLToPath(new URL('./migrations/', pathToFileURL(entry).href))
  if (!existsSync(fromBundle)) {
    throw new Error(`the bundle at ${entry} would resolve migrations to ${fromBundle}, which does not exist`)
  }
  if (sqlFiles(fromBundle).length === 0) {
    throw new Error(`the bundle would resolve migrations to ${fromBundle}, which has no .sql files`)
  }
})

const failed = checks.filter((c) => !c.ok)
for (const c of checks) {
  console.log(`${c.ok ? '  PASS' : '  FAIL'}  ${c.name}${c.ok ? '' : `  — ${c.error}`}`)
}
if (failed.length > 0) {
  console.error(`\nMIGRATION PACKAGING FAILED: ${failed.length}/${checks.length} checks failed`)
  process.exit(1)
}
console.log(`\n=== ${checks.length}/${checks.length} migration packaging checks passed ===`)
console.log('MIGRATIONS PACKAGED OK: out/main/migrations')
}

await run()
