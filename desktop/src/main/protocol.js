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

/** Must run BEFORE app.whenReady(): mark `app` as a standard, secure scheme. */
export function registerAppSchemePrivileges() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
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
    const target = info && info.isFile() ? file : indexHtml // SPA fallback
    const body = await readFile(target)
    return new Response(body, {
      headers: { 'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream' }
    })
  })
  return root
}

/** The dev-server URL when unpackaged (electron-vite default), else the bundle origin. */
export function rendererUrl(isPackaged, devServerUrl) {
  return isPackaged ? 'app://bundle/index.html' : devServerUrl || 'app://bundle/index.html'
}
