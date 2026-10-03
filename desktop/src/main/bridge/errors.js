/**
 * A structured, renderer-safe error. Only `{ code, message, status }` ever crosses the
 * IPC boundary — a stack trace never does (SEC-2: an escape attempt returns nothing
 * useful to an attacker).
 */
export class IpcError extends Error {
  constructor(code, status, message) {
    super(message || code)
    this.name = 'IpcError'
    this.code = code
    this.status = status
  }
}

/**
 * Normalize anything thrown inside a handler into an IpcError. A domain error that
 * already carries a code is passed through untouched (design §C.4: a `ROLLBACK` that
 * itself throws must never replace STOCK_INSUFFICIENTE with a raw SQLITE_ERROR), and
 * anything unrecognised becomes a generic INTERNAL so SQLite internals stay in main.
 */
export function toIpcError(err) {
  if (err instanceof IpcError) return err
  if (err && typeof err.code === 'string' && typeof err.status === 'number') {
    return new IpcError(err.code, err.status, err.message)
  }
  // Unknown throwable: log-worthy in main, opaque to the renderer.
  console.error('[ipc] unhandled error in handler:', err)
  return new IpcError('INTERNAL', 500, 'Internal error')
}
