import { createCtx } from '../db/ctx.js'
import { requireTenant } from '../db/seed.js'
import {
  listar as listarCompras,
  obtener as obtenerCompra,
  crear as crearCompra,
  actualizar as actualizarCompra,
  cancelar as cancelarCompra
} from '../db/repositories/compras.repo.js'

/**
 * The `compras.*` handlers. All five.
 *
 * `create` is the one that matters: it takes a supplier, one or many lines and a payment method,
 * and inside ONE transaction it writes the purchase, adds the stock, folds each lot into the
 * product's moving average, records the trace of both, posts a balanced journal entry, and takes
 * the money out of the drawer when the method is cash. The renderer sends a price and a quantity
 * and receives back a purchase it can print.
 *
 * `list`, `get` and `update` are thin on purpose. `update` refuses the money-bearing fields in the
 * repository, because a purchase whose goods have arrived is not re-costable: correct the items by
 * cancelling and re-registering, which is the operation that reverses the stock, the cost, the
 * entry and the drawer together.
 *
 * `cancel` is reachable and exact when it can be. A MOVING AVERAGE CANNOT BE INVERTED, so a
 * purchase that a later purchase already folded into a product's cost is refused with a message
 * telling the operator to cancel in reverse order — which always works. The exactness argument, and
 * the `auditoria` snapshot that buys it, are in `compras.repo.js`.
 */
export function registerComprasHandlers(registry, { conn }) {
  const ctx = (reqCtx) => createCtx(conn, reqCtx ?? {})

  registry.register('compras', {
    /**
     * Purchases newest first, searchable by folio or supplier name, filterable by `estado` and by
     * `proveedorId`. `estado: 'pendiente'` is the list of what the shop OWES: a credit purchase is
     * recorded as pending, which is the one thing the web's purchases can never be, because the web
     * records every purchase as `completada`.
     */
    list: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return listarCompras(ctx(reqCtx), {
        search: payload?.search ?? '',
        estado: payload?.estado,
        proveedorId: payload?.proveedorId,
        limit: payload?.limit ?? 50,
        offset: payload?.offset ?? 0
      })
    },

    /** One purchase with its lines, its journal entry and its drawer movement, if it had one. */
    get: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return obtenerCompra(ctx(reqCtx), payload?.compraId ?? payload?.id)
    },

    /**
     * Register the purchase. `items` are `{ productoId, cantidad, precioUnitario }` in the
     * renderer's language: quantities as thousandths strings, money as pesos strings. Everything
     * else — the total, the stock, the new average cost, the account, the drawer — is computed in
     * the repository and never accepted from here.
     */
    create: (payload, reqCtx) => crearCompra(ctx(reqCtx), payload),

    /** The paper: folio and notes. The money and the goods are refused, in the repository. */
    update: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return actualizarCompra(ctx(reqCtx), payload?.compraId ?? payload?.id, payload ?? {})
    },

    /** Reverse the stock, the cost, the journal entry and the cash — or refuse, and say why. */
    cancel: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return cancelarCompra(ctx(reqCtx), payload?.compraId ?? payload?.id)
    }
  })

  return registry
}
