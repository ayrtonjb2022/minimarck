import { createCtx } from '../db/ctx.js'
import { requireTenant } from '../db/seed.js'
import {
  listar as listarProveedores,
  obtener as obtenerProveedor,
  crear as crearProveedor,
  actualizar as actualizarProveedor,
  remove as eliminarProveedor
} from '../db/repositories/proveedores.repo.js'

/**
 * The `proveedores.*` handlers. All five, which is the point.
 *
 * `App.jsx` used to route `/proveedores` to a page that said the screen was missing "because it is
 * not in the contract of 89 operations". That was a misdiagnosis, and this file is the correction:
 * `list`, `get`, `create`, `update` and `remove` have all been in the frozen contract from the
 * start. What they did not have was a handler, and "no handler" is not "not in the contract" — a
 * missing implementation and a forbidden capability are different problems, and reporting the
 * second when you have the first is how a shop is told it may not buy from a supplier.
 *
 * Nothing here validates a field or refuses a duplicate: the decisions live in
 * `proveedores.repo.js`, and this layer only translates between the frozen contract's names and the
 * repository's Spanish ones. The repository is the single place a rule is stated, so the IPC route
 * and a test cannot end up enforcing two different ones.
 */
export function registerProveedoresHandlers(registry, { conn }) {
  const ctx = (reqCtx) => createCtx(conn, reqCtx ?? {})

  registry.register('proveedores', {
    /**
     * Suppliers, searchable by name, tax id, phone, email or contact, and filterable by `activo`.
     * The list carries the number of purchases and what is still owed, both DERIVED from `compras`
     * — a supplier screen that cannot answer "what do I owe this one?" is a contact list.
     */
    list: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return listarProveedores(ctx(reqCtx), {
        search: payload?.search ?? '',
        activo: payload?.activo,
        limit: payload?.limit ?? 50,
        offset: payload?.offset ?? 0
      })
    },

    /** One supplier with their purchases, newest first. */
    get: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return obtenerProveedor(ctx(reqCtx), payload?.proveedorId ?? payload?.id)
    },

    create: (payload, reqCtx) => crearProveedor(ctx(reqCtx), payload),

    /**
     * A partial edit. A field that arrives `undefined` is left alone and one that arrives blank is
     * cleared, which is the difference between "I did not touch it" and "I removed it".
     */
    update: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return actualizarProveedor(ctx(reqCtx), payload?.proveedorId ?? payload?.id, payload ?? {})
    },

    /**
     * A soft delete, refused while the supplier has purchases in foot. The web's `remove` has no
     * such guard and leaves purchases pointing at a supplier that can no longer be listed.
     */
    remove: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return eliminarProveedor(ctx(reqCtx), payload?.proveedorId ?? payload?.id)
    }
  })

  return registry
}
