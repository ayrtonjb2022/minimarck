import { llamar } from './ipc'

/**
 * Debtors, over IPC. Only `listar` and `crear` are here: those are the two a sale needs, because
 * `ventas.repo.js` refuses a `credito` sale with no debtor and the POS therefore has to be able
 * to name one. The other contract operations belong to the accounts-receivable screen, which is
 * not mounted in this build, and calling them would answer 501.
 *
 * `conDeuda` narrows to the customers who actually owe something.
 */
export const deudoresAPI = {
  listar: (params = {}) => llamar('deudores', 'list', { limit: 10, ...params }),

  /**
   * The payments recorded against a debtor, newest first. The payment receipt needs them: the
   * balance it prints is the view's `deudaPendienteCentavos`, and this is the history printed
   * underneath it, so the figure on the receipt can be checked against the rows above it.
   *
   * There is deliberately no `registrarPago` here. Nothing in this build can record a payment
   * from the screen, and offering a button that answers 501 would be a worse lie than the
   * missing button.
   */
  pagos: (deudorId) => llamar('deudores', 'payments', { deudorId })
}
