import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  auditRenderer,
  auditBuildOutputs,
  auditDependencies,
  auditAllowlist,
  blockingManifests,
  vendorTreeExists
} from '../scripts/verify-offline.mjs'

/**
 * Regression test for the OFFLINE BUILD GATE itself (OFFL-1..5, VIS-3).
 *
 * The gate is the thing that fails the build, so the gate needs a test: a fixture that is
 * clean must pass, and each violation the gate is meant to catch must be detected. Without
 * this, a future refactor that weakens the gate would silently allow a CDN to return.
 *
 * The three "REGRESSION" cases below are the shapes a real review executed against the
 * shipped gate and watched PASS. They are the reason this file exists in its current form.
 */

const DESKTOP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

let root
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'mm-offline-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

function write(rel, content) {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content)
}

/** Audit a single-file fixture in its own directory, so findings cannot cross-contaminate. */
function auditOnly(name, content) {
  const dir = mkdtempSync(join(tmpdir(), 'mm-one-'))
  try {
    writeFileSync(join(dir, name), content)
    return auditRenderer(dir).findings
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('offline build gate', () => {
  it('passes a clean bundle with only self-references', () => {
    write('index.html', '<html><head><script src="/assets/app.js"></script></head><body></body></html>')
    write('assets/app.js', 'const x = "/api/local"; // xmlns http://www.w3.org/2000/svg')
    const { findings } = auditRenderer(root)
    expect(findings).toEqual([])
  })

  it('flags a <link> to a CDN (the silent-icon-failure regression)', () => {
    write('cdn.html', '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">')
    const { findings } = auditRenderer(root)
    expect(findings.some((f) => f.rule === 'banned-cdn' || f.rule === 'tag-external-origin')).toBe(true)
  })

  it('flags any absolute external origin in a script', () => {
    write('assets/remote.js', 'const cdn = "https://api.example.com/data";')
    const { findings } = auditRenderer(root)
    expect(findings.some((f) => f.rule === 'external-origin' && f.text.includes('api.example.com'))).toBe(true)
  })

  it('flags a CSS url() pointing off-origin', () => {
    write('assets/styles.css', '.i{background:url(https://cdn.jsdelivr.net/font.woff2)}')
    const { findings } = auditRenderer(root)
    expect(findings.some((f) => f.rule === 'css-url-offsite')).toBe(true)
  })

  it('flags a socket.io reference (OFFL-5) and a ScannerSync reference (VIS-3)', () => {
    write('assets/scan.js', 'import { io } from "socket.io-client"; const s = ScannerSync;')
    const { findings } = auditRenderer(root)
    expect(findings.some((f) => f.rule === 'socket-io-present')).toBe(true)
    expect(findings.some((f) => f.rule === 'scanner-sync-present')).toBe(true)
  })

  it('flags socket.io-client in a package.json dependency tree (OFFL-5)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-pkg-'))
    const p = join(dir, 'package.json')
    writeFileSync(p, JSON.stringify({ dependencies: { 'socket.io-client': '^4.8.3' } }))
    const findings = auditDependencies(p)
    expect(findings.some((f) => f.rule === 'socket-io-dependency')).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('a clean package.json has no dependency findings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-pkg-'))
    const p = join(dir, 'package.json')
    writeFileSync(p, JSON.stringify({ dependencies: { react: '^18.0.0' }, devDependencies: { electron: '44.4.5' } }))
    expect(auditDependencies(p)).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * REGRESSION — the three shapes that got past the shipped gate.
 *
 * Each was executed against the real CLI over a copy of the real out/renderer and PASSED,
 * meaning the build would have shipped it. `wss://` is the exact OFFL-5 relay escape the
 * gate exists to kill: a websocket to a telemetry host is a network call, offline or not.
 */
describe('offline build gate — the three verified bypasses', () => {
  it('REGRESSION: a PROTOCOL-RELATIVE <script src> reaches a CDN', () => {
    // No scheme, so a scheme-anchored regex never matches, and the browser resolves the
    // host from the page's own scheme — which is http over app://, so it really leaves.
    const findings = auditOnly('a.html', '<script src="//cdn.example.com/x.js"></script>')
    expect(findings.some((f) => f.rule === 'tag-protocol-relative')).toBe(true)
  })

  it('REGRESSION: a wss:// relay is a network call and must fail the build', () => {
    const findings = auditOnly('a.js', 'new WebSocket("wss://telemetry.example.com/s")')
    expect(findings.some((f) => f.rule === 'socket-origin')).toBe(true)
  })

  it('REGRESSION: an UPPERCASE scheme is the same request as the lowercase one', () => {
    const findings = auditOnly('a.js', 'fetch("HTTPS://API.EXAMPLE.COM/x")')
    expect(findings.some((f) => f.rule === 'external-origin' && f.text.includes('API.EXAMPLE.COM'))).toBe(true)
  })

  it('REGRESSION: mixed-case and port-less variants are caught too', () => {
    for (const [name, src, rule] of [
      ['a.js', 'new WebSocket("WSS://relay.example.com/s")', 'socket-origin'],
      ['a.js', 'import("https://API.EXAMPLE.COM/mod.js")', 'external-origin'],
      ['a.html', '<img src="//tracker.example.net/p.gif">', 'tag-protocol-relative'],
      ['a.js', 'fetch("//telemetry.example.com/v1")', 'transport-protocol-relative'],
      ['a.js', 'const u = "Ws://relay.example.com/s"', 'socket-origin'],
      ['a.js', 'const S = ScannerSync; const c = "https://CDN.EXAMPLE.COM/x.js"', 'external-origin']
    ]) {
      const findings = auditOnly(name, src)
      expect(findings.some((f) => f.rule === rule), `${src} -> expected ${rule}, got ${findings.map((f) => f.rule)}`).toBe(true)
    }
  })

  it('REGRESSION: a raw-content host is banned on EVERY path, github included', () => {
    // github.com used to be allowlisted while raw.githubusercontent.com was not, so
    // import("https://github.com/u/r/raw/main/x.js") yielded zero findings.
    for (const src of [
      'import("https://github.com/u/r/raw/main/x.js")',
      'const l = "https://raw.githubusercontent.com/u/r/main/x.js";',
      'const n = "https://raw.github.com/u/r/main/x.js";',
      'const g = "https://gist.githubusercontent.com/u/id/raw/x.js";'
    ]) {
      const findings = auditOnly('a.js', src)
      expect(findings.some((f) => f.rule === 'raw-content-host'), `${src} -> ${findings.map((f) => f.rule)}`).toBe(true)
    }
  })

  it('still allows the inert namespace hosts and a PORTED localhost reference', () => {
    // Matching on URL.host (which includes the port) meant localhost:5173 never matched
    // the `localhost` entry; the built main process carries exactly that string.
    for (const src of [
      'const ns = "http://www.w3.org/2000/svg";',
      'const lic = "https://spdx.org/licenses/MIT.html";',
      'const dev = "http://localhost:5173";',
      'const ws = "ws://localhost:5173";',
      'const ip = "http://127.0.0.1:8080/x";'
    ]) {
      expect(auditOnly('a.js', src), src).toEqual([])
    }
  })

  it('allows ONLY RFC 2606 .invalid hosts beyond the inert namespaces', () => {
    // The launch probe's OFFL-1 self-check fires each transport at offline-selfcheck.invalid
    // so the gate would otherwise flag its own test. The exemption is narrow by construction
    // and auditAllowlist() fails the build if anyone widens it to a real host.
    expect(auditOnly('a.js', 'const u = "https://offline-selfcheck.invalid/probe"')).toEqual([])
    expect(auditOnly('a.js', 'const u = "wss://offline-selfcheck.invalid/ws"')).toEqual([])
    expect(auditAllowlist()).toEqual([])
  })

  it('rejects a .invalid host that is NOT the declared self-check host', () => {
    // Narrow means narrow: .invalid is reserved, but a typo'd or invented name is still a
    // finding rather than a silent pass.
    const findings = auditOnly('a.js', 'const u = "https://something-else.invalid/x"')
    expect(findings.some((f) => f.rule === 'external-origin')).toBe(true)
  })

  it('does NOT flag an ordinary line comment as a protocol-relative URL', () => {
    // "//" in a comment is not a request. A naive /(?<![:/])\/\/host\.tld/ would flag
    // every one of these; the rule is anchored to a tag attribute or a transport call.
    for (const src of [
      '/* the app is offline by design */',
      '// cdn.example.com is banned here',
      'const r = a // b',
      "const u = '/api/v1' // relative only"
    ]) {
      expect(auditOnly('a.js', src), src).toEqual([])
    }
  })
})

/**
 * OFFL-5 — the audit used to be hardwired to desktop/package.json, which has zero runtime
 * dependencies. Proving the rule against a synthetic fixture is not proving the rule
 * against the tree that will actually be vendored; these tests do both.
 */
describe('OFFL-5 dependency surface is the real tree, not a synthetic fixture', () => {
  it('the real desktop manifest is clean', () => {
    expect(auditDependencies(blockingManifests(DESKTOP_ROOT))).toEqual([])
  })

  it('blockingManifests includes desktop/package.json and nothing invented', () => {
    const m = blockingManifests(DESKTOP_ROOT)
    expect(m.map((p) => relative(REPO_ROOT, p).replace(sep, '/'))).toEqual(['desktop/package.json'])
  })

  it('the rule FIRES on the real frontend/package.json, which still carries socket.io-client', () => {
    // This is the tree the renderer will be vendored from. Reporting it is the only
    // honest OFFL-5 evidence while nothing is vendored yet — a clean desktop manifest
    // proves nothing on its own.
    const real = join(REPO_ROOT, 'frontend', 'package.json')
    const findings = auditDependencies(real)
    expect(findings.some((f) => f.rule === 'socket-io-dependency' && f.text.includes('socket.io-client'))).toBe(true)
  })

  it('nothing is vendored yet, so frontend/ cannot reach the packaged app (and is reported)', () => {
    expect(vendorTreeExists(DESKTOP_ROOT)).toBe(false)
  })

  it('the gate scans ALL THREE build outputs, not just out/renderer', () => {
    const { byOutput } = auditBuildOutputs('out')
    expect(Object.keys(byOutput).sort()).toEqual(['out/main', 'out/preload', 'out/renderer'])
  })

  it('a built output that does not exist is a finding, not a silent pass', () => {
    const { findings } = auditBuildOutputs(join(root, 'no-such-out'))
    expect(findings.filter((f) => f.rule === 'missing-build')).toHaveLength(3)
  })

  it('a socket.io reference in out/preload is caught, not just in the renderer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-out-'))
    try {
      mkdirSync(join(dir, 'out', 'preload'), { recursive: true })
      // .cjs was not even in TEXT_EXT before, so a preload was not scannable at all.
      writeFileSync(join(dir, 'out', 'preload', 'index.cjs'), 'require("socket.io-client")')
      const { findings } = auditBuildOutputs(join(dir, 'out'))
      expect(findings.some((f) => f.rule === 'socket-io-present')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
