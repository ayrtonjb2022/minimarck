import { llamar } from './ipc'

/**
 * Debtors, over IPC: the people a credit sale can be billed to, and the debt they already carry.
 *
 * Four of the seven contract operations. `listar` and `crear` are what a credit sale needs —
 * `ventas.repo.js` refuses a `credito` sale with no debtor (`VENTA_CREDITO_SIN_DEUDOR`), so the
 * POS cannot offer "Crédito" until it can name someone. `pagos` and `registrarPago` are the two
 * halves of the debt itself: the history, and the act of reducing it.
 *
 * `conDeuda` narrows to the customers who actually owe something.
 *
 * WHAT IS DELIBERATELY ABSENT: `get`, `update` and `remove`. They are contract members with no
 * handler in this build, so they answer a structured 501. There is no screen here that edits a
 * limit or deletes a customer, and a button that calls one of them would be a control that
 * reliably fails when pressed.
 */
export const deudoresAPI = {
  listar: (params = {}) => llamar('deudores', 'list', { limit: 10, ...params }),

  /**
   * Put a new customer on the list. The POS's customer picker can only offer people who already
   * exist, and the first launch seeds no demo customers on purpose, so without this a fresh shop
   * can take a credit sale from nobody.
   */
  crear: (body) => llamar('deudores', 'create', body),

  /**
   * The payments recorded against a debtor, newest first. The payment receipt needs them: the
   * balance it prints is the view's `deudaPendienteCentavos`, and this is the history printed
   * underneath it, so the figure on the receipt can be checked against the rows above it.
   */
  pagos: (deudorId) => llamar('deudores', 'payments', { deudorId }),

  /**
   * Record a payment against a debtor's debt, in full or in part.
   *
   * `monto` is a PESOS string, like every other amount this renderer sends — main converts it to
   * integer centavos with the same `toCents` the sale uses, and the answer carries the debtor's
   * new balances read back through the view, so the screen redraws from the response rather than
   * from its own arithmetic.
   *
   * There is no idempotency key on this one and there cannot be one: `pagos_deuda` has no such
   * column and the schema is frozen. A double-clicked button records two payments, which is why
   * the caller disables its submit control while the call is in flight.
   */
  registrarPago: (deudorId, body) => llamar('deudores', 'addPayment', { deudorId, ...body })
}
