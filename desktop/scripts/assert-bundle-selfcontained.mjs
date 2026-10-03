/**
 * What does the built main bundle actually need at RUNTIME?
 *
 * This decides whether the installer has to ship `node_modules` at all.
 *
 * electron-vite BUNDLES the main process, but it EXTERNALISES anything listed in
 * `dependencies` (it only bundles `devDependencies`). So the question is not "is this code
 * bundled" in general - it is "does the emitted `out/main/index.js` still contain a bare
 * `import ... from 'something'`" where `something` is neither a relative path nor a `node:`
 * builtin. If it does, the installed app needs that package in `resources/app.asar/node_modules`
 * or it dies at startup with an unresolved import. If it does not, the installer can ship the
 * bundle alone and stay small.
 *
 * The answer is read from the EMITTED file, never from the source, because the source is not
 * what ships. Reading `src/main/index.js` and concluding "it only imports relative paths" would
 * prove nothing about the artifact.
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const entry = path.join(root, 'out', 'main', 'index.js')

if (!existsSync(entry)) {
  console.error(`out/main/index.js not found. Run: npm run build`)
  process.exit(1)
}

const text = readFileSync(entry, 'utf8')

// Every module specifier the bundle mentions, from static imports, dynamic imports and require().
const specs = new Set()
const patterns = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
]
for (const re of patterns) {
  let m
  while ((m = re.exec(text)) !== null) specs.add(m[1])
}

const classify = (s) => {
  if (s.startsWith('node:')) return 'builtin'
  if (s.startsWith('.') || s.startsWith('/')) return 'relative'
  return 'BARE'
}

const groups = { builtin: [], relative: [], BARE: [] }
for (const s of specs) groups[classify(s)].push(s)
for (const k of Object.keys(groups)) groups[k].sort()

console.log(`MAIN BUNDLE RUNTIME DEPS: ${path.relative(root, entry)}`)
console.log(`  size            : ${text.length} bytes`)
console.log(`  node: builtins  : ${groups.builtin.length}`)
console.log(`  relative/asset  : ${groups.relative.length}`)
console.log(`  BARE (needs node_modules at runtime): ${groups.BARE.length}`)
if (groups.BARE.length) {
  for (const s of groups.BARE) console.log(`    ${s}`)
}
console.log('')

// The same question for the preload, because a preload that cannot resolve its imports silently
// fails to load and the bridge simply does not exist - the failure mode this repo has already
// been bitten by once.
const preload = path.join(root, 'out', 'preload', 'index.cjs')
if (existsSync(preload)) {
  const ptext = readFileSync(preload, 'utf8')
  const pspecs = new Set()
  for (const re of patterns) {
    let m
    while ((m = re.exec(ptext)) !== null) pspecs.add(m[1])
  }
  const pbare = [...pspecs].filter((s) => classify(s) === 'BARE')
  console.log(`PRELOAD BUNDLE: ${ptext.length} bytes, bare imports: ${pbare.length ? pbare.join(', ') : '(none)'}`)
} else {
  console.log('PRELOAD BUNDLE: out/preload/index.cjs NOT FOUND')
}

// And the renderer, which is served from files and has no Node access at all.
console.log('')
console.log('If BARE is 0 for both, the installer needs NO node_modules: the bundle is self-contained.')
