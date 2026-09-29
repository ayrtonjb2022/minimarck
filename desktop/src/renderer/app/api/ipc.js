/**
 * The renderer's transport. The ONLY module in the vendored tree that talks to `window.minimarck`.
 *
 * WHY THIS IS NOT AXIOS. The web reached its API over HTTP to a host and a port, so every
 * `api/*.js` module was a thin wrapper around `axios.create({ baseURL })` and every call site
 * unwrapped `response.data.data`. The desktop has no host, no port and no URL: it has
 * `window.minimarck.call(group, op, payload)`, which is an operation name in the frozen 88-op
 * contract and nothing else. So this file does what axios did — send a request, return the
 * result, throw on failure — and returns the RESULT ITSELF.
 *
 * That last choice is the one worth arguing for. Emulating the axios envelope (`{data:{data}}`,
 * `error.response.data.message`) would have left every call site in the vendored pages untouched,
 * which is a smaller diff. It would also have been a lie the next reader has to discover: a
 * renderer that builds a fake HTTP response shape has no URL to report, no status to branch on,
 * and `error.response` implies a server that is not there. The call sites were changed instead,
 * and each change is a line that now says what it actually does.
 *
 * WHAT `call` CANNOT DO, and why that matters here:
 *   - It cannot name a table or express SQL. The contract is a list of (group, op) pairs, and
 *     every op in it was named before this file existed.
 *   - It cannot name a tenant. `negocioId` and `actorId` are filled in by main from the local
 *     identity, never by the frame: a renderer that could pick its own tenant would be a
 *     renderer with admin rights.
 *   - It cannot reach the network. Main resolves every op inside the process; there is no
 *     `XMLHttpRequest` on the path, which is what makes "works offline" a structural property
 *     rather than a promise.
 */

/** The bridge, or a hard failure. Never silently degrade to `undefined`. */
function bridge() {
  const mm = globalThis.minimarck
  if (!mm || typeof mm.call !== 'function') {
    // Throwing at CALL time, not at import time, so a unit test can import this module without
    // a preload. A silent fallback would be worse than the crash: a POS that cannot reach main
    // must fail where the operator can see it.
    throw new Error('minimarck.call no está disponible: el preload no se cargó')
  }
  return mm
}

/**
 * An error from main, carrying the code and the status it was refused with.
 *
 * `code` is the useful half and it is a closed set: `PRODUCTO_NO_ENCONTRADO`,
 * `STOCK_INSUFICIENTE`, `TENANT_REQUIRED`, `NOT_IMPLEMENTED`. The vendored UI branches on it
 * where the branch is real — "this barcode is not in the shop" is a different message from "the
 * shop file has no business" — and falls back to `message` everywhere else.
 */
export class IpcCallError extends Error {
  constructor(code, status, message) {
    super(message || code)
    this.name = 'IpcCallError'
    this.code = code
    this.status = status
  }
}

/** `null` and `undefined` are dropped; empty strings are dropped; `false` and `0` are KEPT. */
function limpiar(params) {
  if (!params) return {}
  const salida = {}
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue
    salida[k] = v
  }
  return salida
}

/**
 * Call one contract operation.
 *
 * @param {string} group  contract group, e.g. `'productos'`
 * @param {string} op     contract operation, e.g. `'findByCode'`
 * @param {object} payload  already in the RENDERER's units (pesos, kg) — main converts to
 *   integer centavos and thousandths on the way in, and this is the boundary the repositories
 *   document. The UI never sends a float it has multiplied by 100.
 * @returns {Promise<*>} the handler's value, unwrapped
 * @throws {IpcCallError} every refusal main makes, with its code and status
 */
export async function llamar(group, op, payload = {}) {
  try {
    return await bridge().call(group, op, payload)
  } catch (err) {
    // Electron wraps a thrown IpcError in its own Error and prefixes the message, keeping the
    // rest as `Error invoking remote method 'minimarck:v1': IpcError: <code>: <message>`. The
    // code and the sentence are both in there, so they are parsed back out rather than shown to
    // the operator as an Electron internal.
    const crudo = err?.message || String(err)
    const coincide = /IpcError:\s*([A-Z_]+)(?::\s*([\s\S]*))?$/.exec(crudo)
    if (coincide) {
      throw new IpcCallError(coincide[1], undefined, (coincide[2] || coincide[1]).trim())
    }
    const status = /status:\s*(\d+)/.exec(crudo)
    throw new IpcCallError(err?.code || 'IPC_ERROR', status ? Number(status[1]) : undefined, crudo)
  }
}

/** The message an operator should see, whatever went wrong. Never a raw transport string. */
export function mensajeDeError(err, porDefecto = 'Ocurrió un error') {
  if (err instanceof IpcCallError && err.message) return err.message
  if (err?.message) return err.message
  return porDefecto
}
