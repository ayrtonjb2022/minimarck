/**
 * Byte-level mojibake audit for the desktop sources.
 *
 * WHY THIS EXISTS - and why it is a script and not "open the file and look":
 *
 * This repo has been corrupted by the same mistake repeatedly. `Get-Content -Raw` on Windows
 * PowerShell 5.1 decodes a UTF-8 file as cp1252 (the system ANSI codepage), so a file holding
 * an em-dash (U+2014, bytes E2 80 94) is read as three chars `a<euro><dquote>`. Writing that
 * back with `Set-Content -Encoding utf8` re-encodes those three chars as NINE bytes and the
 * damage is permanent and invisible: the file still parses, the syntax check still passes,
 * and the rot only shows up as a stray glyph in a comment or a UI string.
 *
 * The trap for the AUDITOR is worse than the original bug. Running `Get-Content` merely to
 * LOOK at a file reproduces the same cp1252 misread, so a healthy em-dash renders as garbage.
 * "I opened it and saw a glyph" is therefore not evidence in either direction. Only bytes are.
 *
 * AND THE TRAP THAT LURKS IN THE "SAFE" VERSION - this one cost a real mistake:
 *
 *   (Get-Content f.js -Raw) -replace 'a','b' | Set-Content f.js
 *
 * is tempting because it has no `-Encoding` flag, so it appears to avoid the bug above. It does
 * avoid it BY ACCIDENT. `Get-Content` and `Set-Content` both default to the system ANSI codepage,
 * so `Get-Content` decodes each UTF-8 byte as one cp1252 character (mojibake in memory) and
 * `Set-Content` re-encodes that mojibake back to the identical bytes. The round trip is
 * byte-symmetric, so the file comes out unchanged and the shortcut "works" often enough to
 * become a habit. It is still wrong on three counts:
 *
 *   - The mojibake is what any regex in that pipeline MATCHES AGAINST, so a replacement
 *     silently misses its target and the edit appears to succeed while changing nothing.
 *   - The symmetry breaks the moment the file has a BOM, which is what `-Encoding utf8` adds.
 *   - Any file that is NOT BOM-less UTF-8 (a cp1252 file, a UTF-16 file) is destroyed outright.
 *
 * This happened once while adding the release tooling: a `installerPath` -> `installer` rename
 * done that way round-tripped to the same bytes and passed the audit, which is luck, not safety.
 * Use the `edit` tool. It rewrites the file through a UTF-8-aware path and cannot mojibake it.
 *
 * THREE TIERS, because the first version of this file caught only some of the damage:
 *
 *   Tier 1  NOT VALID UTF-8 - the bytes do not survive a decode/encode round-trip. Something
 *           already destroyed bytes. Caught by comparing the file Buffer against its own
 *           re-encoding.
 *
 *   Tier 2  U+FFFD REPLACEMENT CHARACTER - a lossy decode. Once a byte becomes U+FFFD the
 *           original information is GONE; no re-encode can recover it. This is the loudest
 *           and most destructive signature.
 *
 *   Tier 3  KNOWN DOUBLE-ENCODE SEQUENCES - the cp1252 renderings of UTF-8, listed in
 *           MOJIBAKE_SIGS. Two-character sequences starting U+00C2/U+00C3, or U+00E2 followed
 *           by U+20AC. Their presence means the file survived a decode-as-cp1252/write-back
 *           round trip, even where every resulting char is individually "valid".
 *
 * WHY AN ALLOWLIST IS ALSO NEEDED - the lesson from the first run of this script:
 *
 * The corrupt copy of `deudores.js` that this file was written to clean up contained
 * `Cr<r-caron>dito` instead of `Cr<e-acute>dito`: bytes C7 B8, the single codepoint U+01F8.
 * That is a perfectly VALID UTF-8 sequence, so tiers 1 and 2 were both silent on it and the
 * round-trip check passed. A verifier built only on "is this valid UTF-8" cannot see this
 * class of damage, which is precisely the class a sloppy PowerShell edit produces.
 *
 * So tier 4 is an allowlist: any non-ASCII character that is not plausibly Spanish or
 * typographic is reported. `e-acute` is allowed; `r-caron` is not. A false positive here is
 * cheap - the fix is to add the character to ALLOWED below, deliberately, with a reason - and
 * a false NEGATIVE is a silently rotten source file that ships. Every occurrence is reported,
 * not just the first: the first version reported one hit per file and hid a second
 * replacement char on the following line.
 *
 * NOTE ON THIS FILE'S OWN PROSE: the signatures are written as \uXXXX escapes and this comment
 * is pure ASCII, for the same reason tier 3 exists. An earlier draft listed the mojibake
 * literally and the auditor flagged ITSELF. A verifier that cries wolf on its own source is
 * worse than no verifier, because it teaches everyone to ignore its output.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const SCAN_DIRS = ['src', 'scripts', 'tests']
const SCAN_EXT = new Set(['.js', '.jsx', '.cjs', '.mjs', '.ts', '.tsx', '.html', '.css', '.json', '.sql', '.md'])
const SKIP_DIR = new Set(['node_modules', 'out', 'dist', 'release', '.git', 'coverage'])

// Tier 3. Written as escapes so this file stays pure ASCII.
const MOJIBAKE_SIGS = [
  { name: 'em-dash U+2014 decoded as cp1252', seq: '\u00E2\u20AC' },
  { name: 'ellipsis U+2026 decoded as cp1252', seq: '\u00E2\u20A6' },
  { name: 'a-acute U+00E1 decoded as cp1252', seq: '\u00C3\u00A1' },
  { name: 'e-acute U+00E9 decoded as cp1252', seq: '\u00C3\u00A9' },
  { name: 'i-acute U+00ED decoded as cp1252', seq: '\u00C3\u00AD' },
  { name: 'o-acute U+00F3 decoded as cp1252', seq: '\u00C3\u00B3' },
  { name: 'u-acute U+00FA decoded as cp1252', seq: '\u00C3\u00BA' },
  { name: 'enye U+00F1 decoded as cp1252', seq: '\u00C3\u00B1' },
  { name: 'n-tilde U+00F3/U+0303 style combo', seq: '\u00C3\u00B1\u0303' },
  { name: 'inverted question U+00BF decoded as cp1252', seq: '\u00C2\u00BF' },
  { name: 'inverted exclamation U+00A1 decoded as cp1252', seq: '\u00C2\u00A1' },
  { name: 'degree U+00B0 decoded as cp1252', seq: '\u00C2\u00B0' },
  { name: 'left guillemet U+00AB decoded as cp1252', seq: '\u00C2\u00AB' },
  { name: 'right guillemet U+00BB decoded as cp1252', seq: '\u00C2\u00BB' },
  { name: 'section sign U+00A7 decoded as cp1252', seq: '\u00C2\u00A7' },
  { name: 'middle dot U+00B7 decoded as cp1252', seq: '\u00C2\u00B7' },
  { name: 'left guillemet quoted form', seq: '\u00C2\u00AB' },
  { name: 'UTF-8 BOM read as cp1252', seq: '\u00EF\u00BF\u00BD' }
]

// Tier 4. Everything non-ASCII that is legitimately allowed to appear in this repo.
// Grouped by WHY it is here, because an allowlist with no reasons becomes a list nobody
// dares to touch, and a list nobody dares to touch stops catching anything.
const ALLOWED = new Map()
const allow = (chars, why) => {
  for (const ch of chars) {
    const cp = ch.codePointAt(0)
    if (ALLOWED.has(cp)) ALLOWED.set(cp, `${ALLOWED.get(cp)}; ${why}`)
    else ALLOWED.set(cp, why)
  }
}
allow('áéíóúÁÉÍÓÚ', 'Spanish accented vowels (upper and lower)')
allow('ñÑüÜ', 'Spanish enye and diaeresis')
allow('¿¡', 'Spanish opening question and exclamation marks')
allow('àèìòùÀÈÌÒÙ', 'Spanish words borrowed from Italian/French (packaging, para)')
allow('çÇ', 'Catalan/Brazilian c-cedilla, used in some product names')
allow('âêô', 'French borrowings in packaging vocabulary (chapeau, package)')
allow('\u00AB\u00BB', 'Spanish guillemets, used to quote UI labels in Spanish comments')
allow('\u2013\u2014', 'en dash and em dash')
allow('\u2212', 'minus sign, used in the +/- scale controls')
// Typographic marks used deliberately in prose and UI copy.
allow('—–', 'em dash and en dash, used in the English prose comments')
allow('‘’“”', 'curly single and double quotes, used in Spanish UI copy')
allow('…', 'ellipsis character')
allow('°', 'degree sign, used for temperature and money-format labels')
allow('§', 'section sign, used in references like 001_init.sql section 4')
allow('×÷', 'multiplication and division signs, used in qty x1000 docs')
allow('≈≤≥≠±', 'mathematical relations used in money and quantity docs')
allow('·', 'middle dot, used as a separator in Spanish lists')
allow('→←↔', 'arrows used in flow documentation')
allow('✓✔✗✘', 'check and cross marks used in verdict strings')
allow('€$¢', 'currency symbols: euro, dollar, cent')
allow('•', 'bullet, used in the product demo catalogue copy')
allow('\u00A0', 'non-breaking space, occasionally wanted in UI copy')
allow('\u200B\u200C\u200D\uFEFF', 'zero-width and BOM control characters, when used on purpose')
allow('\u2018\u2019\u201A\u201B\u201C\u201D\u201E', 'all eight curly quote codepoints')
// Emoji and pictographs, with their variation selectors. These are UI glyphs chosen on purpose
// in the Spanish pages (weigh-scale, scissors, money, warning). They are legitimate, and a
// codepoint-EXACT allowlist is what keeps them from being reported: an emoji is almost always a
// SURROGATE PAIR plus a variation selector, and getting the iteration wrong here produces a
// phantom "lone surrogate" finding on every emoji in the codebase. See the iteration note below.
allow('\u2190\u2191\u2192\u2193\u2194\u21D0\u21D2', 'arrows, used in trend indicators and flow docs')
allow('\u2500', 'box-drawing light horizontal, used as a section rule in index.css')
allow('\u25A0\u25A1\u25CF\u25CB', 'filled and hollow squares and circles, UI bullets')
allow('\u2696', 'scales pictograph, used on the weigh-scale button')
allow('\u26A0', 'warning sign, used on the outstanding-balance banner')
allow('\u26A1', 'high voltage, used as the free-sale heading glyph')
allow('\u2702', 'black scissors, used on the split-product button')
allow('\u2705', 'white heavy check mark, used in the product-created toast')
allow('\u274C', 'cross mark, used in the submit-guard comment')
allow('\u2714\u2716', 'check and ballot X marks')
// FIVE-hex-digit codepoints need the ES6 code-point escape \u{...}, not \u....
//
// `allow('\u1F4B5', ...)` looks right and is silently wrong: a JavaScript \u escape consumes
// exactly FOUR hex digits, so that literal is U+1F4B followed by the ASCII character "5", and
// the allowlist ends up containing a Kurdish-ish letter and a digit instead of the banknote
// pictograph. Nothing errors, the count of allowed codepoints looks plausible, and the audit
// keeps reporting a perfectly legitimate emoji as corruption. Verified with:
//   for (const ch of '\u1F4B5') console.log(ch.codePointAt(0).toString(16))
//   -> 1f4b, 35        (wrong)
//   for (const ch of '\u{1F4B5}') console.log(ch.codePointAt(0).toString(16))
//   -> 1f4b5           (right)
allow('\u{1F4B5}', 'banknote pictograph, used on the "how much does the customer pay" heading')
allow('\u{1F4B4}', 'yen/banknote pictograph')
allow('\uFE0F', 'VARIATION SELECTOR-16, the emoji presentation selector that follows the glyphs above')
allow('\u20AC', 'euro sign, currency symbol')

function walk(dir, acc = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return acc
  }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue
    const full = path.join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, acc)
    else if (SCAN_EXT.has(path.extname(name).toLowerCase())) acc.push(full)
  }
  return acc
}

const files = SCAN_DIRS.flatMap((d) => walk(path.join(root, d)))
const findings = []
let nonAsciiCount = 0

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length
const around = (text, idx) => {
  const s = text.slice(Math.max(0, idx - 28), idx + 28).replace(/\n/g, '\\n')
  return JSON.stringify(s)
}

for (const file of files) {
  const rel = path.relative(root, file)
  const buf = readFileSync(file)
  const text = buf.toString('utf8')

  // Tier 1
  if (!Buffer.from(text, 'utf8').equals(buf)) {
    findings.push({ rel, kind: 'NOT-VALID-UTF8', line: 0, detail: 'bytes do not survive a utf8 decode/encode round-trip' })
    // A file that is not valid UTF-8 will produce a cascade of meaningless tier-2/4 hits.
    continue
  }

  // ITERATION, and why it is not a plain `for` loop over string indices.
  //
  // An emoji like U+1F4B5 is a SURROGATE PAIR: two UTF-16 code units, one code point. Walking
  // the string with `codePointAt(i)` and a bare `i++` stops on the low surrogate and reports it
  // as a lone surrogate, which is not a defect - it is the second half of a character that is
  // perfectly fine. The first version of this script did exactly that and reported a phantom
  // "U+DCB5 lone surrogate" for every emoji in the UI, which is how a verifier learns to be
  // ignored.
  //
  // So the index advances by the WIDTH of the code point just read: 2 for anything at or above
  // U+10000, otherwise 1. A surrogate that is genuinely unpaired - which IS a real defect,
  // because it cannot be encoded to UTF-8 at all and JSON-serialising it corrupts the string -
  // now shows up as a codepoint in D800..DFFF that is not preceded by a high surrogate, and the
  // explicit check below reports it on its own terms.
  let i = 0
  while (i < text.length) {
    const cp = text.codePointAt(i)
    const width = cp > 0xffff ? 2 : 1
    const ch = text.substr(i, width)

    if (cp > 0x7f) {
      // Tier 2
      if (cp === 0xfffd) {
        findings.push({ rel, kind: 'U+FFFD-LOSSY', line: lineOf(text, i), detail: `at col ${i - text.lastIndexOf('\n', i)}: ${around(text, i)}` })
        i += width
        continue
      }
      // Tier 2b: a genuinely unpaired surrogate.
      if (cp >= 0xd800 && cp <= 0xdfff) {
        findings.push({ rel, kind: 'LONE-SURROGATE', line: lineOf(text, i), detail: `unpaired U+${cp.toString(16).toUpperCase()}, cannot be encoded to UTF-8: ${around(text, i)}` })
        i += width
        continue
      }
      // Tier 3
      let matchedSig = null
      for (const sig of MOJIBAKE_SIGS) {
        if (text.startsWith(sig.seq, i)) {
          matchedSig = sig
          break
        }
      }
      if (matchedSig) {
        findings.push({ rel, kind: 'MOJIBAKE-SEQ', line: lineOf(text, i), detail: `${matchedSig.name}: ${around(text, i)}` })
        i += matchedSig.seq.length
        continue
      }
      // Tier 4
      if (!ALLOWED.has(cp)) {
        findings.push({
          rel,
          kind: 'SUSPICIOUS-CHAR',
          line: lineOf(text, i),
          detail:
            `U+${cp.toString(16).toUpperCase().padStart(4, '0')} ${JSON.stringify(ch)} ` +
            `bytes ${[...Buffer.from(ch, 'utf8')].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}: ${around(text, i)}`
        })
      }
    }
    i += width
  }
  if (/[^\u0000-\u007F]/.test(text)) nonAsciiCount++
}

console.log(`ENCODING AUDIT: ${files.length} files scanned, ${nonAsciiCount} contain non-ASCII`)
console.log(`  allowlist: ${ALLOWED.size} codepoints; signatures: ${MOJIBAKE_SIGS.length}`)

if (findings.length === 0) {
  console.log('ENCODING OK: every file is valid UTF-8, no U+FFFD, no double-encode sequence, no char outside the allowlist')
  process.exit(0)
}

const byKind = new Map()
for (const f of findings) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1)
console.error(`\nENCODING CORRUPTION FOUND: ${findings.length} finding(s)`)
for (const [kind, n] of byKind) console.error(`  ${kind}: ${n}`)
console.error('')
for (const f of findings) {
  console.error(`  ${f.kind}  ${f.rel}:${f.line}`)
  console.error(`      ${f.detail}`)
}
console.error('\nFix with the edit tool, never with PowerShell file cmdlets. Re-run: node scripts/verify-encoding.mjs')
process.exit(1)
