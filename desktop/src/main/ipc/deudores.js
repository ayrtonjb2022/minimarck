import { createCtx } from '../db/ctx.js'
import { requireTenant } from '../db/seed.js'
import {
  crear as crearDeudor,
  listar as listarDeudores,
  pagos as pagosDeudor,
  registrarPago as registrarPagoDeudor
} from '../db/repositories/deudores.repo.js'

/**
 * The `deudores.*` handlers. Four of seven: `list`, `create`, `payments` and `addPayment`.
 *
 * WHY `list` AND `create` ARE ENOUGH FOR A SALE. `ventas.repo.js` refuses a `credito` sale with
 * no `clienteDeudorId` (`VENTA_CREDITO_SIN_DEUDOR`), and that refusal is correct: a credit sale
 * with no named debtor is income nobody can collect. So the POS cannot offer "Crédito" to an
 * anonymous customer — it must be able to LIST the people a shop already knows it sells to, and
 * that is the whole requirement for taking the sale. `create` is here so a shop can put a new
 * customer on that list without a database editor.
 *
 * `payments` is the read side of the same debt, and `addPayment` is the write side. They are here
 * as a pair because the receipt needs both: the history is what makes the printed balance
 * checkable, and the payment is what changes it. Printing a balance with no history behind it is
 * a number nobody can verify, and the receipt this build first shipped was worse than blank — it
 * hardcoded `$0.00` and stamped `✓ DEUDA PAGADA` on every debtor, including the ones who owed the
 * shop money.
 *
 * `addPayment` is a repository call, not a wiring change, and it is the fourth member rather than
 * a shortcut around the contract for the same reason `ventas.cancel` is: the operation was named
 * in the frozen 89 before anyone wrote it, and an accounting event that exists only as a bespoke
 * channel is an accounting event no review ever reads.
 *
 * Still 501, on purpose: `get`/`update`/`remove` to manage the debtor list itself. Editing a
 * limit or a name is a screen this build does not have yet; answering 501 is the honest answer.
 *
 * The balances in the response come from `v_clientes_deudores`, never from arithmetic in this
 * process: the view is the single copy of that invariant, and the web's two hand-maintained
 * columns are exactly what `001_init.sql` §4 removed.
 */
export function registerDeudoresHandlers(registry, { conn }) {
  const ctx = (reqCtx) => createCtx(conn, reqCtx ?? {})

  registry.register('deudores', {
    /**
     * Debtors with their live balances. `conDeuda: true` narrows to the ones that actually owe
     * something, which is the list a shop means by "deudores".
     */
    list: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return listarDeudores(ctx(reqCtx), {
        search: payload?.search ?? '',
        conDeuda: payload?.conDeuda ?? false,
        limit: payload?.limit ?? 50,
        offset: payload?.offset ?? 0
      })
    },

    create: (payload, reqCtx) => crearDeudor(ctx(reqCtx), payload),

    /**
     * The payments recorded against one debtor, newest first. Read-only: the balance on the
     * receipt is the view's, and this is the history that explains it.
     */
    payments: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return pagosDeudor(ctx(reqCtx), payload?.deudorId)
    },

    /**
     * Record a payment: the `pagos_deuda` row, the balanced journal entry, the drawer movement
     * when the money is cash, and the balance the caller gets back. `monto` is PESOS.
     *
     * The refusal on a card payment is in the repository, not here, and the reason is that
     * "does this move the drawer" is a question about the ledger's account mapping — it has one
     * answer in this codebase, and putting it in the IPC layer would be how two answers appeared.
     */
    addPayment: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return registrarPagoDeudor(ctx(reqCtx), payload?.deudorId, payload ?? {})
    }
  })

  return registry
}
