import { createCtx } from '../db/ctx.js'
import { requireTenant } from '../db/seed.js'
import { buscarPorCodigo, crear, listar, obtener, actualizar, eliminar } from '../db/repositories/productos.repo.js'

/**
 * The `productos.*` handlers, backed by the real database.
 *
 * ALL SIX contract operations are implemented: `list`, `get`, `findByCode`, `create`, `update` and
 * `remove`. This header used to say that `update` and `remove` had no handler and answered
 * NOT_IMPLEMENTED (501) — true when the POS was the only screen, and false from the moment the
 * catalogue screen landed. The operations were added without this paragraph following them, which
 * is how a file ends up describing a build that no longer exists.
 *
 * WHY THE READS EXIST. A point of sale cannot show a grid it has no query for, and
 * `ventas.repo.js#crear` resolves each line against `productos` by id — so without them the sale
 * path in this app is unreachable even though it is complete and tested. The POS screen is the
 * feature; this is the minimum the feature needs, and it is already inside the frozen contract.
 *
 * THE TENANT STILL COMES FROM THE REQUEST. Nothing here captures a business id at registration
 * time: every statement is scoped by `ctx.negocioId`, which `installIpc` fills from the resolved
 * local identity. A handler that closed over a tenant would look identical and be wrong the day a
 * second business exists.
 */
export function registerProductosHandlers(registry, { conn }) {
  const ctx = (reqCtx) => createCtx(conn, reqCtx ?? {})

  registry.register('productos', {
    /**
     * The catalogue. One query serves the POS grid, the product table and the barcode lookup's
     * fallback filter, and it is scoped to active rows so a soft-deleted product cannot be sold.
     */
    list: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return listar(ctx(reqCtx), {
        search: payload?.search ?? '',
        categoriaId: payload?.categoriaId ?? null,
        limit: payload?.limit ?? 100,
        offset: payload?.offset ?? 0,
        // `soloActivos` is a renderer-supplied filter, but a product the shop deactivated must
        // stay sellable only in an admin list. Defaulting it to true means a caller that forgets
        // it gets the safe answer.
        soloActivos: payload?.soloActivos ?? true
      })
    },

    get: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return obtener(ctx(reqCtx), payload?.id)
    },

    /**
     * Barcode lookup: the read a USB scanner makes a hundred times an hour.
     *
     * Returns `null` for an unknown code instead of a 404. A scanner that fires over a product
     * the shop does not stock is a normal event, not a failure, and the POS needs to tell those
     * two apart without inspecting an HTTP status code that a local IPC call does not have.
     */
    findByCode: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return buscarPorCodigo(ctx(reqCtx), payload?.codigo)
    },

    /**
     * Create a product. One transaction with its audit row; a duplicate barcode in the same shop
     * is refused by name (`PRODUCTO_CODIGO_DUPLICADO`) because the same barcode in two different
     * shops is perfectly legal — the index is scoped to the business.
     */
    create: (payload, reqCtx) => crear(ctx(reqCtx), payload),
    update: (payload, reqCtx) => actualizar(ctx(reqCtx), payload?.id, payload),
    remove: (payload, reqCtx) => eliminar(ctx(reqCtx), payload?.id)
  })

  return registry
}
