import { llamar } from './ipc'

/**
 * Debtors, over IPC. Only `listar` and `crear` are here: those are the two a sale needs, because
 * `ventas.repo.js` refuses a `credito` sale with no debtor and the POS therefore has to be able
 * to name one. The other five contract operations belong to the accounts-receivable screen,
 * which is not mounted in this build, and calling them would answer 501.
 *
 * `conDeuda` narrows to the customers who actually owe something.
 */
export const deudoresAPI = {
  listar: (params = {}) => llamar('deudores', 'list', { limit: 10, ...params })
}
