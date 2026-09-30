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
 * Four things are checked, because each has a distinct way of going wrong:
 *   1. the .sql files are present and named identically  -> a rename or a missing copy
 *   2. byte-for-byte identical to the source            -> a truncated or stale emit
 *   3. `defaultMigrationsDir()` really points at them   -> a layout change nobody noticed
 *   4. they are inside the PACKAGED `app.asar`         -> the build that ships, not `out/`
 *
 * On (4): checks 1-3 are all about `out/`, the working directory. A release is an .asar, and an
 * .asar is built by a different pass over a different directory listing — `electron-builder` copies
 * what it finds, so anything the build config fails to include is simply absent, with no error. The
 * app then launches, renders, and sits at `user_version = 0` with no tables. Checking `out/` and
 * declaring the package good is checking the one artefact the user never receives.
 *
 * Pass a staged output directory to check a real package:
 *   node scripts/assert-migrations-packaged.mjs release/build-2026-09-29_225649
 * With no argument it falls back to `release`, and if no package is found it says so and skips
 * rather than passing quietly — a skipped check that reads as a green one is how (4) went missing.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as asar from '@electron/asar'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const SRC = path.join(root, 'src', 'main', 'db', 'migrations')
const OUT = path.join(root, 'out', 'main', 'migrations')
const RELEASE = process.argv[2] ? path.resolve(root, process.argv[2]) : path.join(root, 'release')

const checks = []
const skips = []
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

function skip(name, why) {
  skips.push({ name, why })
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

// ---- 4. the artefact the user actually receives -------------------------------------------
// Skipped, loudly, when no package exists. `npm run verify:migrations` runs in CI before a package
// is built, so failing there would punish the common case for a missing optional stage; asserting
// nothing without SAYING nothing is the line between that and a silent green.
const asarPath = path.join(RELEASE, 'win-unpacked', 'resources', 'app.asar')
if (!existsSync(asarPath)) {
  skip(
    'migrations are inside the packaged app.asar',
    `no package at ${path.relative(root, asarPath)}; run \`npm run pack:dir\` or pass a staged output directory`
  )
} else {
  const ASAR_MIGRATIONS = 'out/main/migrations'
  // `@electron/asar` lists archive paths with the HOST separator and a leading one, so on Windows an
  // entry is `\out\main\migrations\001_init.sql`. The archive is a ZIP and its internal names are
  // always POSIX; the separators are added by the listing call. Canonicalise before comparing, or
  // every check below reports "not packaged" on a package that is perfectly correct — which is the
  // same class of false negative as the NSIS language grep this whole exercise is about.
  const canon = (p) => p.replace(/^[/\\]+/, '').replace(/\\/g, '/')
  const inAsar = (dir) => {
    const prefix = `${dir}/`
    return asar
      .listPackage(asarPath, { isPack: false })
      .map(canon)
      .filter((e) => e.startsWith(prefix) && e.toLowerCase().endsWith('.sql'))
      .map((e) => e.slice(prefix.length))
      .sort()
  }

  await check('migrations are INSIDE app.asar', () => {
    const files = inAsar(ASAR_MIGRATIONS)
    if (files.length === 0) {
      throw new Error(`${ASAR_MIGRATIONS} contains no .sql inside ${path.basename(asarPath)}`)
    }
  })

  await check('the packaged migration set matches the source set', () => {
    const src = sqlFiles(SRC)
    const packed = inAsar(ASAR_MIGRATIONS)
    const missing = src.filter((f) => !packed.includes(f))
    if (missing.length) throw new Error(`not inside the asar: ${missing.join(', ')}`)
    const extra = packed.filter((f) => !src.includes(f))
    if (extra.length) throw new Error(`in the asar but not in source: ${extra.join(', ')}`)
  })

  await check('the packaged .sql is byte-for-byte identical to source', () => {
    // Read through the asar, not from `out/`. A build that repacked the SQL would be caught here and
    // not by a comparison against the directory electron-builder copied FROM, which would agree with
    // itself no matter what it wrote.
    for (const file of sqlFiles(SRC)) {
      const a = readFileSync(path.join(SRC, file))
      const b = asar.extractFile(asarPath, path.normalize(path.posix.join(ASAR_MIGRATIONS, file)))
      if (!a.equals(b)) {
        throw new Error(`${file} differs: ${a.length} bytes in source, ${b.length} bytes inside the asar`)
      }
    }
  })
}

const failed = checks.filter((c) => !c.ok)
for (const c of checks) {
  console.log(`${c.ok ? '  PASS' : '  FAIL'}  ${c.name}${c.ok ? '' : `  — ${c.error}`}`)
}
for (const s of skips) {
  console.log(`  SKIP  ${s.name}  — ${s.why}`)
}
if (failed.length > 0) {
  console.error(`\nMIGRATION PACKAGING FAILED: ${failed.length}/${checks.length} checks failed`)
  process.exit(1)
}
console.log(`\n=== ${checks.length}/${checks.length} migration packaging checks passed ===`)
if (skips.length > 0) {
  console.log(`NOTE: ${skips.length} check(s) skipped — ${skips.map((s) => s.name).join('; ')}`)
  console.log('      The PACKAGED artefact was therefore NOT verified. Run `npm run pack:dir` first.')
} else {
  console.log('MIGRATIONS PACKAGED OK: out/main/migrations, and inside the app.asar')
}
}

await run()
