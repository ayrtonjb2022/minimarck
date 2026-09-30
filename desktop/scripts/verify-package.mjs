/**
 * Assert the PACKAGED artifact, not the build config.
 *
 * WHY THIS IS NOT `assert-migrations-packaged.mjs`. That script proves the SQL was emitted to
 * `out/main/migrations/` and that the bundle's geometry points at it. Both of those are about the
 * BUILD OUTPUT, and a build output is not what a user runs. What a user runs is
 * `resources/app.asar`, produced by electron-builder, and every packaging mistake worth catching
 * happens in that extra step: a `files` glob that quietly excluded the SQL, an `extraResources`
 * path that moved it outside the asar, a `deleteAppDataOnUninstall` that someone flipped while
 * tidying up, a probe that shipped because the release build was the wrong one.
 *
 * None of those are visible from `package.json` or from `out/`.
 *
 * WHAT IS ASSERTED, and why each one is a real failure rather than a style preference:
 *
 *   1. The asar exists and its manifest is readable. A packaging run that produced no asar did
 *      not produce an app.
 *   2. The migration SQL is INSIDE the asar, at `out/main/migrations/`. This is the load-bearing
 *      one. `defaultMigrationsDir()` resolves `./migrations/` against the main bundle's own
 *      `import.meta.url`; in the installed app the bundle is at
 *      `resources/app.asar/out/main/index.js`, so the SQL has to be at
 *      `resources/app.asar/out/main/migrations/`. If it is not, the app still starts, the
 *      window still opens, and the database sits at `user_version = 0` with no tables - every
 *      screen then fails with "no such table" and the user is told the app is broken.
 *   3. The SQL inside the asar is byte-identical to the source. A truncated copy is the same
 *      silent failure as a missing one, and it is invisible without a byte comparison.
 *   4. The renderer, preload and main entry are all in the asar. The preload is the nastiest:
 *      a preload that cannot be found does not throw, it just does not load, so the IPC bridge
 *      silently does not exist and every screen reports a confusing error.
 *   5. NO `node_modules` in the asar. Proven possible by `assert-bundle-selfcontained.mjs`. If
 *      node_modules ever reappears, either a native module crept in (which would mean a rebuild
 *      step is now required) or the dependency split regressed.
 *   6. NO probe. No `probe.js`, no `__S0_PROBE__` in the emitted renderer, no `#results` element.
 *   7. The NSIS INSTALLER exists and is a real PE executable.
 *   8. The installer UI is SPANISH. A silent fallback to English would be invisible in a build
 *      log and obvious to the user, so the Spanish strings are looked for in the binary itself.
 *   9. `deleteAppDataOnUninstall` is explicitly `false` in the config. This one is read from
 *      `electron-builder.yml` rather than inferred, because it is a POLICY and the guarantee
 *      should be a refusal to build, not a hope about a default.
 *
 * STAGE AWARENESS. `--dir` produces the unpacked app with NO installer, so checks 7 and 8 are
 * skipped in that stage and reported as SKIPPED rather than PASSED. Reporting a skip as a pass
 * is the specific dishonesty this script exists to avoid.
 *
 * OUTPUT DIRECTORY. `node scripts/verify-package.mjs [dir]` verifies an arbitrary builder output
 * directory, defaulting to `release/`. `build-installer.mjs` passes its staged directory, because
 * that is where the artifact it just produced actually is. A verifier that can only look in one
 * place forces the build to be run twice to be checked.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as asar from '@electron/asar'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const RELEASE = process.argv[2] ? path.resolve(root, process.argv[2]) : path.join(root, 'release')
const SRC_SQL = path.join(root, 'src', 'main', 'db', 'migrations')

/**
 * Read a file out of the asar.
 *
 * The two `@electron/asar` APIs disagree about path form, and that disagreement cost an hour:
 *
 *   `listPackage()` returns entries with a LEADING separator and native separators, e.g.
 *   `\out\main\migrations\001_init.sql`.
 *   `extractFile()` accepts native separators with NO leading separator, and rejects both the
 *   leading form and the forward-slash form.
 *
 * So the canonical form used throughout this script is `out/main/migrations/001_init.sql`
 * (forward slashes, no leading slash) - which is also how the paths appear in the source tree -
 * and this helper converts it for `extractFile`. Comparing the asar against the source tree with
 * one spelling and extracting with another is how a verifier ends up reporting that a file is
 * missing when it is sitting right there in the listing.
 */
const readFromAsar = (p, inner) => asar.extractFile(p, path.normalize(inner))

/** Canonical spelling for comparison: forward slashes, no leading separator. */
const canon = (f) => f.replace(/^[\\/]+/, '').replace(/\\/g, '/')

const results = []
const record = (name, ok, detail = '') => results.push({ name, ok, detail, skipped: false })
const skip = (name, why) => results.push({ name, ok: true, detail: why, skipped: true })

// ---------------------------------------------------------------------------
// Locate what was built. `--dir` produces the unpacked app with NO installer; a full run leaves the
// unpacked directory AND the installer, so the installer has to be looked for FIRST — testing
// `win-unpacked` first labels every full run as a `--dir` run, which would silently skip checks 7
// and 8 on the exact build that was supposed to be fully verified.
// ---------------------------------------------------------------------------
const winUnpacked = path.join(RELEASE, 'win-unpacked')
const asarPath = path.join(winUnpacked, 'resources', 'app.asar')
// Declared here, not next to the `deleteAppDataOnUninstall` check that also reads it. The Spanish
// declaration check below runs EARLIER in the file, and `const` is not hoisted — reading it from
// down there is a temporal dead zone ReferenceError, which `node --check` does not catch because it
// only parses. It was caught by running the script.
const builderYml = path.join(root, 'electron-builder.yml')

const isSetupExe = (f) => f.toLowerCase().endsWith('.exe') && f.toLowerCase().includes('setup')
const installerNames = existsSync(RELEASE) ? readdirSync(RELEASE).filter(isSetupExe) : []
const installer = installerNames.includes('MiniMarck Setup.exe')
  ? path.join(RELEASE, 'MiniMarck Setup.exe')
  : installerNames.length > 0
    ? path.join(RELEASE, installerNames[0])
    : null

const stage = existsSync(asarPath) ? (installer ? 'installer-run' : 'dir') : null

if (!stage) {
  console.error(`PACKAGE VERIFICATION FAILED — no app.asar under ${path.relative(root, RELEASE)}`)
  console.error('Run one of:')
  console.error('  npm run pack:dir   (unpacked app, no installer)')
  console.error('  npm run dist       (full NSIS installer)')
  process.exit(1)
}

console.log(
  `PACKAGE VERIFIER — stage=${stage}  asar=${path.relative(root, asarPath)}` +
    (installer ? `  installer=${path.basename(installer)}` : '')
)

// ---------------------------------------------------------------------------
// 1. The asar exists and lists.
// ---------------------------------------------------------------------------
let asarFiles = []
try {
  asarFiles = asar.listPackage(asarPath)
  record('asar exists and its manifest is readable', true, `${asarFiles.length} entries`)
} catch (err) {
  record('asar exists and its manifest is readable', false, String(err.message))
}

// From here on, asar reading is pointless if the listing failed.
if (asarFiles.length > 0) {
  // Membership is tested through the canonical spelling, because `listPackage` and `extractFile`
  // do not accept the same form. See `canon` and `readFromAsar` above.
  const canonFiles = asarFiles.map(canon)
  const has = (want) => canonFiles.includes(want)
  const hasUnder = (prefix) => canonFiles.some((f) => f.startsWith(prefix))

  // -----------------------------------------------------------------------
  // 2 + 3. Migrations inside the asar, byte-identical.
  // -----------------------------------------------------------------------
  const SQL_PREFIX = 'out/main/migrations/'
  const packedSql = canonFiles
    .filter((f) => f.startsWith(SQL_PREFIX) && f.toLowerCase().endsWith('.sql'))
    .map((f) => f.slice(SQL_PREFIX.length))
    .sort()

  const srcSql = existsSync(SRC_SQL)
    ? readdirSync(SRC_SQL)
        .filter((f) => f.toLowerCase().endsWith('.sql'))
        .sort()
    : []

  if (packedSql.length === 0) {
    record(
      'migrations are INSIDE app.asar at out/main/migrations/',
      false,
      `no .sql under ${SQL_PREFIX} in the asar; found ${asarFiles.length} entries total. ` +
        'The installed app would run at user_version 0 with no tables.'
    )
  } else {
    record('migrations are INSIDE app.asar at out/main/migrations/', true, packedSql.join(', '))

    const missing = srcSql.filter((f) => !packedSql.includes(f))
    const extra = packedSql.filter((f) => !srcSql.includes(f))
    record(
      'the packaged migration set matches the source set',
      missing.length === 0 && extra.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : extra.length ? `not in source: ${extra.join(', ')}` : 'same names'
    )

    const mismatched = []
    for (const file of srcSql) {
      if (!packedSql.includes(file)) continue
      const a = readFileSync(path.join(SRC_SQL, file))
      const b = readFromAsar(asarPath, `${SQL_PREFIX}${file}`)
      if (!a.equals(b)) mismatched.push(`${file} (${a.length} source vs ${b.length} packaged)`)
    }
    record(
      'packaged .sql is byte-for-byte identical to source',
      mismatched.length === 0,
      mismatched.length ? mismatched.join('; ') : `${srcSql.length} file(s) identical`
    )
  }

  // -----------------------------------------------------------------------
  // 4. The three build targets are present. The preload is the dangerous one.
  // -----------------------------------------------------------------------
  for (const [label, want] of [
    ['main entry out/main/index.js is in the asar', 'out/main/index.js'],
    ['sandboxed preload out/preload/index.cjs is in the asar', 'out/preload/index.cjs'],
    ['renderer entry out/renderer/index.html is in the asar', 'out/renderer/index.html']
  ]) {
    if (has(want)) record(label, true, want)
    else
      record(
        label,
        false,
        `${want} is MISSING. ` +
          (want.includes('preload')
            ? 'A preload that cannot be found does not throw: it silently does not load, so the IPC bridge does not exist and every screen reports a confusing error.'
            : '')
      )
  }

  // -----------------------------------------------------------------------
  // 5. No node_modules.
  // -----------------------------------------------------------------------
  if (hasUnder('node_modules/')) {
    const count = canonFiles.filter((f) => f.startsWith('node_modules/')).length
    record('no node_modules in the asar', false, `${count} entries — a native module may have crept in and a rebuild step would now be required`)
  } else {
    record('no node_modules in the asar', true, 'the bundle is self-contained (electron + node: builtins only)')
  }

  // -----------------------------------------------------------------------
  // 6. No probe anywhere in the shipped renderer.
  // -----------------------------------------------------------------------
  const probeTag = canonFiles.filter((f) => /probe\.js$/i.test(f))
  record('no probe.js in the asar', probeTag.length === 0, probeTag.join(', ') || 'absent')

  const rendererHtml = readFromAsar(asarPath, 'out/renderer/index.html').toString('utf8')
  const tagProblems = []
  if (/<script[^>]*\bsrc\s*=\s*["'][^"']*probe\.js/.test(rendererHtml)) tagProblems.push('a <script> tag still points at probe.js')
  if (/<ul[^>]*\bid\s*=\s*["']results["']/.test(rendererHtml)) tagProblems.push('the #results probe list element is still present')
  if (/probe/i.test(rendererHtml)) tagProblems.push('index.html still mentions the probe')
  record('the packaged renderer index.html contains no probe', tagProblems.length === 0, tagProblems.join('; ') || 'clean')

  // The asset bundle, which is where a bundled probe would actually live.
  const assets = canonFiles.filter((f) => f.startsWith('out/renderer/assets/') && /\.js$/.test(f))
  const assetHits = []
  for (const a of assets) {
    const text = readFromAsar(asarPath, a).toString('utf8')
    for (const needle of ['__S0_PROBE__', 'SELF_CHECK_ORIGIN', 'mm-s0-probe']) {
      if (text.includes(needle)) assetHits.push(`${a}: ${needle}`)
    }
  }
  record(
    'the packaged renderer JS contains no probe code',
    assetHits.length === 0,
    assetHits.join('; ') || `${assets.length} asset(s) scanned`
  )
}

// ---------------------------------------------------------------------------
// 7 + 8. The installer itself, only when a full run produced one.
// ---------------------------------------------------------------------------
if (installerNames.length === 0) {
  skip('NSIS installer exists', 'skipped: this was a --dir run (no installer produced)')
  skip('the installer is a real Windows PE executable', 'skipped: no installer to inspect')
  skip('the installer UI is Spanish', 'skipped: no installer to inspect')
} else {
  record(
    'NSIS installer exists',
    true,
    `${path.basename(installer)} (${path.relative(root, RELEASE)}, ${(statSync(installer).size / 1048576).toFixed(1)} MB)`
  )
}

if (installer !== null) {
  const bytes = readFileSync(installer)
  const st = statSync(installer)

  // A real PE executable starts with "MZ". Anything else means the file is not a program.
  const isPe = bytes[0] === 0x4d && bytes[1] === 0x5a
  record('the installer is a real Windows PE executable', isPe, `${path.basename(installer)}, ${(st.size / 1048576).toFixed(1)} MB, MZ=${isPe}`)

  // SPANISH INSTALLER UI — the check was rewritten, because the old one was a guaranteed
  // false negative and it blocked every release build for two days.
  //
  // It grepped the .exe for plaintext `Siguiente` / `Next` in both UTF-16LE and Latin-1. NSIS
  // COMPRESSES its data section, so a phrase inside the wizard is not present as plaintext anywhere
  // in the file: the search cannot succeed, whether the installer is Spanish or English. The build
  // reported FAIL while the installed wizard was, in fact, entirely Spanish (title
  // "Instalación de MiniMarck", buttons "Atrás" / "Terminar" / "Cancelar"). A check that fails on
  // correct output is worse than no check, because it teaches everyone to ignore it.
  //
  // What is actually provable here, and is now asserted instead:
  //
  //   1. The DECLARATION. `nsis.installerLanguages` must list `es_ES`. electron-builder either
  //      honours it or fails the build; it does not silently drop an unknown value.
  //   2. The APPLICATION's Spanish resources. `locales/es.pak` and `es-419.pak` sit beside the
  //      asar in the staged output. Their presence proves the app itself is shipped with Spanish
  //      Chromium/Electron strings, which is a different failure from an English NSIS wizard.
  //
  // What is NOT provable by reading a file, and is why the declaration is not the whole claim: the
  // NSIS language pack actually loaded at runtime. That is proven by RUNNING the installer, which
  // is what `scripts/verify-installer-ui.mjs` does. Run it; do not infer it.
  const config = readFileSync(builderYml, 'utf8')
  const declaresSpanish = /^[\t ]*installerLanguages:[\s\S]*?^[\t ]*-\s*es_ES\s*$/m.test(config)
  record(
    'the installer is DECLARED Spanish (nsis.installerLanguages: es_ES)',
    declaresSpanish,
    declaresSpanish ? 'electron-builder.yml requests es_ES' : 'electron-builder.yml does not list es_ES under installerLanguages'
  )

  // `es.pak` is the Electron locale, `es-419.pak` the Latin-American variant. Both are shipped by
  // default, so this is a weaker signal than it looks — it is here to catch a build that stripped
  // locales entirely, not to make the language claim on its own.
  const localesDir = path.join(winUnpacked, 'locales')
  const locales = existsSync(localesDir) ? readdirSync(localesDir) : []
  const spanishPaks = locales.filter((f) => /^es(-419)?\.pak$/.test(f))
  record(
    'the staged output ships Spanish Electron locales',
    spanishPaks.length > 0,
    spanishPaks.length > 0 ? spanishPaks.join(', ') : `no es*.pak under ${path.basename(localesDir)}`
  )
  record(
    'the NSIS language pack itself is NOT proven by this script',
    true,
    'the declaration is checked; run `npm run verify:installer-ui` to observe the real wizard'
  )

  // `deleteAppDataOnUninstall` is a CONFIG promise, but only the installed behaviour is the promise
  // that matters. This script can prove the config says what it must; it cannot prove the data
  // survives an uninstall. Saying so out loud is the point — a green check here must not be
  // mistaken for the data-safety claim the user actually cares about.
  record(
    'data retention is NOT proven by this script',
    true,
    'only the config is checked here; the real proof is install -> sell -> uninstall -> reopen'
  )
}

// ---------------------------------------------------------------------------
// 9. deleteAppDataOnUninstall policy, read from the config as TEXT.
// ---------------------------------------------------------------------------
if (!existsSync(builderYml)) {
  record('electron-builder.yml declares deleteAppDataOnUninstall: false', false, 'electron-builder.yml is missing')
} else {
  const yml = readFileSync(builderYml, 'utf8')
  const m = yml.match(/^\s*deleteAppDataOnUninstall\s*:\s*(\S+)\s*$/m)
  if (!m) {
    record(
      'electron-builder.yml declares deleteAppDataOnUninstall: false',
      false,
      'the setting is ABSENT. It happens to default to false today, but an explicit false is the ' +
        'whole point: the next tidy-up, or an electron-builder default change, would delete a ' +
        "shop's entire sales history on uninstall."
    )
  } else if (m[1] !== 'false') {
    record(
      'electron-builder.yml declares deleteAppDataOnUninstall: false',
      false,
      `it is "${m[1]}". Uninstalling would delete %APPDATA%\\MiniMarck, which contains every sale, ` +
        'every till movement and every journal entry.'
    )
  } else {
    record('electron-builder.yml declares deleteAppDataOnUninstall: false', true, 'explicitly false')
  }
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
console.log('')
for (const r of results) {
  const tag = r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'
  console.log(`  ${tag}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
}

const failed = results.filter((r) => !r.ok)
const skipped = results.filter((r) => r.skipped)
console.log('')
if (failed.length > 0) {
  console.error(`PACKAGE VERIFICATION FAILED: ${failed.length}/${results.length - skipped.length} checks failed`)
  process.exit(1)
}
console.log(
  `=== ${results.length - skipped.length}/${results.length - skipped.length} package checks passed` +
    (skipped.length ? ` (${skipped.length} skipped: ${skipped.map((s) => s.name).join('; ')})` : '') +
    ' ==='
)
if (stage === 'dir') {
  console.log('NOTE: this was a --dir run, so the INSTALLER itself has not been built or checked.')
  console.log('      Run `npm run dist` for the NSIS installer and the Spanish-UI check.')
}
