import { llamar } from './ipc'

/**
 * The catalogue, over IPC instead of HTTP.
 *
 * The METHOD NAMES are the web's, unchanged, so the pages that call them are unchanged too. What
 * changed is the transport and, where main names things differently, the mapping below — done
 * HERE, in one file per group, rather than at a dozen call sites in the pages.
 */
export const productosAPI = {
  /** One query for the POS grid. `limit: 500` is a shop's worth of products in one call. */
  listar: (params = {}) => llamar('productos', 'list', { limit: 500, ...params }),

  obtener: (id) => llamar('productos', 'get', { id }),

  /**
   * The read a USB scanner makes. Resolves to `null` for a code the shop does not stock — a
   * normal event on a till, not a failure — and the POS is written to say so rather than to
   * treat it as an error worth a toast.
   */
  buscarPorCodigo: (codigo) => llamar('productos', 'findByCode', { codigo }),

  /** Prices go out in PESOS, as the web sent them; the repository parses them to centavos. */
  crear: (data) => llamar('productos', 'create', data)
}
