/**
 * PRELOAD FORMAT GATE — the claim `build` used to make but did not enforce.
 *
 * SEC-3 requires `sandbox: true`, and a sandboxed Electron preload is ALWAYS CommonJS.
 * This package is `"type": "module"`, so electron-vite's default preload output is
 * `index.mjs` — which a sandboxed preload cannot load. Nothing errors: the renderer just
 * never gets a bridge, and `window.minimarck` is `undefined`.
 *
 * The old `tests/security.spec.js` guard was `resolvePreloadPath().endsWith('index.cjs')`
 * — a hardcoded literal compared against another hardcoded literal in `window.js`. Delete
 * the `output` block from electron.vite.config.js and it still passed green. This gate
 * reads the CONFIG and the EMITTED file, so the regression is what it claims to catch.
 *
 * Runs after `build` in `verify:s0`. Exits non-zero on any violation.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const desktopRoot = join(here, '..')
const configPath = join(desktopRoot, 'electron.vite.config.js')
const preloadOut = join(desktopRoot, 'out', 'preload')

const findings = []
const fail = (rule, text) => findings.push({ rule, text })

// 1. The config must still declare a CommonJS preload output.
const config = readFileSync(configPath, 'utf8')
if (!/format:\s*['"]cjs['"]/.test(config)) {
  fail('preload-format-not-cjs', 'electron.vite.config.js does not declare format: "cjs" for the preload')
}
const entryNames = config.match(/entryFileNames:\s*['"]([^'"]+)['"]/)
if (!entryNames) {
  fail('preload-entry-name-missing', 'electron.vite.config.js declares no preload entryFileNames')
} else if (!entryNames[1].endsWith('.cjs')) {
  fail('preload-entry-name-not-cjs', `preload entryFileNames is "${entryNames[1]}", which is not .cjs`)
}

// 2. The build must have run, and what it emitted must match the declaration.
if (!existsSync(preloadOut)) {
  fail('preload-not-built', 'out/preload does not exist — run `npm run build` first')
} else {
  const emitted = readdirSync(preloadOut)
  if (emitted.includes('index.mjs')) {
    fail('preload-emitted-esm', 'out/preload/index.mjs exists: the preload was built as ESM and a sandboxed preload cannot load it')
  }
  const expected = entryNames ? entryNames[1].replace('[name]', 'index') : 'index.cjs'
  if (!emitted.includes(expected)) {
    fail('preload-missing', `out/preload/${expected} does not exist (found: ${emitted.join(', ') || 'nothing'})`)
  }
}

if (findings.length === 0) {
  console.log(`verify:preload — PASS: the preload is declared CommonJS and emitted as ${entryNames[1].replace('[name]', 'index')}.`)
  process.exit(0)
} else {
  console.error(`verify:preload — FAIL: ${findings.length} finding(s):`)
  for (const f of findings) console.error(`  [${f.rule}] ${f.text}`)
  console.error('  A sandboxed preload cannot be ESM. Without a bridge the renderer loses every')
  console.error('  operation silently, so this is a build failure, not a warning.')
  process.exit(1)
}
