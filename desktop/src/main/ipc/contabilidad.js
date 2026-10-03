import { createCtx } from '../db/ctx.js'
import { requireTenant } from '../db/seed.js'
import {
  actualizarCuenta,
  actualizarDeuda,
  balance,
  crearAsiento,
  crearCuenta,
  crearDeuda,
  dashboard,
  eliminarAsiento,
  eliminarCuenta,
  listarAsientos,
  listarCuentas,
  listarDeudas,
  listarPagosDeuda,
  obtenerAsiento,
  obtenerDeuda,
  registrarPagoDeuda
} from '../db/repositories/contabilidad.repo.js'

/**
 * The `contabilidad.*` handlers — all fifteen contract operations.
 *
 * ── WHAT THIS FILE IS AND IS NOT ──────────────────────────────────────────────────────────────
 *
 * It is a THIN layer, deliberately. Every rule about what an entry may be — that debits equal
 * credits, that a partida moves one side, that a settled debt cannot go back to `activo` — lives in
 * `contabilidad.repo.js`, because that file is the only thing between a person and the ledger and
 * the rule has to hold for every caller. What happens here is the two things that belong to the IPC
 * boundary and nowhere else:
 *
 *   1. `requireTenant` — a call with no resolved business must fail before any SQL runs. It is the
 *      same guard every other group has, and it is the reason a frame cannot name its own tenant.
 *   2. `createCtx` — the tenant and the actor come from the REQUEST, which `installIpc` fills from
 *      the session. A handler that captured a business id at registration time would look identical
 *      and sell from the wrong shop the day a second business exists.
 *
 * ── WHY SOME OPERATIONS ARE READ-ONLY AND STILL CALL `requireTenant` ──────────────────────────
 *
 * `contabilidad.balance` on a shop with no business is not "zero" — it is a question about nobody.
 * Answering it with an empty balance sheet would be a number that looks like an answer, and the
 * stored `TENANT_REQUIRED` refusal is the truthful one.
 *
 * ── THE ONE OPERATION THAT NEEDS NO TENANT ARGUMENT OF ITS OWN ────────────────────────────────
 *
 * `listDebtPayments` takes a debt id and reads that debt's payments. The repository scopes by
 * `negocio_id` on both the lookup and the read, so another shop's id answers an empty list and
 * never another business's money — see `listarPagosDeuda`, which is called through `obtenerDeuda`
 * so a debt id that does not exist in this business is a 404 rather than an empty array.
 */
export function registerContabilidadHandlers(registry, { conn }) {
  const ctx = (reqCtx) => createCtx(conn, reqCtx ?? {})

  registry.register('contabilidad', {
    // ── PLAN DE CUENTAS ───────────────────────────────────────────────────────────────────────
    /** Every account with its debits, credits and signed balance. */
    listAccounts: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return listarCuentas(ctx(reqCtx), {
        search: payload?.search ?? '',
        tipo: payload?.tipo ?? null,
        activo: payload?.activo,
        conSaldo: payload?.conSaldo ?? false
      })
    },

    createAccount: (payload, reqCtx) => crearCuenta(ctx(reqCtx), payload),

    updateAccount: (payload, reqCtx) => actualizarCuenta(ctx(reqCtx), payload?.id, payload),

    deleteAccount: (payload, reqCtx) => eliminarCuenta(ctx(reqCtx), payload?.id),

    // ── LIBRO DIARIO ──────────────────────────────────────────────────────────────────────────
    listEntries: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return listarAsientos(ctx(reqCtx), {
        search: payload?.search ?? '',
        tipo: payload?.tipo ?? null,
        desde: payload?.fechaDesde ?? null,
        hasta: payload?.fechaHasta ?? null,
        limit: payload?.limit ?? 50,
        offset: payload?.offset ?? 0
      })
    },

    getEntry: (payload, reqCtx) => obtenerAsiento(ctx(reqCtx), payload?.id),

    /** One entry, by hand. The repository refuses an unbalanced or single-line one. */
    createEntry: (payload, reqCtx) => crearAsiento(ctx(reqCtx), payload),

    deleteEntry: (payload, reqCtx) => eliminarAsiento(ctx(reqCtx), payload?.id),

    // ── DEUDAS DEL NEGOCIO (lo que la tienda debe) ────────────────────────────────────────────
    listDebts: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return listarDeudas(ctx(reqCtx), {
        search: payload?.search ?? '',
        tipo: payload?.tipo ?? null,
        estado: payload?.estado ?? null,
        limit: payload?.limit ?? 50,
        offset: payload?.offset ?? 0
      })
    },

    createDebt: (payload, reqCtx) => crearDeuda(ctx(reqCtx), payload),

    updateDebt: (payload, reqCtx) => actualizarDeuda(ctx(reqCtx), payload?.id, payload),

    /** Record a payment; the remaining balance moves by exactly that amount, in one transaction. */
    addDebtPayment: (payload, reqCtx) => registrarPagoDeuda(ctx(reqCtx), payload),

    /**
     * The payments of ONE debt.
     *
     * Read through `obtenerDeuda` rather than straight through `listarPagosDeuda`, because the two
     * answer different things for an id that is not this business's: the raw list answers `[]`, and
     * "this debt has no payments" is a different claim from "this debt is not yours". The 404 is the
     * honest one, and it also stops the operation from being a probe for which ids exist.
     */
    listDebtPayments: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return obtenerDeuda(ctx(reqCtx), payload?.deudaId ?? payload?.id).pagosDetalle
    },

    // ── BALANCE ───────────────────────────────────────────────────────────────────────────────
    /** The trial balance: every account, and whether debits equal credits over the whole chart. */
    balance: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return balance(ctx(reqCtx), { conSaldo: payload?.conSaldo ?? false })
    },

    /**
     * The accounting panel — the same sums as `balance`, plus what the shop owes, read in one call.
     *
     * A SEPARATE OPERATION FROM `dashboard.stats` AND NOT A DUPLICATE OF IT. That one is the POS
     * panel: today's sales, the open till, low stock. This one is the balance sheet. They answer
     * different questions and neither can answer the other's.
     */
    dashboard: (_payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return dashboard(ctx(reqCtx))
    }
  })

  return registry
}
