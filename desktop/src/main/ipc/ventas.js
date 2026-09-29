import { requireTenant } from '../db/seed.js'
import { createCtx } from '../db/ctx.js'
import { crear, listar, obtener } from '../db/repositories/ventas.repo.js'

/**
 * The `ventas.*` handlers, backed by the real database.
 *
 * Three operations, and three is what the frozen contract says: `list`, `get`, `create`. There is
 * no `ventas.cancel` here, and that is a decision rather than an oversight — the frozen contract
 * has 88 operations, `ventas` has three, and adding a fourth would take the design to 89 and
 * invalidate every count in it. The capability exists in the data layer
 * (`ventas.repo.js#cancelar`, covered by tests) so it is ready the moment the contract is
 * amended, and the gap is reported rather than quietly worked around. See `DIVERGENCES.md`.
 *
 * `crear` is the one that matters. It is atomic across the sale, its lines, every stock
 * decrement in thousandths, the till movement and total, the double-entry journal and the audit
 * row — all of it inside one `BEGIN IMMEDIATE` transaction, so a failure at the ninth step rolls
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
     * answer, so a caller that ignores `duplicado` can still tell the difference — and a caller
     * that does not send a key at all gets no protection, which is the web's behaviour too.
     */
    create: (payload, reqCtx) => crear(ctx(reqCtx), payload)
  })

  return registry
}
