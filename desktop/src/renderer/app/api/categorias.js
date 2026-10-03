import { llamar } from './ipc'

/**
 * Categories, over IPC. `list` answers a flat array — the POS filter row and the product form's
 * `<select>`, not a table. It is every ACTIVE category alphabetically, which is why the products
 * screen can call it once and use the result for both the filter and the form.
 */
export const categoriasAPI = {
  listar: () => llamar('categorias', 'list'),
  obtener: (id) => llamar('categorias', 'get', { id }),
  crear: (data) => llamar('categorias', 'create', data),

  /** A PATCH, like `productos.actualizar`: an absent key leaves the column alone. */
  actualizar: (id, data) => llamar('categorias', 'update', { id, ...data }),

  /**
   * Remove a category. Refused with `CATEGORIA_CON_PRODUCTOS` (400) while active products still
   * point at it — the category is a filter row, so deleting one in use would leave those products
   * filed under something that no longer resolves. The screen reads that code and offers to
   * deactivate instead, which is the same shape the supplier screen uses for its refusal.
   */
  eliminar: (id) => llamar('categorias', 'remove', { id })
}
