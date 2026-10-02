import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildWebPreferences, resolvePreloadPath } from '../src/main/window.js'
import { buildCsp, assertTrustedSender, isTrustedOrigin, canonicalOrigin } from '../src/main/security.js'
import { resolveBundlePath, rendererUrl, isNavigationRequest, registerAppSchemePrivileges, shellHtmlForRoute } from '../src/main/protocol.js'
import { resolveDataPaths, ensureDataDirs, APP_NAME } from '../src/main/dataDir.js'
import { protocol } from 'electron'
import path from 'node:path'
import { basename } from 'node:path'

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
  const configSrc = readFileSync(new URL('../electron.vite.config.js', import.meta.url), 'utf8')
  const declared = configSrc.match(/entryFileNames:\s*['"]([^'"]+)['"]/)

  it('declares a CommonJS preload output in the build config', () => {
    // The old guard here was `resolvePreloadPath().endsWith('index.cjs')` — one hardcoded
    // literal compared against another in window.js. Delete the whole `output` block from
    // electron.vite.config.js and that test still passed green while the build emitted
    // index.mjs. Reading the config is what makes this a guard instead of a tautology.
    expect(declared, 'electron.vite.config.js must declare preload entryFileNames').toBeTruthy()
    expect(configSrc).toMatch(/format:\s*['"]cjs['"]/)
  })

  it('resolves the preload to the name the build config actually emits', () => {
    // SEC-3 sets sandbox:true, and Electron only supports CommonJS sandboxed preloads.
    // With "type":"module", electron-vite's default output would be .mjs, which would
    // silently yield NO bridge at runtime. `npm run verify:preload` proves the emitted
    // file on disk and `npm run probe:launch` proves the bridge at runtime.
    const expected = declared[1].replace('[name]', 'index')
    expect(expected.endsWith('.cjs')).toBe(true)
    expect(basename(resolvePreloadPath())).toBe(expected)
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

  /**
   * REGRESSION — the prefix-collision shapes.
   *
   * The old predicate was `url.startsWith(DEV_ORIGIN)`. Every URL below starts with the
   * literal text `http://localhost:5173` and every one of them is a DIFFERENT origin, so
   * all three were ACCEPTED in an unpackaged build: the renderer could reach the 89-op IPC
   * contract from `evil.com`, and the shared `will-navigate` guard let it navigate there.
   * These are the three shapes a prefix test cannot distinguish from the real thing.
   */
  it('REGRESSION: a userinfo URL pointing at another host is NOT the dev origin', () => {
    // new URL(...).host === 'evil.com' — the `localhost:5173` is only the userinfo.
    expect(new URL('http://localhost:5173@evil.com/x').host).toBe('evil.com')
    expect(canonicalOrigin('http://localhost:5173@evil.com/x')).toBe('http://evil.com')
    expect(isTrustedOrigin('http://localhost:5173@evil.com/x', false)).toBe(false)
    for (const mode of [false, true]) {
      let code
      try {
        assertTrustedSender('http://localhost:5173@evil.com/x', mode)
      } catch (e) {
        code = e.status
      }
      expect(code, `packaged=${mode}`).toBe(403)
    }
  })

  it('REGRESSION: a subdomain of the dev host is NOT the dev origin', () => {
    // "localhost:5173.evil.com" starts with "localhost:5173" as raw text.
    expect(isTrustedOrigin('http://localhost:5173.evil.com/', false)).toBe(false)
    let code
    try {
      assertTrustedSender('http://localhost:5173.evil.com/', false)
    } catch (e) {
      code = e.status
    }
    expect(code).toBe(403)
  })

  it('REGRESSION: a port-suffixed host is NOT the dev origin', () => {
    // "localhost:5173x" starts with "localhost:5173" as raw text.
    expect(isTrustedOrigin('http://localhost:5173x/', false)).toBe(false)
    let code
    try {
      assertTrustedSender('http://localhost:5173x/', false)
    } catch (e) {
      code = e.status
    }
    expect(code).toBe(403)
  })

  it('REGRESSION: the same shapes on the app:// scheme, where the prefix was tightest', () => {
    // "app://bundle/" only ever matched a literal path, but "app://bundle@evil.com" is a
    // different origin and must not be trusted with the same one-line check.
    for (const bad of ['app://bundle@evil.com/x', 'app://evil/index.html', 'app://BUNDLE/x']) {
      expect(isTrustedOrigin(bad, false), bad).toBe(false)
      expect(isTrustedOrigin(bad, true), bad).toBe(false)
    }
  })

  it('fails closed on an absent, empty or unparseable frame URL', () => {
    // Unparseable or absent -> no origin at all, so there is nothing to compare.
    for (const bad of ['', null, undefined, 0, {}, [], 'not a url', '://nope', 'http://']) {
      expect(canonicalOrigin(bad), String(bad)).toBeNull()
    }
    // Parseable but NOT the trusted origin -> a real origin string that still fails closed.
    for (const bad of [
      'about:blank', 'app://', 'file:///c:/x', 'data:text/html,x', 'chrome://settings', 'javascript:alert(1)'
    ]) {
      expect(canonicalOrigin(bad), String(bad)).not.toBeNull()
    }
    // Every one of them, either way, is untrusted in BOTH modes.
    for (const bad of [
      '', null, undefined, 0, {}, [], 'not a url', '://nope', 'http://',
      'about:blank', 'app://', 'file:///c:/x', 'data:text/html,x', 'chrome://settings', 'javascript:alert(1)'
    ]) {
      expect(isTrustedOrigin(bad, false), String(bad)).toBe(false)
      expect(isTrustedOrigin(bad, true), String(bad)).toBe(false)
      let code
      try {
        assertTrustedSender(bad, true)
      } catch (e) {
        code = e.status
      }
      expect(code, String(bad)).toBe(403)
    }
  })

  it('requires the SCHEME to match, not just the host', () => {
    // https://localhost:5173 is a different origin from http://localhost:5173.
    expect(isTrustedOrigin('https://localhost:5173/', false)).toBe(false)
    expect(isTrustedOrigin('wss://localhost:5173/', false)).toBe(false)
  })

  it('still accepts the dev origin through its legal spellings', () => {
    for (const good of [
      'http://localhost:5173/',
      'http://localhost:5173',
      'http://localhost:5173/reportes?a=1#b',
      'http://LOCALHOST:5173/', // host is case-normalised by the URL parser
      'http://localhost:5173#@evil.com' // the @ is in the FRAGMENT; the host is localhost
    ]) {
      expect(canonicalOrigin(good), good).toBe('http://localhost:5173')
      expect(isTrustedOrigin(good, false), good).toBe(true)
    }
  })

  it('canonicalises the bundle origin to app://bundle, NOT the opaque "null" origin', () => {
    // This is why the check cannot use new URL(u).origin: `app:` is a non-special scheme,
    // so the URL standard reports its origin as the string "null".
    expect(new URL('app://bundle/index.html').origin).toBe('null')
    expect(canonicalOrigin('app://bundle/index.html')).toBe('app://bundle')
    expect(canonicalOrigin('app://bundle/../reportes')).toBe('app://bundle')
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

  it('serves the SPA shell for a route, but 404s a missing asset', () => {
    // A missing /assets/app.js used to be answered with index.html as text/html, which
    // surfaces as a MIME error inside the module loader and reads as a bundler bug. A
    // wrong path should be a wrong path.
    expect(isNavigationRequest('/reportes')).toBe(true)
    expect(isNavigationRequest('/reportes/')).toBe(true)
    expect(isNavigationRequest('/ventas/123')).toBe(true)
    expect(isNavigationRequest('/reportes.html')).toBe(true)
    expect(isNavigationRequest('/')).toBe(true)
    expect(isNavigationRequest('/assets/app-DPCrIakP.js')).toBe(false)
    expect(isNavigationRequest('/assets/styles.css')).toBe(false)
    expect(isNavigationRequest('/favicon.ico')).toBe(false)
  })

  it('serves the SPA shell with root-absolute asset URLs ONLY for a nested route', () => {
    // THE BUG THIS PINS. index.html references its bundle RELATIVELY (`./assets/<hash>.js`),
    // because electron-vite hard-writes `base: './'` for the renderer in production. A relative
    // URL resolves against the document's DIRECTORY, so the very same bytes are only correct
    // when that directory is the scheme root:
    //
    //   app://bundle/reportes        + ./assets/app.js -> app://bundle/assets/app.js         ok
    //   app://bundle/reportes/gastos + ./assets/app.js -> app://bundle/reportes/assets/app.js 404
    //
    // On the second one the bundle 404s, the module never runs, #root stays empty, and there is
    // NO console error: nothing threw, React simply never started. A till sees a white window
    // after a reload. Every deep link the launch probe checks is a SINGLE segment, so it never
    // hit this; multi-segment routes like /reportes/gastos are the whole affected class.
    const shell = [
      '<script type="module" crossorigin src="./assets/index-B6xHv9AO.js"></script>',
      '<link rel="stylesheet" crossorigin href="./assets/index-BGot50dE.css">'
    ].join('\n')

    // A NESTED route gets the rewrite: the bundle must be asked for at the root.
    const nested = shellHtmlForRoute(shell, '/reportes/gastos')
    expect(nested).toContain('src="/assets/index-B6xHv9AO.js"')
    expect(nested).toContain('href="/assets/index-BGot50dE.css"')
    expect(nested).not.toContain('./assets/')

    // The ROOT document is served byte-for-byte, so the packaging gates keep comparing the real
    // build artifact and not a rewritten copy of it.
    expect(shellHtmlForRoute(shell, '/')).toBe(shell)
    expect(shellHtmlForRoute(shell, '/index.html')).toBe(shell)
    // A single-segment route's directory IS the root, so relative already resolves correctly.
    expect(shellHtmlForRoute(shell, '/reportes')).toBe(shell)
    expect(shellHtmlForRoute(shell, '/ventas')).toBe(shell)

    // Depth is not special-cased: any number of segments needs the root.
    const deep = shellHtmlForRoute(shell, '/a/b/c/d')
    expect(deep).toContain('src="/assets/index-B6xHv9AO.js"')

    // Single quotes keep their closing quote: dropping it would emit `src=/assets/a.js'` and
    // turn the repair into broken HTML on the very documents it was meant to fix.
    expect(shellHtmlForRoute("<script src='./assets/a.js'></script>", '/x/y')).toBe(
      '<script src=\'/assets/a.js\'></script>'
    )
    expect(shellHtmlForRoute(Buffer.from(shell), '/x/y')).toContain('src="/assets/')
    expect(shellHtmlForRoute(null, '/x/y')).toBe('null')

    // A Buffer (what readFile hands back without an encoding) works, and an unparseable input
    // is returned untouched rather than mangled.
    expect(shellHtmlForRoute(Buffer.from(shell), '/x/y')).toContain('src="/assets/')
    expect(shellHtmlForRoute(null, '/x/y')).toBe('null')

    // Only the assets directory is rewritten. A relative URL to something else keeps its
    // meaning, so this can never silently repoint an unrelated reference at the scheme root.
    expect(shellHtmlForRoute('<a href="./otra/cosa.html">x</a>', '/x/y')).toBe(
      '<a href="./otra/cosa.html">x</a>'
    )
    // An already-absolute or root-relative reference is left alone.
    expect(shellHtmlForRoute('<script src="/assets/a.js"></script>', '/x/y')).toBe(
      '<script src="/assets/a.js"></script>'
    )
  })

  it('registers app:// as a standard, secure scheme WITHOUT CORS', () => {
    registerAppSchemePrivileges()
    const scheme = protocol.registered.find((s) => s.scheme === 'app')
    expect(scheme).toBeTruthy()
    expect(scheme.privileges.standard).toBe(true)
    expect(scheme.privileges.secure).toBe(true)
    expect(scheme.privileges.supportFetchAPI).toBe(true)
    expect(scheme.privileges.stream).toBe(true)
    // DELIBERATE. corsEnabled:true + supportFetchAPI:true lets any origin loaded in this
    // app read fetch('app://bundle/…') cross-origin. The renderer only ever fetches its
    // own origin, which never consults CORS, so the grant bought nothing.
    expect(scheme.privileges.corsEnabled).toBe(false)
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

  it('names the Electron profile, so it does not resolve to the shared Electron folder', () => {
    // Unpackaged, Electron derives userData from the package name, which put the data in
    // …\AppData\Roaming\Electron\ — the same profile every other Electron app on the
    // machine uses. app.setName(APP_NAME) in main is what fixes it; this asserts the
    // constant main uses, so a rename cannot silently relocate a user's database.
    expect(APP_NAME).toBe('MiniMarck')
    const p = resolveDataPaths(`C:/Users/x/AppData/Roaming/${APP_NAME}`, {})
    expect(p.dataDir).toBe(path.join('C:/Users/x/AppData/Roaming/MiniMarck', 'data'))
    expect(p.dataDir).not.toContain(`${path.sep}Electron${path.sep}`)
  })

  it('CREATES the data directories and they are writable (PLAT-2 is not policy-only)', () => {
    // resolveDataPaths never mkdir'd, so the "Abrir carpeta de datos" menu item had nothing
    // to open and S1's first DatabaseSync() would have been an ENOENT on a path this module
    // had just reported as valid. This writes a real file to prove it.
    const base = mkdtempSync(join(tmpdir(), 'mm-data-'))
    try {
      const p = ensureDataDirs(resolveDataPaths(base, {}))
      expect(existsSync(p.dataDir)).toBe(true)
      expect(existsSync(p.backupDir)).toBe(true)
      writeFileSync(p.dbFile, '')
      expect(existsSync(p.dbFile)).toBe(true)
      // Idempotent: a second call on an existing tree must not throw.
      expect(() => ensureDataDirs(p)).not.toThrow()
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
