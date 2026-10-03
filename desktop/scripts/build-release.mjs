/**
 * `npm run build:release` — the build that goes into the installer.
 *
 * WHY A WRAPPER SCRIPT AND NOT AN INLINE ENV VAR. `MINIMARCK_PROBE=0 electron-vite build` in an
 * npm script works in bash and does not work in `cmd.exe` or in PowerShell, and this project is
 * developed and packaged on Windows. The cross-platform way to set an environment variable for
 * one child process is to set it in that process, which is what this file is for: no `cross-env`
 * dependency, and the flag cannot leak into the developer's own shell.
 *
 * WHAT IT ACTUALLY DOES. Sets `MINIMARCK_PROBE=0` and runs the ordinary `electron-vite build`, so
 * the release build is the SAME build with one thing removed, not a second configuration that can
 * drift from the first. The dev build (with the probe) is what `verify:s0` exercises.
 *
 * The two things asserted at the end are not ceremony. Without them this script is a rename of
 * "I believe the probe is gone", and the failure mode it prevents is an installer that ships a
 * page which fires refused IPC calls on every navigation forever - which is exactly the kind of
 * thing nobody notices until a customer reports the app being slow.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stagingEnv } from './staging-temp.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

// Locate the electron-vite binary through the local node_modules rather than relying on
// `npx`, which would be free to fetch a different version than the one in package-lock.json.
const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite')
if (!existsSync(bin)) {
  console.error(`build:release — ${bin} not found. Run: npm install`)
  process.exit(1)
}

console.log('build:release — building WITHOUT the launch probe (MINIMARCK_PROBE=0)')
// `stagingEnv` is the same esbuild temp override the development build applies. It is required
// here too: this script invokes `electron-vite build` itself rather than going through
// `npm run build`, so without it the installer build would fail at the renderer phase with
// "Acceso denegado" while the development build passed. One helper, so the two cannot drift.
const result = spawnSync(bin, ['build'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...stagingEnv(root), MINIMARCK_PROBE: '0' }
})

if (result.status !== 0) {
  console.error(`build:release FAILED — electron-vite build exited ${result.status}`)
  process.exit(result.status === null ? 1 : result.status)
}

console.log('')
console.log('build:release — verifying the probe really is absent from the emitted renderer')

const indexHtml = path.join(root, 'out', 'renderer', 'index.html')
if (!existsSync(indexHtml)) {
  console.error(`build:release FAILED — ${indexHtml} does not exist`)
  process.exit(1)
}
const html = readFileSync(indexHtml, 'utf8')

const problems = []
// Match TAGS, not the word. The first version of this check was `/\bprobe\.js\b/`, which passed
// over a correctly-stripped file and failed over one whose comment still mentioned the probe -
// i.e. it could not tell "the probe is gone" from "the probe is gone but something still talks
// about it". Checking for an actual script tag and an actual element is unambiguous.
if (/<script[^>]*\bsrc\s*=\s*["'][^"']*probe\.js/.test(html)) {
  problems.push('out/renderer/index.html still has a <script> tag pointing at probe.js')
}
if (/<ul[^>]*\bid\s*=\s*["']results["']/.test(html)) {
  problems.push('out/renderer/index.html still has the #results probe list element')
}
// And no mention at all, in a comment or otherwise. A release artifact should not describe an
// instrument it does not contain.
if (/probe/i.test(html)) {
  problems.push('out/renderer/index.html still mentions the probe (probably in a leftover comment)')
}

// The script tag is not enough: the module could have been pulled into a CHUNK by the bundler
// even with the tag removed, and then a stray import could load it. So the emitted JavaScript is
// searched too, for the probe's own global and its distinctive strings.
const assets = readdirSync(path.join(root, 'out', 'renderer', 'assets'))
for (const asset of assets) {
  if (!/\.(js|css)$/.test(asset)) continue
  const text = readFileSync(path.join(root, 'out', 'renderer', 'assets', asset), 'utf8')
  if (text.includes('__S0_PROBE__')) problems.push(`assets/${asset} contains __S0_PROBE__`)
  if (text.includes('SELF_CHECK_ORIGIN')) problems.push(`assets/${asset} contains the probe self-check origin`)
  if (text.includes('mm-s0-probe')) problems.push(`assets/${asset} contains the probe localStorage key`)
}

if (problems.length) {
  console.error('')
  console.error('build:release FAILED — the probe is still in the release build:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

console.log('build:release OK — renderer has no probe, no __S0_PROBE__, no self-check origin')
