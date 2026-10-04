import { llamar } from './ipc'

/**
 * The till, over IPC.
 *
 * `activa()` resolves to the open till or `null` — never a 404. A closed shop is not a broken
 * shop, and the web's `response.status === 404` branch existed only because an HTTP 404 was the
 * only way an absent resource could arrive. The POS and the shell both read that `null` and show
 * "open the till", which is the same thing the web did, minus the status code.
 */
export const cajasAPI = {
  /** The open till, or null. */
  activa: () => llamar('cajas', 'active'),
  /** Open the drawer. `saldoInicial` is PESOS; the repository converts to centavos. */
  apertura: (data) => llamar('cajas', 'open', data),
  /**
   * Close the till. `conteo` is PESOS as a string, exactly like `saldoInicial`, and is OPTIONAL.
   *
   * `conteo` is forwarded as given and never defaulted to `0` here: a count of zero is an empty
   * drawer, while no count at all is a drawer nobody looked at, and `cerrar` treats the two
   * differently on purpose. The resolved row carries `saldo_esperado_centavos` alongside
   * `monto_contado_centavos` and `diferencia_centavos`, so the screen can show all three after
   * the fact without recomputing the one it no longer can read from the closed row.
   */
  cierre: (data) => llamar('cajas', 'close', data),
  listar: (params = {}) => llamar('cajas', 'list', params)
}
