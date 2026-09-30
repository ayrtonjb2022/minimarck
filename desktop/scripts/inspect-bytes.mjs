/**
 * Print the exact bytes around a suspicious character. Diagnostic aid for encoding damage.
 * Usage: node scripts/inspect-bytes.mjs <file-relative-to-desktop> <line> [column]
 *
 * Exists because "it looks wrong" and "it is wrong" are different claims, and only the second
 * one can be acted on. On a cp1252-1252 misread a perfectly healthy em-dash LOOKS like three
 * garbage characters, so eyeballing a file is not evidence in either direction.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const [rel, lineNo, colNo] = process.argv.slice(2)
if (!rel || !lineNo) {
  console.error('usage: node scripts/inspect-bytes.mjs <file> <line> [column]')
  process.exit(2)
}

const file = path.resolve(root, rel)
const text = readFileSync(file, 'utf8')
const lines = text.split('\n')
const line = Number(lineNo)
const target = lines[line - 1]
if (target === undefined) {
  console.error(`${rel} has no line ${line} (it has ${lines.length})`)
  process.exit(2)
}

console.log(`FILE  ${rel}  line ${line}`)
console.log(`TEXT  ${JSON.stringify(target)}`)

// Code points above ASCII on this line, with their codepoint and UTF-8 bytes.
//
// The index advances by the WIDTH of the code point, not by 1. An emoji is a surrogate PAIR,
// and a bare i++ would stop on its low surrogate and report it as a defect when the file is
// fine. See the same note in verify-encoding.mjs.
const interesting = []
let i = 0
while (i < target.length) {
  const cp = target.codePointAt(i)
  const width = cp > 0xffff ? 2 : 1
  if (cp > 0x7f) {
    const ch = target.substr(i, width)
    interesting.push({
      char: ch,
      index: i,
      codepoint: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'),
      bytes: [...Buffer.from(ch, 'utf8')].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')
    })
  }
  i += width
}
if (interesting.length === 0) console.log('NON-ASCII  none on this line')
for (const it of interesting) {
  const at = colNo && Number(colNo) === it.index + 1 ? '   <-- requested column' : ''
  console.log(`  col ${String(it.index + 1).padStart(3)}  ${it.codepoint}  ${it.bytes.padEnd(8)}  ${JSON.stringify(it.char)}${at}`)
}

// Also dump the raw bytes of the whole line, for when the line is what needs checking.
const lineBytes = Buffer.from(target, 'utf8')
console.log(`LINE BYTES (${lineBytes.length}): ${lineBytes.toString('hex').match(/../g).join(' ')}`)
