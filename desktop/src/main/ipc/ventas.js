import { requireTenant } from '../db/seed.js'
import { createCtx } from '../db/ctx.js'
import { crear, listar, obtener, cancelar } from '../db/repositories/ventas.repo.js'

/**
 * The `ventas.*` handlers, backed by the real database.
 *
 * Four operations: `list`, `get`, `create`, `cancel`. `cancel` was added to the contract when the
 * cancellation button became reachable in the UI, and it is the fourth member rather than a
 * shortcut around the contract for a reason worth recording: `compras` has carried a `cancel`
 * from the start, and a shop that can void a purchase but not a sale is a shop whose cashier
 * cannot fix a mistake at the till except by editing the database by hand. The data-layer
 * capability (`ventas.repo.js#cancelar`) was already written and tested; what was missing was the
 * last hop.
 *
 * `crear` is the one that matters. It is atomic across the sale, its lines, every stock
 * decrement in thousandths, the till movement and total, the double-entry journal and the audit
 * row �?" all of it inside one `BEGIN IMMEDIATE` transaction, so a failure at the ninth step rolls
 * back the eight before it.
 */
export function registerVentasHandlers(registry, { conn }) {
  const ctx = (reqCtx) => createCtx(conn, reqCtx ?? {})

  registry.register('ventas', {
    list: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return listar(conn.db, reqCtx.negocioId, {
        limit: payload?.limit ?? 20,
        offset: payload?.offset ?? 0,
        estado: payload?.estado ?? null,
        desde: payload?.fechaDesde ?? null,
        hasta: payload?.fechaHasta ?? null
      })
    },

    get: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return obtener(conn.db, reqCtx.negocioId, payload?.id)
    },

    /**
     * Record a sale.
     *
     * The response is the complete sale with its lines, and `duplicado` says whether this call
     * created it. The POS reuses one idempotency key across retries until it gets a definite
     * answer, so a caller that ignores `duplicado` can still tell the difference �?" and a caller
     * that does not send a key at all gets no protection, which is the web's behaviour too.
     */
    create: (payload, reqCtx) => crear(ctx(reqCtx), payload),

    /**
     * Void a recorded sale: the stock goes back on the shelf, the till movement is reversed, the
     * journal gets its mirror entry, and the header is marked `cancelada`. One transaction, and
     * cancelling an already-cancelled sale is refused rather than returning the stock a second
     * time, because a double return is the kind of number that looks plausible and is wrong.
     */
    cancel: (payload, reqCtx) => cancelar(ctx(reqCtx), payload?.id, { motivo: payload?.motivo ?? null })
  })

  return registry
}
