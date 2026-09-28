/**
 * Main-process security policy: the CSP, the trusted-sender check, and the per-webContents
 * lockdown. These back OFFL-2, SEC-3 and SEC-4.
 */

/** The scheme the renderer is served from. `app://bundle/...` is the only bundled origin. */
export const BUNDLE_ORIGIN = 'app://bundle'
/** The Vite dev-server origin, accepted ONLY when unpackaged. */
export const DEV_ORIGIN = 'http://localhost:5173'

/**
 * Build the Content-Security-Policy (OFFL-2). `default-src` is `'self'`; in a packaged
 * build the policy is locked to the bundle origin. In dev it additionally allows the
 * Vite dev server over http/ws so hot reload works. Returns the full header string.
 */
export function buildCsp(isPackaged) {
  const connect = ["'self'", ...(isPackaged ? [] : ['http://localhost:5173', 'ws://localhost:5173'])]
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "form-action 'none'"
  ].join('; ')
}

/**
 * SEC-4: every IPC message must come from a trusted origin. Packaged builds accept only
 * `app://bundle/`; dev additionally accepts the Vite dev server. Anything else is a 403.
 * The check is on the FRAME URL (senderFrame), so a nested/child frame cannot spoof it.
 */
export function assertTrustedSender(frameUrl, isPackaged) {
  const url = String(frameUrl || '')
  const trusted = isPackaged
    ? url.startsWith(BUNDLE_ORIGIN + '/')
    : url.startsWith(BUNDLE_ORIGIN + '/') || url.startsWith(DEV_ORIGIN)
  if (!trusted) {
    const err = new Error('Untrusted IPC sender')
    err.code = 'FORBIDDEN'
    err.status = 403
    throw err
  }
  return true
}

/**
 * SEC-3 / OFFL-2 hardening applied to EVERY webContents via `app.on('web-contents-created')`,
 * so a window created later in the app cannot escape the policy. Denies all permission
 * requests (media only, and only for the bundle origin), blocks popup windows, and blocks
 * off-origin navigation (`window.location.href = '/login'` under `app://` is exactly the
 * move this stops).
 */
export function applyWebContentsSecurity(contents, session, isPackaged) {
  // Deny every permission request except media from the bundle origin.
  contents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    const fromBundle = String(contents.getURL() || '').startsWith(BUNDLE_ORIGIN + '/')
    callback(permission === 'media' && fromBundle)
  })
  // No new windows: a renderer-initiated window.open is denied, always.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // No off-origin navigation. This is also what replaces the web's
  // `window.location.href = '/login'` with a real in-app route change.
  contents.on('will-navigate', (event, url) => {
    const ok = isPackaged
      ? url.startsWith(BUNDLE_ORIGIN + '/')
      : url.startsWith(BUNDLE_ORIGIN + '/') || url.startsWith(DEV_ORIGIN)
    if (!ok) event.preventDefault()
  })
  // Inject the CSP on every response from the bundle origin (OFFL-2).
  if (session) {
    session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [buildCsp(isPackaged)]
        }
      })
    })
  }
}
