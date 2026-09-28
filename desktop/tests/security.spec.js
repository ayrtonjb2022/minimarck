import { describe, it, expect } from 'vitest'
import { buildWebPreferences, resolvePreloadPath } from '../src/main/window.js'
import { buildCsp, assertTrustedSender } from '../src/main/security.js'
import { resolveBundlePath, rendererUrl } from '../src/main/protocol.js'
import { resolveDataPaths } from '../src/main/dataDir.js'
import path from 'node:path'

/**
 * The main-process trust boundary and offline policy, tested as PURE functions so the
 * guarantees are asserted without launching a window:
 *   SEC-3 window hardening · SEC-4 sender validation · OFFL-2 CSP · OFFL-3 app:// + SPA
 *   fallback + traversal guard · PLAT-2 data location / MINIMARCK_DATA_DIR override.
 */

describe('SEC-3 window hardening', () => {
  const prefs = (packaged) => buildWebPreferences('/preload.js', packaged)

  it('locks down node access in every mode', () => {
    for (const packaged of [true, false]) {
      const p = prefs(packaged)
      expect(p.contextIsolation).toBe(true)
      expect(p.nodeIntegration).toBe(false)
      expect(p.nodeIntegrationInWorker).toBe(false)
      expect(p.nodeIntegrationInSubFrames).toBe(false)
      expect(p.sandbox).toBe(true)
      expect(p.webSecurity).toBe(true)
      expect(p.spellcheck).toBe(false)
    }
  })

  it('enables devTools ONLY when unpackaged', () => {
    expect(prefs(true).devTools).toBe(false)
    expect(prefs(false).devTools).toBe(true)
  })

  it('point preload at the resolved path', () => {
    expect(prefs(true).preload).toBe('/preload.js')
  })
})

describe('build layout contract (the preload must stay CommonJS)', () => {
  it('resolves the preload as .cjs, because a sandboxed preload cannot be ESM', () => {
    // SEC-3 sets sandbox:true, and Electron only supports CommonJS sandboxed preloads.
    // With "type":"module", electron-vite's default output would be .mjs, which would
    // silently yield NO bridge at runtime. `npm run probe:launch` proves it loads.
    expect(resolvePreloadPath().endsWith('index.cjs')).toBe(true)
  })

  it('loads the packaged renderer over app://, and dev over the dev server', () => {
    expect(rendererUrl(true, 'http://localhost:5173/')).toBe('app://bundle/index.html')
    expect(rendererUrl(false, 'http://localhost:5173/')).toBe('http://localhost:5173/')
    // Unpackaged with no dev server still gets the real app:// origin, never file://.
    expect(rendererUrl(false, undefined)).toBe('app://bundle/index.html')
  })
})

describe('SEC-4 sender validation', () => {
  it('accepts the app://bundle origin when packaged', () => {
    expect(assertTrustedSender('app://bundle/index.html', true)).toBe(true)
    expect(assertTrustedSender('app://bundle/reportes', true)).toBe(true)
  })

  it('rejects any non-bundle origin when packaged (403)', () => {
    for (const bad of ['http://evil.com/', 'http://localhost:5173/', 'file:///c:/x', '']) {
      let code
      try {
        assertTrustedSender(bad, true)
      } catch (e) {
        code = e.status
      }
      expect(code, bad).toBe(403)
    }
  })

  it('additionally accepts the dev server only when unpackaged', () => {
    expect(assertTrustedSender('http://localhost:5173/', false)).toBe(true)
    let code
    try {
      assertTrustedSender('http://localhost:5173/', true)
    } catch (e) {
      code = e.status
    }
    expect(code).toBe(403) // rejected when packaged
  })
})

describe('OFFL-2 content security policy', () => {
  const packagedCsp = buildCsp(true)

  it('locks default-src to self', () => {
    expect(packagedCsp).toContain("default-src 'self'")
  })

  it('includes every required directive', () => {
    for (const d of [
      "script-src 'self'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-src 'none'",
      "form-action 'none'"
    ]) {
      expect(packagedCsp, d).toContain(d)
    }
  })

  it('does NOT allow the dev server in a packaged build', () => {
    expect(packagedCsp).not.toContain('localhost:5173')
  })

  it('allows the dev server over http and ws only when unpackaged', () => {
    const devCsp = buildCsp(false)
    expect(devCsp).toContain('http://localhost:5173')
    expect(devCsp).toContain('ws://localhost:5173')
  })
})

describe('OFFL-3 app:// bundle path resolution', () => {
  const root = path.resolve('/bundle')

  it('serves a real file when it exists on disk (no stat needed here)', () => {
    // resolveBundlePath does not touch fs; it returns the candidate absolute path.
    const { status, file } = resolveBundlePath(root, '/assets/app.js')
    expect(status).toBe(200)
    expect(file).toBe(path.join(root, 'assets', 'app.js'))
  })

  it('refuses path traversal (403) — a deep-link cannot escape the bundle root', () => {
    // Raw traversal that has NOT been URL-normalized, which is the real threat.
    for (const attack of ['/../../package.json', '/assets/../../../secret.txt', '/..%2f..%2fpackage.json']) {
      const { status } = resolveBundlePath(root, attack)
      expect(status, attack).toBe(403)
    }
  })

  it('refuses malformed percent-encoding rather than throwing', () => {
    expect(resolveBundlePath(root, '/%E0%A4%A').status).toBe(403)
  })
})

describe('PLAT-2 data location', () => {
  it('defaults the database under the Electron userData path', () => {
    const p = resolveDataPaths('C:/Users/x/AppData/MiniMarck', {})
    expect(p.dbFile).toContain('minimarck.db')
    expect(p.dataDir).toContain('data')
    expect(p.overridden).toBe(false)
  })

  it('MINIMARCK_DATA_DIR relocates ONLY the data base, leaving the profile path untouched', () => {
    const userData = 'C:/Users/x/AppData/MiniMarck'
    const p = resolveDataPaths(userData, { MINIMARCK_DATA_DIR: 'C:/tmp/mmtest' })
    expect(p.overridden).toBe(true)
    // Platform-correct join (win32 uses backslashes), so compare against path.join.
    expect(p.dataDir).toBe(path.join('C:/tmp/mmtest', 'data'))
    expect(p.dbFile).toBe(path.join('C:/tmp/mmtest', 'data', 'minimarck.db'))
    // The Electron profile path is NOT used for data, and is NOT mutated.
    expect(p.base).toBe('C:/tmp/mmtest')
    expect(p.dataDir).not.toContain('AppData')
  })
})
