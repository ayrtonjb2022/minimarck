/**
 * Can the new ASAR check in `assert-migrations-packaged.mjs` actually FAIL?
 *
 * A packaging check that is always green is not a check. This builds a deliberately broken package
 * — a main bundle with the migrations directory NOT copied in — and asserts that the same listing
 * logic reports "no .sql inside". Without this, the check could be silently vacuous: a path typo, a
 * wrong prefix, a wrong separator convention, and it would pass on a package that ships an app with
 * no schema at all, which is precisely the invisible failure the script exists to prevent.
 *
 * This is the negative control for the positive control in the verifier's own run.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as asar from '@electron/asar'

const dir = mkdtempSync(path.join(tmpdir(), 'asar-negctl-'))
const src = path.join(dir, 'app')
const asarPath = path.join(dir, 'app.asar')

try {
  // A main bundle, and NOTHING else. No `out/main/migrations`.
  mkdirSync(path.join(src, 'out', 'main'), { recursive: true })
  writeFileSync(path.join(src, 'out', 'main', 'index.js'), '// main entry, migrations deliberately not copied', 'utf8')

  await asar.createPackage(src, asarPath)
  if (!existsSync(asarPath)) throw new Error(`asar was not created at ${asarPath}`)

  // The exact listing logic from `assert-migrations-packaged.mjs`.
  const ASAR_MIGRATIONS = 'out/main/migrations'
  const canon = (p) => p.replace(/^[/\\]+/, '').replace(/\\/g, '/')
  const inAsar = asar
    .listPackage(asarPath, { isPack: false })
    .map(canon)
    .filter((e) => e.startsWith(`${ASAR_MIGRATIONS}/`) && e.toLowerCase().endsWith('.sql'))

  const entries = asar.listPackage(asarPath, { isPack: false }).map(canon)
  console.log(`Entries in the broken asar: ${JSON.stringify(entries)}`)
  console.log(`SQL found: ${inAsar.length} (expected 0)`)

  if (inAsar.length !== 0) {
    console.error('\nFAILED: the listing logic found .sql in a package that has none.')
    console.error('        The verifier would pass a package with no schema. The check is vacuous.')
    process.exit(1)
  }
  console.log('\nOK: the listing logic reports no .sql, so the verifier FAILS this package.')
  console.log('    The check is live, not vacuous.')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
