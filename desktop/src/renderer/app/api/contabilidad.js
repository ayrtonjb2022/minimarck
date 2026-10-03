import { llamar } from './ipc'

/**
 * Contabilidad, over IPC — the ledger the shop has been writing since the first sale.
 *
 * ── WHAT THIS GROUP IS, IN A SHOP'S WORDS ─────────────────────────────────────────────────────
 *
 * Two different kinds of "debt" live near each other here and confusing them is the expensive
 * mistake, so this file names them apart:
 *
 *   - `listDebts`/`createDebt`/`addDebtPayment` are what the SHOP OWES: a bank loan, MercadoPago, a
 *     supplier. In accounting terms those are LIABILITIES (`2.x`).
 *   - `deudores` (the other screen) is what CUSTOMERS OWE THE SHOP: an asset (`1.3.01`), money
 *     coming in.
 *
 * They are opposites, and a screen that said only "deuda" would be ambiguous in the vocabulary a
 * shopkeeper actually uses.
 *
 * ── WHY THE DATES ARE RENAMED HERE ────────────────────────────────────────────────────────────
 *
 * `fechaDesde`/`fechaHasta` on the way out, `desde`/`hasta` in the contract — the same translation
 * `api/ventas.js` does, and for the same reason: the screen describes what it wants in its own
 * vocabulary, and main's field names stop at this line.
 *
 * ── NOTHING HERE COMPUTES A BALANCE ───────────────────────────────────────────────────────────
 *
 * Every figure arrives already signed and already summed. The SIGN of an account depends on its
 * type (`activo` and `gasto` read one way, `pasivo`, `capital` and `ingreso` the other), and that
 * rule lives once, in `metricas.js#saldoDeTipo`, which main reads through. A screen that subtracted
 * on its own would be the second implementation of the one rule in accounting that must not have
 * two — and a liability displayed as a negative asset is a balance sheet that is wrong by twice the
 * amount.
 */
export const contabilidadAPI = {
  // ── PLAN DE CUENTAS ─────────────────────────────────────────────────────────────────────────
  listarCuentas: (params = {}) => llamar('contabilidad', 'listAccounts', params),
  crearCuenta: (data) => llamar('contabilidad', 'createAccount', data),
  actualizarCuenta: (id, data) => llamar('contabilidad', 'updateAccount', { id, ...data }),
  eliminarCuenta: (id) => llamar('contabilidad', 'deleteAccount', { id }),

  // ── LIBRO DIARIO ────────────────────────────────────────────────────────────────────────────
  listarAsientos: (params = {}) =>
    llamar('contabilidad', 'listEntries', {
      limit: params.limit ?? 50,
      offset: params.offset ?? 0,
      search: params.search ?? undefined,
      tipo: params.tipo ?? undefined,
      fechaDesde: params.desde ?? undefined,
      fechaHasta: params.hasta ?? undefined
    }),

  obtenerAsiento: (id) => llamar('contabilidad', 'getEntry', { id }),

  /**
   * Write an entry by hand. The partidas go out in PESOS, like every other amount in this app, and
   * main parses them to integer centavos — a form that had already multiplied would be a form that
   * had already made the arithmetic mistake `shared/money.js` exists to prevent.
   *
   * The balanced check is not duplicated here: an entry whose debits do not equal its credits is
   * refused by the repository, before the first INSERT, and its message says by how much.
   */
  crearAsiento: (data) => llamar('contabilidad', 'createEntry', data),
  eliminarAsiento: (id) => llamar('contabilidad', 'deleteEntry', { id }),

  // ── DEUDAS DEL NEGOCIO ──────────────────────────────────────────────────────────────────────
  listarDeudas: (params = {}) =>
    llamar('contabilidad', 'listDebts', {
      limit: params.limit ?? 50,
      offset: params.offset ?? 0,
      search: params.search ?? undefined,
      tipo: params.tipo ?? undefined,
      estado: params.estado ?? undefined
    }),

  crearDeuda: (data) => llamar('contabilidad', 'createDebt', data),
  actualizarDeuda: (id, data) => llamar('contabilidad', 'updateDebt', { id, ...data }),

  /**
   * Record a payment. Resolves to `{ pago, deuda }` — the payment that was written AND the debt as
   * it now stands, read from the same transaction. The screen shows both rather than adding the
   * subtraction itself: the remaining balance is the database's number.
   */
  registrarPagoDeuda: (data) => llamar('contabilidad', 'addDebtPayment', data),
  listarPagosDeuda: (deudaId) => llamar('contabilidad', 'listDebtPayments', { deudaId }),

  // ── BALANCE ─────────────────────────────────────────────────────────────────────────────────
  balance: (params = {}) => llamar('contabilidad', 'balance', { conSaldo: params.conSaldo ?? false }),
  dashboard: () => llamar('contabilidad', 'dashboard')
}
