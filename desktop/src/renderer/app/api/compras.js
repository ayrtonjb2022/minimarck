import { llamar } from './ipc'

/**
 * Purchases, over IPC.
 *
 * All five contract operations. `crear` is the one the buying screen exists for, and what it sends
 * is deliberately small: a supplier, a payment method, and lines of `{ productoId, cantidad,
 * precioUnitario }`. It does NOT send a total, and it must not — the total is computed in
 * `compras.repo.js` from the lines, because a client that can dictate a total can dictate a stock
 * increase for $0.01.
 *
 * The response is the whole purchase read back from the database: the folio, the state, the
 * payment method the repository DERIVED from the account it credited, the lines as stored, the
 * journal entry, and the drawer movement if the method was cash. The screen redraws from that, so
 * the numbers on screen are the ones in the books rather than a copy of what was typed.
 */
export const comprasAPI = {
  /** Newest first; `estado: 'pendiente'` is the list of what the shop still owes. */
  listar: (params = {}) => llamar('compras', 'list', { limit: 50, ...params }),

  obtener: (compraId) => llamar('compras', 'get', { compraId }),

  /**
   * Register the purchase: stock, moving average, the balanced entry and the cash all in one
   * transaction. Amounts are PESOS and quantities are unit strings, parsed by the same code the
   * sale uses.
   */
  crear: (data) => llamar('compras', 'create', data),

  /** The paper only: `folio` and `observaciones`. The repository refuses the money and the lines. */
  actualizar: (compraId, data) => llamar('compras', 'update', { compraId, ...data }),

  /**
   * Reverse the stock, the cost, the entry and the cash. Refused with a 409 when a LATER purchase
   * already folded its lot into the same product's average cost — cancel in reverse order instead.
   */
  cancelar: (compraId) => llamar('compras', 'cancel', { compraId })
}
