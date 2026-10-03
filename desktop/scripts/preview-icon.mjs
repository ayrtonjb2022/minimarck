/**
 * Write the 256px mark out as a standalone PNG so it can be LOOKED AT.
 * Verification by inspection: a signed distance function that is subtly wrong still produces a
 * valid PNG, a valid .ico and no error anywhere, and the only way to know the bag is a bag is to
 * see it.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outDir = path.join(root, 'release', 'icon-preview')
mkdirSync(outDir, { recursive: true })

// Re-use the generator's internals by importing the module and reading what it produced is not
// possible (it writes only the .ico), so decode the largest PNG back out of the .ico. That also
// doubles as a check that the .ico I just wrote is structurally readable.
const { readFileSync } = await import('node:fs')
const ico = readFileSync(path.join(root, 'build', 'icon.ico'))
const count = ico.readUInt16LE(4)
let largest = null
for (let i = 0; i < count; i++) {
  const e = 6 + i * 16
  const w = ico[e] === 0 ? 256 : ico[e]
  const size = ico.readUInt32LE(e + 8)
  const off = ico.readUInt32LE(e + 12)
  console.log(`  entry ${i}: ${w}x${w}  ${size} bytes at offset ${off}`)
  if (!largest || w > largest.w) largest = { w, data: ico.subarray(off, off + size) }
}

const out = path.join(outDir, 'icon-256.png')
writeFileSync(out, largest.data)
console.log(`PREVIEW: ${path.relative(root, out)}  (${largest.w}px, ${largest.data.length} bytes)`)
