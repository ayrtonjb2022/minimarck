/**
 * The frozen operation contract — the SINGLE source of truth for what the renderer may
 * ask the main process to do. design §A.2; cross-checked against spec §L (89 operations).
 *
 * This object is the IPC allowlist (SEC-2). The renderer names an *operation*, never a
 * table and never SQL. There is deliberately NO `db.query`, `db.exec` or any channel that
 * accepts a table name, so the renderer cannot express SQL even by accident.
 *
 * It is `Object.freeze`d on both levels so no later slice can widen it at runtime; adding
 * an operation is an explicit edit here, in review, not an accident in a handler.
 *
 * 75 business operations (mirroring the web's 75 live API functions, + desktop auth.logout),
 * plus 13 desktop-only operations (platform 4, backup 5, db 3, importer 1), plus `ventas.cancel`
 * = 89. The web's own 75 had no sale cancellation either; the fourth `ventas` operation is the
 * one place this contract is ahead of the API it mirrors, and it is there because the capability
 * already existed in the data layer with no way to reach it.
 */
export const OPS = Object.freeze({
  auth: Object.freeze(['login', 'register', 'me', 'changePassword', 'logout']),
  negocio: Object.freeze(['obtener', 'actualizar']),
  categorias: Object.freeze(['list', 'get', 'create', 'update', 'remove']),
  productos: Object.freeze(['list', 'get', 'findByCode', 'create', 'update', 'remove']),
  proveedores: Object.freeze(['list', 'get', 'create', 'update', 'remove']),
  compras: Object.freeze(['list', 'get', 'create', 'update', 'cancel']),
  ventas: Object.freeze(['list', 'get', 'create', 'cancel']),
  cajas: Object.freeze(['list', 'open', 'close', 'get', 'active', 'generalBalance', 'breakdown']),
  cajaMovimientos: Object.freeze(['create', 'listByCaja', 'summary']),
  deudores: Object.freeze(['list', 'get', 'create', 'update', 'remove', 'addPayment', 'payments']),
  contabilidad: Object.freeze([
    'listAccounts', 'createAccount', 'updateAccount', 'deleteAccount', 'listEntries',
    'createEntry', 'getEntry', 'deleteEntry', 'listDebts', 'createDebt', 'updateDebt',
    'addDebtPayment', 'listDebtPayments', 'balance', 'dashboard'
  ]),
  reportes: Object.freeze([
    'sales', 'topProducts', 'cash', 'incomeStatement', 'managerial',
    'businessAnalysis', 'stock', 'expenses', 'purchases', 'debtors'
  ]),
  dashboard: Object.freeze(['stats']),
  notificaciones: Object.freeze(['list']),
  platform: Object.freeze(['export.xlsx', 'export.pdf', 'print', 'shell.showItemInFolder']),
  backup: Object.freeze(['create', 'list', 'restore', 'verify', 'prune']),
  db: Object.freeze(['info', 'schemaVersion', 'reconcile']),
  importer: Object.freeze(['status'])
})

/**
 * The only event topics the renderer may subscribe to. Anything else throws in the
 * preload, so a renderer typo cannot silently register a listener (SEC-2).
 * Mirrors the preload TOPICS guard; kept here so main and preload agree on one list.
 */
export const TOPICS = Object.freeze(['backup:progress', 'import:progress', 'db:changed', 'theme:changed'])

/** IPC channel name. Versioned so a future incompatible envelope is a new channel. */
export const CHANNEL = 'minimarck:v1'

/** Current envelope version; the main process rejects anything else with BAD_VERSION. */
export const ENVELOPE_VERSION = 1

/**
 * Count of operations in the frozen contract. Asserted in tests.
 *
 * 89, and it was 88 until `ventas.cancel` was added: cancellation is the one operation this
 * contract gained on purpose, because the UI had a button that could void a sale and no way to
 * honour it. The count is DERIVED from `OPS` rather than typed in, so it cannot drift from the
 * list it describes — but the assertion in `check-contract.mjs` is written as a literal on
 * purpose, so that adding an operation is a decision someone has to make in a test failure
 * instead of a number that quietly follows along.
 */
export const OPS_COUNT = Object.values(OPS).reduce((n, ops) => n + ops.length, 0)
