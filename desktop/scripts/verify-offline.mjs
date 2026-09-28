/**
 * OFFLINE BUILD GATE (OFFL-1..5, VIS-3) — design §B.3.
 *
 * The packaged app must make ZERO outbound requests. Today a forgotten CDN <link> would
 * make the icon system silently vanish with no error, so this gate FAILS the build on any
 * external origin in the built renderer, and the CSP turns a regression loud instead of
 * silent. It also greps for the removed remote-scanner code (OFFL-5, VIS-3).
 *
 * Run directly (`npm run verify:offline`) or import `auditRenderer` in a test.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, extname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Hosts allowed to appear in the built output (namespaces, licences, local dev). */
const ALLOWED_EXTERNAL_HOSTS = new Set([
  'www.w3.org',
  'purl.org',
  'spdx.org',
  'opensource.org',
  'github.com',
  'creativecommons.org',
  'localhost',
  '127.0.0.1'
])

/** The CDN hosts the web app used that must NOT appear (design §B.3). */
const BANNED_CDN_HOSTS = ['fonts.googleapis.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com']

const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.map'])
const SKIP_DIR = new Set(['node_modules', '.git'])

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/**
 * Audit a built renderer directory. Returns { findings, scanned }.
 * Each finding: { rule, file, line, text }.
 */
export function auditRenderer(rootDir) {
  const findings = []
  if (!existsSync(rootDir)) {
    return { findings: [{ rule: 'missing-build', file: rootDir, line: 0, text: 'built renderer not found' }], scanned: 0 }
  }
  const files = walk(rootDir).filter((f) => TEXT_EXT.has(extname(f).toLowerCase()))

  for (const file of files) {
    const rel = relative(rootDir, file)
    const text = readFileSync(file, 'utf8')
    text.split(/\r?\n/).forEach((line, i) => {
      // Rule: any absolute http(s) URL to a non-allowed host.
      for (const m of line.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
        const host = hostOf(m[0])
        if (host && !ALLOWED_EXTERNAL_HOSTS.has(host)) {
          findings.push({ rule: 'external-origin', file: rel, line: i + 1, text: m[0] })
        }
      }
      // Rule: the four specific CDN hosts, wherever they appear.
      for (const bad of BANNED_CDN_HOSTS) {
        if (line.includes(bad)) findings.push({ rule: 'banned-cdn', file: rel, line: i + 1, text: bad })
      }
      // Rule: a <link>/<script>/<img> tag pointing at an absolute external origin.
      for (const m of line.matchAll(/<(?:link|script|img)\b[^>]*?\b(?:href|src)\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi)) {
        findings.push({ rule: 'tag-external-origin', file: rel, line: i + 1, text: m[1] })
      }
      // Rule: a CSS url() pointing off-origin.
      for (const m of line.matchAll(/url\(\s*['"]?(https?:\/\/[^)'"\s]+)/gi)) {
        findings.push({ rule: 'css-url-offsite', file: rel, line: i + 1, text: m[1] })
      }
      // Rule: the removed remote-scanner relay must not be in the copy (OFFL-5, VIS-3).
      if (/socket\.io-client|from ['"]socket\.io/.test(line)) {
        findings.push({ rule: 'socket-io-present', file: rel, line: i + 1, text: 'socket.io reference' })
      }
      if (/ScannerSync/.test(line)) {
        findings.push({ rule: 'scanner-sync-present', file: rel, line: i + 1, text: 'ScannerSync reference' })
      }
    })
  }
  return { findings, scanned: files.length }
}

/** OFFL-5: socket.io-client must be absent from the production dependency tree. */
export function auditDependencies(packageJsonPath) {
  const findings = []
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  for (const field of ['dependencies', 'devDependencies']) {
    for (const [name, ver] of Object.entries(pkg[field] || {})) {
      if (name === 'socket.io-client') {
        findings.push({ rule: 'socket-io-dependency', file: 'package.json', line: 0, text: `${field}.${name}@${ver}` })
      }
    }
  }
  return findings
}

// CLI entry
if (process.argv[1] && process.argv[1].endsWith('verify-offline.mjs')) {
  const root = process.argv[2] || 'out/renderer'
  // fileURLToPath, not URL.pathname: on Windows pathname is "/C:/..." which is not a
  // real path and throws ENOENT.
  const pkg = fileURLToPath(new URL('../package.json', import.meta.url))
  const { findings, scanned } = auditRenderer(root)
  findings.push(...auditDependencies(pkg))
  console.log(`verify:offline — scanned ${scanned} text file(s) under ${root}`)
  if (findings.length === 0) {
    console.log('verify:offline — PASS: no external origin, no CDN, no socket.io, no ScannerSync.')
    process.exit(0)
  } else {
    console.error(`verify:offline — FAIL: ${findings.length} finding(s):`)
    for (const f of findings) console.error(`  [${f.rule}] ${f.file}:${f.line} ${f.text}`)
    process.exit(1)
  }
}
