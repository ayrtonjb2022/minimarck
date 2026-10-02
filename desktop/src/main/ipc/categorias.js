import { createCtx } from '../db/ctx.js'
import { requireTenant } from '../db/seed.js'
import { crearCategoria, listarCategorias, obtenerCategoria, actualizarCategoria, eliminarCategoria } from '../db/repositories/productos.repo.js'

/**
 * The `categorias.*` handlers. Two of five: `list` and `create`.
 *
 * WHY A SALE NEEDS THEM. The POS grid's filter row is a category dropdown, and the "fraccionar"
 * flow creates a derived product (1 kg becomes 500 g) that needs somewhere to live. Without
 * `list` the grid has one dead filter and without `create` the derivation has nowhere to put its
 * result. `get`, `update` and `remove` stay unimplemented and answer 501.
 *
 * THE REPOSITORY LIVES WITH THE PRODUCTS, NOT HERE. `productos.repo.js` exports these two because
 * a category is a product's attribute and the two are written in the same transaction shape; the
 * file boundary here is about the IPC group, not about the data. The web's controllers had the
 * same split and the same duplication, which is a fact recorded rather than reproduced.
 */
export function registerCategoriasHandlers(registry, { conn }) {
  const ctx = (reqCtx) => createCtx(conn, reqCtx ?? {})

  registry.register('categorias', {
    /** Every active category, alphabetical. A flat list: the POS renders it as a filter row. */
    list: (_payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return listarCategorias(ctx(reqCtx))
    },

    get: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return obtenerCategoria(ctx(reqCtx), payload?.id)
    },
    create: (payload, reqCtx) => crearCategoria(ctx(reqCtx), payload),
    update: (payload, reqCtx) => actualizarCategoria(ctx(reqCtx), payload?.id, payload),
    remove: (payload, reqCtx) => eliminarCategoria(ctx(reqCtx), payload?.id)
  })

  return registry
}
