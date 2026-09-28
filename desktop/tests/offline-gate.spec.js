import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditRenderer, auditDependencies } from '../scripts/verify-offline.mjs'

/**
 * Regression test for the OFFLINE BUILD GATE itself (OFFL-1..5, VIS-3).
 *
 * The gate is the thing that fails the build, so the gate needs a test: a fixture that is
 * clean must pass, and each violation the gate is meant to catch must be detected. Without
 * this, a future refactor that weakens the gate would silently allow a CDN to return.
 */

let root
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'mm-offline-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

function write(rel, content) {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content)
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
