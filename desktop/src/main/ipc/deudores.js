import { createCtx } from '../db/ctx.js'
import { requireTenant } from '../db/seed.js'
import { crear as crearDeudor, listar as listarDeudores } from '../db/repositories/deudores.repo.js'

/**
 * The `deudores.*` handlers. Two of seven: `list` and `create`.
 *
 * WHY ONLY TWO IS ENOUGH FOR A SALE. `ventas.repo.js` refuses a `credito` sale without a
 * `clienteDeudorId` (`VENTA_CREDITO_SIN_DEUDOR`), and that refusal is correct: a credit sale with
 * no named debtor is income nobody can collect. So the POS cannot offer "Crédito" to an
 * anonymous customer — it must be able to LIST the people a shop already knows it sells to, and
 * that is the whole requirement. Recording a payment against a debt, editing a debtor and
 * deleting one are the accounts-receivable screens, a different piece of work, and they stay 501
 * rather than being faked.
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

    create: (payload, reqCtx) => crearDeudor(ctx(reqCtx), payload)
  })

  return registry
}
