import { llamar } from './ipc'

/**
 * Sales, over IPC.
 *
 * The date parameters are RENAMED here, not in the page. The web sent `fechaDesde`/`fechaHasta`
 * straight through a query string; the contract's `ventas.list` names them `desde`/`hasta`.
 * Translating at the transport boundary is the point of this file — the page describes what it
 * wants in its own vocabulary and does not know main's.
 */
export const ventasAPI = {
  listar: (params = {}) =>
    llamar('ventas', 'list', {
      limit: params.limit ?? 20,
      offset: params.offset ?? 0,
      estado: params.estado ?? undefined,
      desde: params.fechaDesde ?? undefined,
      hasta: params.fechaHasta ?? undefined
    }),

  obtener: (id) => llamar('ventas', 'get', { id }),

  /**
   * Record a sale. The response is the complete sale with its lines and a `duplicado` flag saying
   * whether THIS call created it, so a retry that reused the same key is distinguishable from a
   * first attempt.
   */
  crear: (data) => llamar('ventas', 'create', data),

  /**
   * Void a recorded sale. The stock returns to the shelf, the drawer entry is reversed and the
   * journal gets its mirror row — the server does all of it, so the caller sends an id and a
   * reason and never adjusts a balance itself.
   */
  cancelar: (id, motivo) => llamar('ventas', 'cancel', { id, motivo })
}
