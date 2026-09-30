import { createCtx } from '../db/ctx.js'
import { requireTenant } from '../db/seed.js'
import { crear as crearDeudor, listar as listarDeudores, pagos as pagosDeudor } from '../db/repositories/deudores.repo.js'

/**
 * The `deudores.*` handlers. Three of seven: `list`, `create` and `payments`.
 *
 * WHY THREE IS ENOUGH FOR A SALE. `ventas.repo.js` refuses a `credito` sale with no
 * `clienteDeudorId` (`VENTA_CREDITO_SIN_DEUDOR`), and that refusal is correct: a credit sale with
 * no named debtor is income nobody can collect. So the POS cannot offer "Crédito" to an
 * anonymous customer — it must be able to LIST the people a shop already knows it sells to, and
 * that is the whole requirement for taking the sale.
 *
 * `payments` is the read side of the same debt, and it is here for one reason: the payment
 * receipt. Printing a balance with no history behind it is a number nobody can check, and the
 * receipt this build could print was worse than blank — it hardcoded `$0.00` and stamped
 * `✓ DEUDA PAGADA` on every debtor, including the ones who owed the shop money. Reading the
 * recorded payments is what lets the receipt show a real outstanding figure.
 *
 * Still 501, on purpose: `addPayment` to record a payment, and `get`/`update`/`remove` to manage
 * the debtor list itself. Writing a payment is an accounting feature — it needs its own journal
 * entry and drawer movement — and faking it would be the same defect the receipt had.
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
    }
  })

  return registry
}
