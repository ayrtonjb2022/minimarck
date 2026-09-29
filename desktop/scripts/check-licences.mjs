import { readFileSync, existsSync } from 'node:fs'
import { globSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const names = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {})
]

console.log('=== declared licence of each installed dependency ===')
for (const n of names.sort()) {
  const p = `node_modules/${n}/package.json`
  if (!existsSync(p)) {
    console.log(`  ${n.padEnd(30)} NOT INSTALLED`)
    continue
  }
  const j = JSON.parse(readFileSync(p, 'utf8'))
  console.log(`  ${n.padEnd(30)} ${String(j.version).padEnd(12)} ${j.license ?? j.licenses ?? '(none)'}`)
}

console.log('')
console.log('=== are the dev-only DOM test deps absent from the packaged output? ===')
const out = globSync('out/**/*', { nodir: false })
  .filter((f) => /\.(js|mjs|cjs|css|html)$/.test(f))
for (const f of out) {
  const text = readFileSync(f, 'utf8')
  for (const probe of ['jsdom', '@testing-library', 'testing-library', 'happy-dom']) {
    if (text.includes(probe)) console.log(`  LEAKED ${probe} in ${f}`)
  }
}
console.log('  (no output above means none of them appear in out/)')
