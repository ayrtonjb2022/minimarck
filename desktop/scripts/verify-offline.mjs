/**
 * OFFLINE BUILD GATE (OFFL-1..5, VIS-3) — design §B.3.
 *
 * The packaged app must make ZERO outbound requests. Today a forgotten CDN <link> would
 * make the icon system silently vanish with no error, so this gate FAILS the build on any
 * external origin in ANY of the three build outputs, and the CSP turns a regression loud
 * instead of silent. It also greps for the removed remote-scanner code (OFFL-5, VIS-3).
 *
 * WHAT THIS GATE IS NOT — read before trusting a PASS.
 * This is a TEXT SCAN over the built output. It cannot see a URL assembled at runtime
 * (`fetch('//' + host + p)`), a base64 blob decoded into a `<script>`, or a payload
 * fetched and eval'd from data. No regex over static text can. What it CAN do is make the
 * accidental case impossible: a copy-pasted `<script src>`, a stray `import`, a leftover
 * socket.io reference, an uppercase scheme someone retyped. The documented backstop for
 * everything else is the CSP (`script-src 'self'`, `connect-src 'self'`, `object-src
 * 'none'`) plus `sandbox:true` in the renderer, which blocks those requests at runtime
 * whether or not this file ever saw them. Neither control alone is sufficient; together
 * they are: the gate stops the accident, the CSP stops the adversary.
 *
 * Run directly (`npm run verify:offline`) or import the audit functions in a test.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, extname, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Hosts allowed to appear in the built output: inert identifier namespaces (XML/XHTML
 * namespace URIs, SPDX and licence URLs) and local dev. None of them serves executable
 * content, which is the only property this allowlist cares about.
 */
const ALLOWED_EXTERNAL_HOSTS = new Set([
  'www.w3.org',
  'purl.org',
  'spdx.org',
  'opensource.org',
  'creativecommons.org',
  'localhost',
  '127.0.0.1'
])

/**
 * Content hosts that must NEVER appear, whatever the path. github.com is here and NOT in
 * the allowlist because `https://github.com/u/r/raw/main/x.js` is a raw-content endpoint
 * that 302s to raw.githubusercontent.com, and `import()` of it is real remote code. An
 * earlier version allowlisted `github.com` while leaving `raw.githubusercontent.com` out,
 * which is the inconsistency this table removes: both are raw-content hosts, so both are
 * banned on every path. Licence and NOTICE text lives in VENDORED.md, not in the bundle.
 */
const BANNED_RAW_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'raw.githubusercontent.com',
  'raw.github.com',
  'gist.github.com',
  'gist.githubusercontent.com',
  'codeload.github.com'
])

/** The CDN hosts the web app used that must NOT appear (design §B.3). */
const BANNED_CDN_HOSTS = ['fonts.googleapis.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com']

const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.cjs', '.css', '.json', '.svg', '.map'])
const SKIP_DIR = new Set(['node_modules', '.git'])

/**
 * The HOSTNAME of a URL, with the port stripped and the case folded.
 *
 * `URL.host` includes the port, so `http://localhost:5173` yielded `localhost:5173`, which
 * never matched the `localhost` allowlist entry — the dev-server references in the built
 * main process only avoided a confusing build failure by not being there yet. Match on
 * `hostname`: an allowlist entry is a site, and a site is a hostname.
 */
function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase()
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
 * Audit one built output directory. Returns { findings, scanned }.
 * Each finding: { rule, file, line, text }.
 */
export function auditRenderer(rootDir) {
  const findings = []
  if (!existsSync(rootDir)) {
    return { findings: [{ rule: 'missing-build', file: rootDir, line: 0, text: 'built output not found' }], scanned: 0 }
  }
  const files = walk(rootDir).filter((f) => TEXT_EXT.has(extname(f).toLowerCase()))

  for (const file of files) {
    const rel = relative(rootDir, file)
    const text = readFileSync(file, 'utf8')
    text.split(/\r?\n/).forEach((line, i) => {
      const at = (rule, hit) => findings.push({ rule, file: rel, line: i + 1, text: hit })

      // Rule: any absolute http(s)/ws(s) URL to a host that is not allowlisted.
      // `i` because `fetch("HTTPS://API.EXAMPLE.COM/x")` is the same request as the
      // lowercase form and the earlier lowercase-only regex waved it through.
      for (const m of line.matchAll(/\b(?:https?|wss?):\/\/[^\s"'`)\\]+/gi)) {
        const host = hostnameOf(m[0])
        if (!host) continue
        if (BANNED_RAW_HOSTS.has(host)) at('raw-content-host', m[0])
        else if (!ALLOWED_EXTERNAL_HOSTS.has(host)) at(/^wss?:/i.test(m[0]) ? 'socket-origin' : 'external-origin', m[0])
      }
      // Rule: the four specific CDN hosts, wherever they appear, in any case.
      for (const bad of BANNED_CDN_HOSTS) {
        if (line.toLowerCase().includes(bad)) at('banned-cdn', bad)
      }
      // Rule: a <link>/<script>/<img> tag pointing at an absolute external origin.
      for (const m of line.matchAll(/<(?:link|script|img|iframe|audio|video|source|embed|track|object)\b[^>]*?\b(?:href|src|data|action|poster)\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi)) {
        at('tag-external-origin', m[1])
      }
      // Rule: PROTOCOL-RELATIVE url in a tag attribute. `src="//cdn.example.com/x.js"`
      // has no scheme for a scheme-anchored regex to find, so it reaches a CDN anyway.
      for (const m of line.matchAll(/<(?:link|script|img|iframe|audio|video|source|embed|track|object)\b[^>]*?\b(?:href|src|data|action|poster)\s*=\s*["']\/\/[^"'\s>]+/gi)) {
        at('tag-protocol-relative', m[0].slice(m[0].indexOf('//')))
      }
      // Rule: PROTOCOL-RELATIVE url handed to a transport that will fetch it.
      for (const m of line.matchAll(/\b(?:fetch|open|send|WebSocket|EventSource|importScripts|import)\s*\(?\s*["']\/\/[^"'\s)]*/g)) {
        at('transport-protocol-relative', m[0])
      }
      // Rule: a CSS url() pointing off-origin.
      for (const m of line.matchAll(/url\(\s*['"]?(https?:\/\/[^)'"\s]+)/gi)) {
        at('css-url-offsite', m[1])
      }
      // Rule: the removed remote-scanner relay must not be in the copy (OFFL-5, VIS-3).
      if (/socket\.io-client|from ['"]socket\.io/i.test(line)) at('socket-io-present', 'socket.io reference')
      if (/scannersync/i.test(line)) at('scanner-sync-present', 'ScannerSync reference')
    })
  }
  return { findings, scanned: files.length }
}

/**
 * Every build output electron-vite emits, relative to the `out` dir. All three are
 * scanned, not just the renderer — VENDORED.md used to claim "anywhere in the built
 * output" while `auditRenderer('out/main')` and `auditRenderer('out/preload')` were
 * never called.
 */
export const BUILD_OUTPUTS = ['renderer', 'main', 'preload']

/** Audit all three build outputs under `outDir` (default `out`). */
export function auditBuildOutputs(outDir = 'out') {
  const byOutput = {}
  const findings = []
  let scanned = 0
  for (const name of BUILD_OUTPUTS) {
    const r = auditRenderer(join(outDir, name))
    byOutput[`out/${name}`] = r.scanned
    scanned += r.scanned
    findings.push(...r.findings)
  }
  return { findings, scanned, byOutput }
}

/**
 * OFFL-5: socket.io-client must be absent from every manifest whose dependencies can
 * reach the packaged app. Accepts a single path or a list.
 */
export function auditDependencies(manifestPaths) {
  const paths = Array.isArray(manifestPaths) ? manifestPaths : [manifestPaths]
  const findings = []
  for (const manifestPath of paths) {
    if (!existsSync(manifestPath)) {
      findings.push({ rule: 'missing-manifest', file: manifestPath, line: 0, text: 'package.json not found' })
      continue
    }
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
    for (const field of ['dependencies', 'devDependencies']) {
      for (const [name, ver] of Object.entries(pkg[field] || {})) {
        if (name === 'socket.io-client') {
          findings.push({ rule: 'socket-io-dependency', file: manifestPath, line: 0, text: `${field}.${name}@${ver}` })
        }
      }
    }
  }
  return findings
}

/**
 * The manifests that BLOCK the build: the desktop package itself, plus every package.json
 * under `desktop/vendor/` once vendoring exists. `desktop/package.json` has zero runtime
 * dependencies today, which is only meaningful because the vendored copies are audited
 * here too — an empty tree proves nothing on its own.
 */
export function blockingManifests(desktopRoot) {
  const out = [join(desktopRoot, 'package.json')]
  const vendor = join(desktopRoot, 'vendor')
  if (existsSync(vendor)) {
    for (const p of walk(vendor)) if (basename(p) === 'package.json') out.push(p)
  }
  return out
}

/** Has anything been vendored yet? Until this is true, frontend/ cannot reach the app. */
export function vendorTreeExists(desktopRoot) {
  return existsSync(join(desktopRoot, 'vendor'))
}

// CLI entry
if (process.argv[1] && process.argv[1].endsWith('verify-offline.mjs')) {
  // Accept either the `out` dir or, for backwards compatibility with the old CLI, the
  // `out/renderer` path it used to default to.
  const arg = process.argv[2] || 'out'
  const outDir = /(^|[\\/])renderer$/.test(arg) ? arg.replace(/[\\/]renderer$/, '') : arg
  // fileURLToPath, not URL.pathname: on Windows pathname is "/C:/..." which is not a
  // real path and throws ENOENT.
  const here = fileURLToPath(new URL('.', import.meta.url))
  const desktopRoot = join(here, '..')

  const { findings, scanned, byOutput } = auditBuildOutputs(outDir)
  const blocking = blockingManifests(desktopRoot)
  const vendored = vendorTreeExists(desktopRoot)
  // Once anything is vendored, the tree it was vendored FROM becomes a blocking manifest:
  // that is when frontend/'s dependency list can actually reach the packaged app.
  if (vendored) blocking.push(join(desktopRoot, '..', 'frontend', 'package.json'))
  findings.push(...auditDependencies(blocking))

  // The tree the renderer will be vendored FROM. Reported on every run. It only blocks
  // once desktop/vendor/ exists, because before that nothing in it can reach the app —
  // and silently ignoring it is exactly how OFFL-5 was previously marked satisfied on
  // evidence that proved nothing.
  const sourceManifest = join(desktopRoot, '..', 'frontend', 'package.json')
  const srcHits = auditDependencies(sourceManifest).filter((f) => f.rule === 'socket-io-dependency')

  console.log(`verify:offline — scanned ${scanned} text file(s) across all three build outputs:`)
  for (const [rel, n] of Object.entries(byOutput)) console.log(`  ${rel.padEnd(14)} ${n} text file(s)`)
  console.log('verify:offline — dependency surface:')
  for (const m of blocking) {
    const hits = auditDependencies(m).length
    console.log(`  BLOCKING  ${relative(join(desktopRoot, '..'), m).padEnd(26)} ${hits} finding(s)`)
  }
  console.log(`  ${vendored ? 'BLOCKING' : 'REPORTED'}  ${'frontend/package.json'.padEnd(26)} ${srcHits.length} socket.io finding(s)`)
  if (!vendored) {
    console.log('    ^ reported, not blocking: desktop/vendor/ does not exist, so no frontend')
    console.log('      dependency can reach the packaged app. The moment anything is vendored,')
    console.log('      frontend/package.json joins the blocking set and this gate fails.')
  }

  if (findings.length === 0) {
    console.log('verify:offline — PASS: no external origin, no raw-content host, no CDN, no socket.io, no ScannerSync.')
    process.exit(0)
  } else {
    console.error(`verify:offline — FAIL: ${findings.length} finding(s):`)
    for (const f of findings) console.error(`  [${f.rule}] ${f.file}:${f.line} ${f.text}`)
    process.exit(1)
  }
}
