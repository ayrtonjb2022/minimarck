import { llamar } from './ipc'

/**
 * The catalogue, over IPC instead of HTTP.
 *
 * The METHOD NAMES are the web's, unchanged, so the pages that call them are unchanged too. What
 * changed is the transport and, where main names things differently, the mapping below — done
 * HERE, in one file per group, rather than at a dozen call sites in the pages.
 */
export const productosAPI = {
  /**
   * The catalogue. `limit: 500` is the POS grid's answer — "a shop's worth of products in one call"
   * — and it stays the default because the grid filters IN MEMORY and a second round trip per
   * keystroke would be slower than the scan it replaces.
   *
   * THE PRODUCTS SCREEN DOES NOT USE THAT DEFAULT. A catalogue screen pages, so it passes its own
   * `limit`/`offset` and gets `{ filas, total }` (the `total` is what makes a pager possible at
   * all). It also passes `soloActivos: false`, because `remove` DEACTIVATES a product that has
   * sales instead of deleting it — a list that hid inactive rows would make that product
   * unreachable, with no way to bring it back or even to see that it is there.
   */
  listar: (params = {}) => llamar('productos', 'list', { limit: 500, ...params }),

  obtener: (id) => llamar('productos', 'get', { id }),

  /**
   * The read a USB scanner makes. Resolves to `null` for a code the shop does not stock — a
   * normal event on a till, not a failure — and the POS is written to say so rather than to
   * treat it as an error worth a toast.
   */
  buscarPorCodigo: (codigo) => llamar('productos', 'findByCode', { codigo }),

  /**
   * Create a product, or edit one. Prices go out in PESOS and stock in decimal units, because that
   * is the renderer's language; `productos.repo.js` parses them to integer centavos and thousandths
   * on the way in. A form that sent centavos would be a form that had already multiplied, which is
   * the arithmetic `shared/money.js` exists to keep in one place.
   *
   * `actualizar` is a PATCH: a key that is ABSENT means "leave it alone", and an explicit
   * `null`/`''` means "clear it". So the edit form sends every field it renders, and a field the
   * operator emptied clears the column rather than being silently ignored.
   */
  crear: (data) => llamar('productos', 'create', data),
  actualizar: (id, data) => llamar('productos', 'update', { id, ...data }),

  /**
   * Remove a product. THE REPOSITORY DECIDES WHAT THAT MEANS, and the answer is not always the same
   * one: a product with sales is DEACTIVATED (`{ id, desactivado: true }`) so that no historical
   * line loses the product it points at, and one without sales is soft-deleted
   * (`{ id, desactivado: false }`). The caller is told which happened instead of assuming, which is
   * what lets the screen say "desactivado" to the operator rather than a flat "eliminado" that is
   * false half the time.
   */
  eliminar: (id) => llamar('productos', 'remove', { id })
}
