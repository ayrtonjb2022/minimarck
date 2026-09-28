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
      const shell = await readFile(indexHtml)
      return new Response(shell, { headers: { 'content-type': MIME['.html'] } })
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
