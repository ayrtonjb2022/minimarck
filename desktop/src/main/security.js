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
 * The canonical origin of a frame URL: `protocol + '//' + host`.
 *
 * This is NOT `new URL(u).origin`. `app:` is a non-special scheme, so the URL standard
 * gives its origin as the OPAQUE origin, serialized as the string `"null"` — comparing
 * `.origin` would make `BUNDLE_ORIGIN` unmatchable and silently trust nothing (or, if the
 * `"null"` string were compared instead, trust every non-special scheme at once).
 * `protocol` + `host` is the part of a URL that actually decides where the bytes come
 * from, and `host` deliberately EXCLUDES userinfo, so `app://bundle@evil.com/x`
 * canonicalises to `app://evil.com`.
 *
 * Returns `null` for an absent, empty or unparseable URL, so the caller fails closed
 * instead of comparing against a string that happens to be absent.
 */
export function canonicalOrigin(frameUrl) {
  if (typeof frameUrl !== 'string' || frameUrl === '') return null
  try {
    return `${new URL(frameUrl).protocol}//${new URL(frameUrl).host}`
  } catch {
    return null
  }
}

/**
 * SEC-4: is this frame's origin trusted?
 *
 * The check is on the PARSED origin, never on a string prefix. A prefix test is not an
 * origin test: `http://localhost:5173@evil.com/x` starts with `http://localhost:5173` but
 * its host is `evil.com`, and `http://localhost:5173.evil.com/` is a different site
 * entirely. Both were accepted by the old prefix predicate in an unpackaged build, and the
 * `will-navigate` guard shared that predicate, so a renderer could both CALL the 89-op
 * contract and NAVIGATE to an origin it does not own.
 */
export function isTrustedOrigin(frameUrl, isPackaged) {
  const origin = canonicalOrigin(frameUrl)
  if (origin === null) return false
  if (origin === BUNDLE_ORIGIN) return true
  return !isPackaged && origin === DEV_ORIGIN
}

/**
 * SEC-4: every IPC message must come from a trusted origin. Packaged builds accept only
 * `app://bundle`; dev additionally accepts the Vite dev server. Anything else is a 403.
 * The check is on the FRAME URL (senderFrame), so a nested/child frame cannot spoof it.
 */
export function assertTrustedSender(frameUrl, isPackaged) {
  if (!isTrustedOrigin(frameUrl, isPackaged)) {
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
    const fromBundle = isTrustedOrigin(contents.getURL(), true)
    callback(permission === 'media' && fromBundle)
  })
  // No new windows: a renderer-initiated window.open is denied, always.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // No off-origin navigation. This is also what replaces the web's
  // `window.location.href = '/login'` with a real in-app route change.
  // It shares isTrustedOrigin with the IPC sender check on purpose: a prefix test here
  // would let the same `http://localhost:5173@evil.com/x` shape walk away from the
  // bundle while still holding a live IPC channel.
  contents.on('will-navigate', (event, url) => {
    if (!isTrustedOrigin(url, isPackaged)) event.preventDefault()
  })
  // Inject the CSP on EVERY response served in this session (OFFL-2). The header lands on
  // the app:// responses and on any dev-server response alike, because this session is
  // dedicated to the renderer and nothing else is loaded in it.
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
