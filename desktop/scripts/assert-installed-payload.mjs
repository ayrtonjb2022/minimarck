/**
 * What the INSTALLED application actually ships, read from the installed `app.asar`.
 *
 * WHY THIS IS NOT REDUNDANT WITH THE OTHER PAYLOAD CHECKS. `assert-migrations-packaged.mjs` and
 * `assert-bundle-selfcontained.mjs` read `out/`, or `release/win-unpacked/` — directories this
 * script has no opinion about. The file a shop receives is
 * `%LOCALAPPDATA%\Programs\MiniMarck\resources\app.asar`.
 *
 * And that distinction is not theoretical. On the machine this was written for, the installed asar
 * was 1,110,584 bytes and `release/win-unpacked/resources/app.asar` was 1,101,763 bytes, with
 * `out/main/index.js` at 132,061 vs 130,662 bytes. Two different builds, same 13-entry file list,
 * same version string. Every `out/`-based check was green and none of them had looked at the
 * artefact under test. So: the claim is made about the installed file, or it is not made.
 *
 * THE OFFLINE CLAIM IS NOT REIMPLEMENTED HERE. There is already a scanner for this:
 * `verify-offline.mjs`, hardened by `tests/security/offline-inert-hosts.spec.js` with attacks that
 * must fail (fetch, CSS `url()`, `@import`, tag `src`, XHR, WebSocket, a protocol-ish string before
 * a real fetch) and inert vendor text that must be tolerated (licence banner, error-decoder string,
 * a comment). The first version of this file carried its own eight-pattern URL scan. That was a
 * second, weaker copy of a security-critical rule — the kind of duplication that drifts, and the
 * kind that eventually lets the strict one get deleted because it is "redundant".
 *
 * So this script EXTRACTS the installed archive's own code to a temp tree and hands it to the same
 * `auditRenderer`, which returns findings with line numbers. One implementation, one adversarial
 * suite, now pointed at the file the user receives. The offline guarantee is enforced where it
 * matters instead of where it is convenient to test.
 *
 * Usage:
 *   node scripts/assert-installed-payload.mjs                  # the default per-user install
 *   node scripts/assert-installed-payload.mjs <installDir>     # an explicit one
 */
import * as asar from '@electron/asar'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditRenderer } from './verify-offline.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const installDir = process.argv[2] || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'MiniMarck')
const asarPath = path.join(installDir, 'resources', 'app.asar')

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

// `extractFile` needs NATIVE separators, no leading separator. A POSIX-spelled inner path fails
// with "was not found in this archive", which names nothing useful. Same trap `verify-package.mjs`
// documents for `out/`.
const canon = (p) => p.replace(/^[/\\]+/, '').replace(/\\/g, '/')
const inner = (p) => path.normalize(canon(p))

// Both arguments, named, because the first version of this helper took ONE argument and passed it
// as the ARCHIVE. `readFrom('out/main/migrations/001_init.sql')` therefore asked `extractFile` to
// open the SQL file itself as an asar — and that path EXISTS, because the build also emits it to
// `out/`. So the helper did not fail on a missing file; it opened 48 KB of SQL text, read its first
// eight bytes as a header pickle, and died with `ERR_BUFFER_OUT_OF_BOUNDS` from deep inside
// `@electron/asar`, naming neither the file nor the mistake.
const readFrom = (rel) => {
  try {
    return asar.extractFile(asarPath, inner(rel))
  } catch (error) {
    throw new Error(
      `could not read "${rel}" out of ${asarPath}: ${error.message}\n` +
        `  (entries are listed with host separators; the expected form here is "${inner(rel)}")`
    )
  }
}

console.log(`installed asar: ${asarPath}`)

if (!existsSync(asarPath)) {
  record('the installed app has an app.asar', false, `NOT FOUND at ${asarPath} — is it installed?`)
  finish()
}

const entries = asar.listPackage(asarPath, { isPack: false }).map(canon)

// --- 1. the migration SQL travels inside the archive, unchanged ---------------------
const sqlInAsar = entries.filter((f) => f.endsWith('.sql'))
record(
  'the migration SQL is inside the installed asar',
  sqlInAsar.length > 0,
  sqlInAsar.join(', ') || 'no .sql file in the archive'
)

if (sqlInAsar.length > 0) {
  const srcSql = path.join(root, 'src', 'main', 'db', 'migrations')
  const srcFiles = readdirSql(srcSql)
  for (const file of srcFiles) {
    const packedEntry = sqlInAsar.find((e) => e.endsWith(`/${file}`) || e === file)
    if (!packedEntry) {
      record(`installed migration ${file}`, false, 'not inside the installed asar')
      continue
    }
    const a = readFileSync(path.join(srcSql, file))
    const b = readFrom(packedEntry)
    const tables = [...b.toString('utf8').matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)/gi)]
    record(
      `installed migration ${file} is byte-for-byte identical to source`,
      a.equals(b),
      a.equals(b)
        ? `${b.length} bytes, ${new Set(tables.map((m) => m[1].toLowerCase())).size} CREATE TABLE statements`
        : `${a.length} bytes in source, ${b.length} bytes installed`
    )
  }
}

// --- 2. nothing to compile on the shop's machine -----------------------------------
const natives = entries.filter((f) => f.endsWith('.node'))
record(
  'no native module is compiled in (nothing to rebuild on the shop machine)',
  natives.length === 0,
  natives.length === 0
    ? 'no .node binaries; node:sqlite is built into the Electron runtime, which is why this needs no rebuild'
    : `NATIVE: ${natives.join(', ')}`
)

const nodeModules = entries.filter((f) => /(^|\/)node_modules\/[^/]+/.test(f))
record(
  'the app ships no runtime dependencies',
  nodeModules.length === 0,
  nodeModules.length === 0 ? 'nothing under node_modules' : nodeModules.slice(0, 5).join(', ')
)

// --- 3. the preload crosses a context boundary as CommonJS -------------------------
const preload = entries.filter((f) => /preload.*\.c?js$/.test(f))
record(
  'the preload is bundled as CommonJS (.cjs)',
  preload.some((f) => f.endsWith('.cjs')),
  preload.join(', ') || 'no preload found in the archive'
)

// --- 4. nothing is fetched from the internet ---------------------------------------
// Extract the archive's OWN code and run the repo's hardened offline scanner over it.
const ownCode = entries.filter((f) => /\.(html|css|js|mjs|cjs)$/.test(f) && !f.includes('node_modules'))
const scratch = mkdtempSync(path.join(os.tmpdir(), 'minimarck-installed-payload-'))
try {
  for (const rel of ownCode) {
    const dest = path.join(scratch, canon(rel))
    mkdirSync(path.dirname(dest), { recursive: true })
    writeFileSync(dest, readFrom(rel))
  }
  const { findings, scanned } = auditRenderer(scratch)
  for (const f of findings) {
    const rel = path.relative(scratch, f.file).replace(/\\/g, '/')
    record(
      'the installed app loads nothing from the internet',
      false,
      `${rel}:${f.line} [${f.rule}] ${f.text}`
    )
  }
  record(
    'the installed app loads nothing from the internet',
    findings.length === 0,
    findings.length === 0
      ? `${scanned} installed file(s) scanned by the same hardened scanner that guards out/`
      : `${findings.length} finding(s)`
  )

  // The honest counterpart, printed rather than asserted: this build DOES contain absolute URL
  // strings, and a reader who greps for them will find them and should know why they are inert. A
  // check that hides them invites the next person to distrust it.
  const inert = new Set()
  for (const rel of ownCode) {
    for (const u of readFrom(rel).toString('utf8').match(/https?:\/\/[^\s'"`)<>\\]+/g) || []) inert.add(u)
  }
  console.log('')
  console.log(`  note: ${inert.size} absolute URL STRING(S) are present in the installed code and load nothing:`)
  for (const u of [...inert].sort()) console.log(`    ${u}`)
  console.log('    (XML namespaces, the Tailwind licence banner, a React error string, a Chromium')
  console.log('     issue link, and the localhost dev origin the trusted-sender allowlist compares against)')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

finish()

function readdirSql(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.sql'))
      .sort()
  } catch {
    return []
  }
}

function finish() {
  const failed = results.filter((r) => !r.ok)
  console.log('')
  console.log('='.repeat(72))
  if (failed.length) {
    console.log(`INSTALLED PAYLOAD FAILED: ${failed.length}/${results.length} checks failed`)
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
    process.exit(1)
  }
  console.log(`=== INSTALLED PAYLOAD: all ${results.length} checks passed ===`)
}
