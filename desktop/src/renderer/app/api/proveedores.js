import { llamar } from './ipc'

/**
 * Suppliers, over IPC.
 *
 * All five contract operations, and the `deudores.js` header's warning does not apply here: there is
 * no screen in this build with a button that calls an operation which answers 501. The whole set is
 * implemented in `proveedores.repo.js`, and every field is the web's own.
 *
 * WHAT THE CALLER MUST NOT DO: compute an owed figure. `proveedor.comprasPendientesCentavos` is
 * derived by the repository from the purchases that are still `pendiente`, and it arrives here
 * already summed. A screen that added it up again would be a second implementation of the same
 * subtraction, and the two would disagree the first time a purchase was cancelled.
 */
export const proveedoresAPI = {
  /** Searchable by name, tax id, phone, email or contact; `activo` filters the inactive ones out. */
  listar: (params = {}) => llamar('proveedores', 'list', { limit: 50, ...params }),

  /** One supplier plus their purchases, newest first. */
  obtener: (proveedorId) => llamar('proveedores', 'get', { proveedorId }),

  crear: (data) => llamar('proveedores', 'create', data),

  /**
   * A partial edit. Send only the fields that changed: an omitted field is left alone, while an
   * empty string clears it. That distinction is why this does not take a whole supplier object.
   */
  actualizar: (proveedorId, data) => llamar('proveedores', 'update', { proveedorId, ...data }),

  /**
   * A soft delete, refused with a 409 while the supplier has purchases in foot. "Desactivar" is
   * the answer for a supplier a shop has stopped buying from, and the screen offers it.
   */
  eliminar: (proveedorId) => llamar('proveedores', 'remove', { proveedorId })
}
