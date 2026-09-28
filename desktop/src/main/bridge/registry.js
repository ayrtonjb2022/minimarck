import { OPS } from '../../shared/ipc-contract.js'
import { IpcError } from './errors.js'

/**
 * The IPC allowlist (SEC-2).
 *
 * `resolve(group, op)` enforces two independent gates before any business code runs:
 *
 *   1. Is `group` a known group AND `op` a member of that group's frozen list?
 *      -> no: UNKNOWN_GROUP / UNKNOWN_OP. This is the gate that makes it impossible for
 *         the renderer to name a table, express SQL, or reach the filesystem: there is
 *         no such channel in the contract, so there is nothing to call.
 *   2. Is a concrete handler registered for that operation in THIS build?
 *      -> no: NOT_IMPLEMENTED (501). S0 registers only the read-only `db.*` stubs; every
 *         other operation is a legitimate contract member whose handler ships in a later
 *         slice, so it is honestly "not implemented in this build", never silently absent.
 *
 * A handler is looked up as `handlers[group][op]`, built once via `register()`. The
 * allowlist check runs first, so a caller can never reach an unregistered function even
 * if one were somehow attached to the registry object.
 */
export function createRegistry() {
  /** group -> { op -> handler(payload, ctx) } */
  const handlers = Object.create(null)

  function register(group, table) {
    for (const [op, fn] of Object.entries(table)) {
      // Registering an op that is not in the frozen contract is a programming error and
      // must fail loudly at startup, not be quietly accepted.
      if (!OPS[group] || !OPS[group].includes(op)) {
        throw new Error(`register: ${group}.${op} is not in the frozen OPS contract`)
      }
      ;(handlers[group] ||= Object.create(null))[op] = fn
    }
  }

  function resolve(group, op) {
    if (!Object.prototype.hasOwnProperty.call(OPS, group)) {
      throw new IpcError('UNKNOWN_GROUP', 400, `Unknown group: ${group}`)
    }
    if (!OPS[group].includes(op)) {
      throw new IpcError('UNKNOWN_OP', 400, `Unknown op: ${group}.${op}`)
    }
    const fn = handlers[group] && handlers[group][op]
    if (!fn) {
      throw new IpcError('NOT_IMPLEMENTED', 501, `${group}.${op} is not implemented in this build`)
    }
    return fn
  }

  /** True when a concrete handler is registered (contract member AND implemented). */
  function isImplemented(group, op) {
    return Boolean(handlers[group] && handlers[group][op])
  }

  return { register, resolve, isImplemented, handlers }
}
