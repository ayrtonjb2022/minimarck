import { protocol } from 'electron'
import path from 'node:path'
import { stat, readFile } from 'node:fs/promises'

/** MIME types for the extensions the bundled renderer actually ships. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8'
}

/**
 * Resolve an `app://bundle/...` pathname to a file on disk (OFFL-3).
 *
 * PURE function (no fs, no electron) so the traversal guard and the SPA fallback are
 * directly unit-testable. Rules:
 *   - decode + strip leading slashes, then join under `root`;
 *   - if the resolved absolute path escapes `root`, return 403 (traversal refused);
 *   - if the path is a real file, serve it;
 *   - otherwise serve `index.html` so `BrowserRouter` deep-links (app://bundle/reportes)
 *     and refreshes work with NO router change.
 *
 * Returns `{ status, file }`; `status` is 200 or 403.
 */
export function resolveBundlePath(root, pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(String(pathname || '/'))
  } catch {
    return { status: 403, file: null } // malformed percent-encoding
  }
  const rel = decoded.replace(/^\/+/, '')
  const abs = path.resolve(root, rel)
  // Containment guard: the resolved path must stay inside root.
  const rootWithSep = path.resolve(root) + path.sep
  if (abs !== path.resolve(root) && !abs.startsWith(rootWithSep)) {
    return { status: 403, file: null }
  }
  return { status: 200, file: abs }
}

/**
 * Does a `app://bundle/...` request that matches no file want the SPA shell, or a 404?
 *
 * A deep link like `app://bundle/reportes` has no extension, and so does a refresh of
 * `app://bundle/reportes.html` — both are the router asking for a document, so both get
 * `index.html`. A missing `app://bundle/assets/app-DPCrIakP.js` is NOT a route: serving it
 * `text/html` turns a wrong path into a MIME error deep in the module loader, which reads
 * as a bundler bug rather than the 404 it is.
 *
 * PURE, so the boundary is unit-testable.
 */
export function isNavigationRequest(pathname) {
  const ext = path.extname(String(pathname || '')).toLowerCase()
  return ext === '' || ext === '.html'
}

/** Must run BEFORE app.whenReady(): mark `app` as a standard, secure scheme. */
export function registerAppSchemePrivileges() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // DELIBERATE: corsEnabled is false. With it true, `corsEnabled: true` +
        // `supportFetchAPI: true` means any origin loaded in this app can read
        // `fetch('app://bundle/…')` cross-origin. The impact is low — `frame-src 'none'`,
        // `will-navigate` is blocked and window.open is denied, so the only origins that
        // can exist are the bundle and the dev server — but the grant buys nothing: the
        // renderer fetches its own origin same-origin, which never consults CORS. Removing
        // an unneeded capability is cheaper than reasoning about whether it is needed.
        corsEnabled: false,
        stream: true
      }
    }
  ])
}

/**
 * The SPA shell, with its asset URLs pinned to the scheme ROOT — only when the route is nested.
 *
 * WHY THIS EXISTS. The SPA fallback serves index.html for any extensionless path, which is what
 * makes BrowserRouter deep links work. But index.html references its bundle RELATIVELY
 * (`./assets/<hash>.js`) — electron-vite hard-writes `base: './'` for the renderer in production,
 * and a `base` set in electron.vite.config.js is silently discarded — and a relative URL resolves
 * against the document's DIRECTORY. So the same bytes are only correct when that directory IS the
 * root:
 *
 *   app://bundle/index.html       + ./assets/app.js  ->  app://bundle/assets/app.js          ok
 *   app://bundle/reportes        + ./assets/app.js  ->  app://bundle/assets/app.js          ok
 *   app://bundle/reportes/gastos + ./assets/app.js  ->  app://bundle/reportes/assets/app.js  404
 *
 * The third line is the whole bug, and it is silent in the worst way: the bundle 404s, the module
 * never executes, `#root` stays empty and there is NO console error, because nothing threw — React
 * simply never ran. On a till that reads as a white screen after a window reload.
 *
 * WHY IT SURVIVED THE GATES. Every deep link the launch probe checks is a SINGLE segment
 * (`/ventas`, `/caja`, ...), and for a single segment the route's directory IS the root, so those
 * all resolve correctly. NAV-3 also navigates client-side inside one document, so the relative URL
 * is never re-resolved at all. The class of route that breaks is a MULTI-segment one —
 * `/reportes/gastos` and every other nested screen in this app — which no existing check loaded
 * as a real document.
 *
 * WHY REWRITE INSTEAD OF `<base href>` OR A CONFIG FLAG. Both were tried first and neither works:
 *  - `<base>` is IGNORED by Chromium here even when it is the first element in `<head>` and even
 *    written as an absolute `app://bundle/`; `document.baseURI` stays the document URL. So the
 *    document cannot be told to change its own base.
 *  - `base` in the build config is overwritten by electron-vite before Vite reads it.
 *
 * So the one place that still has control — the handler that serves the bytes for a ROUTE —
 * rewrites them. `/` and `/index.html` keep the file byte-for-byte: nothing needs changing there,
 * and leaving the built file untouched keeps `verify:bundle` / `verify:package` comparing the real
 * artifact rather than a rewritten copy of it.
 *
 * PURE function of (html, pathname) so the rewrite and its "leave the root alone" rule are
 * unit-testable without Electron.
 */
export function shellHtmlForRoute(html, pathname) {
  const rel = String(pathname || '/').replace(/^\/+/, '')
  // A path with no directory component (`''`, `index.html`, `ventas`) already resolves to the
  // root, so it is served verbatim. Anything else (`reportes/gastos`) needs the rewrite.
  if (!rel.includes('/')) return html
  const source = String(html)
  // The quote character is captured and re-emitted rather than assumed. Rewriting `='./assets/`
  // without carrying the closing quote over would emit `src=/assets/app.js'` and turn the fix
  // into broken HTML on exactly the documents it was meant to repair.
  return source.replace(/(src|href)=(["'])\.\/(assets\/)/g, '$1=$2/$3')
}

/** Resolve the renderer root relative to this file's output dir (out/main -> out/renderer). */
export function resolveRendererRoot() {
  return path.join(__dirname, '..', 'renderer')
}

/**
 * Register the `app` protocol handler (runs after app ready). Serves files from the built
 * renderer root with the SPA fallback. `host` must be `bundle`; anything else is 404.
 */
export function registerAppProtocol(rendererRoot) {
  const root = rendererRoot || resolveRendererRoot()
  const indexHtml = path.join(root, 'index.html')
  protocol.handle('app', async (request) => {
    const { host, pathname } = new URL(request.url)
    if (host !== 'bundle') return new Response('not found', { status: 404 })

    const { status, file } = resolveBundlePath(root, pathname)
    if (status === 403) return new Response('forbidden', { status: 403 })

    const info = await stat(file).catch(() => null)
    if (!info || !info.isFile()) {
      // SPA fallback for a route; a 404 for a missing asset, so a wrong path is a wrong
      // path and not a MIME error inside the module loader.
      if (!isNavigationRequest(pathname)) return new Response('not found', { status: 404 })
      const shell = await readFile(indexHtml, 'utf8')
      return new Response(shellHtmlForRoute(shell, pathname), {
        headers: { 'content-type': MIME['.html'] }
      })
    }
    const body = await readFile(file)
    return new Response(body, {
      headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' }
    })
  })
  return root
}

/** The dev-server URL when unpackaged (electron-vite default), else the bundle origin. */
export function rendererUrl(isPackaged, devServerUrl) {
  return isPackaged ? 'app://bundle/index.html' : devServerUrl || 'app://bundle/index.html'
}
