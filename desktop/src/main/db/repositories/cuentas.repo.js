import { IpcError } from '../../bridge/errors.js'

/**
 * Double-entry bookkeeping for a transaction that already happened (design §D.4; spec MAT-2).
 *
 * WHY THIS FILE EXISTS AT ALL: the web writes no journal rows for a sale. `venta.controller.js`
 * creates the sale, its lines, decrements stock, records a till movement and stops — there is no
 * `AsientoContable` in it. So a shop that only ever used the web has sales and a stock count and
 * no ledger, and the accounting module has to reconstruct history from movements. The desktop
 * writes the journal as part of the sale, in the same transaction, because a sale with no
 * journal is a number nobody can reconcile. See `DIVERGENCES.md`.
 *
 * TWO PROMISES THIS FILE MAKES, both enforced rather than documented:
 *
 *   1. `asentar` REFUSES an entry whose debits do not equal its credits. It is not a warning;
 *      it throws, and because it runs inside the caller's transaction the whole operation
 *      unwinds. An entry that reaches the database unbalanced is permanent — a ledger is
 *      append-only in spirit and there is no sweep job to fix it later — so the check belongs
 *      before the INSERT, not in a nightly report.
 *
 *   2. It opens NO transaction of its own. Atomicity is the caller's, because the caller is the
 *      one that has other writes to roll back. A function that opened its own transaction would
 *      make the sale atomic up to this point and non-atomic after it, which is worse than not
 *      writing the journal at all.
 *
 * ACCOUNT CODES are the ones the web already uses (`backend/seed-contabilidad.js:158-187`).
 * They are not invented here and not re-derived: a shop that migrates its data keeps the same
 * codes it already balances against in reports.
 */
export const PLAN_CONTABLE = Object.freeze([
  // Activo
  { codigo: '1.1.01', nombre: 'Caja', tipo: 'activo', descripcion: 'Efectivo en caja' },
  { codigo: '1.1.02', nombre: 'Banco', tipo: 'activo', descripcion: 'Cuentas bancarias' },
  { codigo: '1.1.03', nombre: 'MercadoPago', tipo: 'activo', descripcion: 'Cuenta MercadoPago' },
  { codigo: '1.2.01', nombre: 'Mercaderías', tipo: 'activo', descripcion: 'Stock de mercaderías' },
  { codigo: '1.3.01', nombre: 'Clientes (Deudores)', tipo: 'activo', descripcion: 'Créditos a clientes' },
  { codigo: '1.4.01', nombre: 'Equipos y Rodados', tipo: 'activo', descripcion: 'Equipamiento del negocio' },
  // Pasivo
  { codigo: '2.1.01', nombre: 'Proveedores (Acreedores)', tipo: 'pasivo', descripcion: 'Deudas con proveedores' },
  { codigo: '2.2.01', nombre: 'Préstamo MercadoPago', tipo: 'pasivo', descripcion: 'Préstamo MercadoPago' },
  { codigo: '2.2.02', nombre: 'Préstamo Bancario', tipo: 'pasivo', descripcion: 'Préstamo bancario' },
  { codigo: '2.2.03', nombre: 'Préstamo Personal', tipo: 'pasivo', descripcion: 'Préstamo a persona' },
  { codigo: '2.3.01', nombre: 'Impuestos a Pagar', tipo: 'pasivo', descripcion: 'Impuestos adeudados' },
  { codigo: '2.4.01', nombre: 'Sueldos a Pagar', tipo: 'pasivo', descripcion: 'Sueldos adeudados' },
  // Capital
  { codigo: '3.1.01', nombre: 'Capital Social', tipo: 'capital', descripcion: 'Capital aportado' },
  { codigo: '3.2.01', nombre: 'Resultados Acumulados', tipo: 'capital', descripcion: 'Resultados de ejercicios anteriores' },
  // Ingreso
  { codigo: '4.1.01', nombre: 'Ventas', tipo: 'ingreso', descripcion: 'Ingresos por ventas' },
  { codigo: '4.2.01', nombre: 'Otros Ingresos', tipo: 'ingreso', descripcion: 'Otros ingresos' },
  // Gasto
  { codigo: '5.1.01', nombre: 'Costo de Mercadería Vendida', tipo: 'gasto', descripcion: 'Costo de mercadería vendida' },
  { codigo: '5.2.01', nombre: 'Sueldos y Cargas Sociales', tipo: 'gasto', descripcion: 'Sueldos y cargas' },
  { codigo: '5.2.02', nombre: 'Alquiler', tipo: 'gasto', descripcion: 'Alquiler del local' },
  { codigo: '5.2.03', nombre: 'Servicios (Luz, Gas, Internet)', tipo: 'gasto', descripcion: 'Servicios básicos' },
  { codigo: '5.2.04', nombre: 'Impuestos y Tasas', tipo: 'gasto', descripcion: 'Impuestos municipales y nacionales' },
  { codigo: '5.3.01', nombre: 'Gastos Bancarios', tipo: 'gasto', descripcion: 'Comisiones bancarias' },
  { codigo: '5.3.02', nombre: 'Mantenimiento y Reparaciones', tipo: 'gasto', descripcion: 'Mantenimiento del local' },
  // The account an OWNER-TYPED expense lands in — `cajaMovimientos.create` with `tipo: 'egreso'`.
  //
  // Every gasto above names a SPECIFIC thing: the rent, the electricity, the payroll, the bank
  // fee. An owner-typed expense names none of them. Its payload is a free-text `concepto` and an
  // amount, so the app genuinely cannot tell a bag of packaging from a light bill, and posting one
  // to `5.2.02 Alquiler` or `5.2.03 Servicios` would put a confident, readable, FALSE claim in the
  // ledger — the kind of lie that survives a year and then makes a real report wrong. So it goes
  // to an account that says only what is actually true: this money left the drawer, for a reason
  // the shop recorded in words.
  //
  // ADDED HERE, NOT IN A MIGRATION, and that is the whole mechanism rather than a shortcut. The
  // chart is not in `001_init.sql` — that migration has no account INSERTs at all, because
  // `cuentas_contables.negocio_id` is NOT NULL and a migration runs before any business exists to
  // hang an account on. `asegurarPlan` inserts this array per tenant with
  // `ON CONFLICT DO NOTHING` on every flow that needs it, so appending a row is how an account is
  // added and versioned: an existing shop grows the account the next time it records anything,
  // and an existing account is never rewritten. That is the same add-only contract the rest of
  // this file keeps — see `3.1.01 Capital Social` and `2.1.01 Proveedores (Acreedores)`, which are
  // also in the web's chart and needed no migration either.
  { codigo: '5.4.01', nombre: 'Otros Gastos', tipo: 'gasto', descripcion: 'Gastos cargados manualmente por el dueño' }
])

/** The accounts a sale touches, named by CODE so no call site carries a literal. */
export const CUENTA = Object.freeze({
  CAJA: '1.1.01',
  BANCO: '1.1.02',
  MERCADOPAGO: '1.1.03',
  MERCADERIAS: '1.2.01',
  CLIENTES: '1.3.01',
  // The account an OWNER CONTRIBUTION lands in. `3.1.01 Capital Social` is already in the seeded
  // chart above (tipo `capital`, "Capital aportado"), so the till opening needed no new account.
  // Its credit is where the float's money is said to come from: not revenue — the shop has sold
  // nothing yet — and not another asset, which would move the gap rather than close it.
  CAPITAL: '3.1.01',
  VENTAS: '4.1.01',
  // The account an owner-typed expense lands in. The chart's other gastos are all specific
  // (`5.2.02 Alquiler`, `5.2.03 Servicios`, ...), and an owner-typed expense does not say which one
  // it is, so it is a catch-all rather than a guess. See the note on `5.4.01` in `PLAN_CONTABLE`.
  OTROS_GASTOS: '5.4.01',
  // The mirror of `5.4.01`, for an owner-typed `ingreso` — money into the drawer that no sale
  // explains. `4.2.01 Otros Ingresos` was ALREADY in the web's chart, so this direction needed no
  // addition at all; naming it here keeps the pair visible in one place instead of one side
  // being a literal in a repository and the other a constant.
  OTROS_INGRESOS: '4.2.01',
  CMV: '5.1.01',
  // The account a purchase ON CREDIT lands in. Already in the seeded chart above as a `pasivo`
  // ("Proveedores (Acreedores)"), so crediting a supplier's goods posts to an existing account
  // and no migration is needed. It is deliberately the mirror of `1.3.01 Clientes (Deudores)`:
  // a sale on credit makes the CUSTOMER owe the shop, a purchase on credit makes the SHOP owe the
  // SUPPLIER, and the second is a real liability rather than a negative asset.
  PROVEEDORES: '2.1.01'
})

/**
 * The plan of accounts, created on demand by the first flow that needs it.
 *
 * NOT IN `seed.js`, and the reason is the one `seed.js` already gives: a first-run seeder must
 * not put fictitious data in a real shop's database. But a chart of accounts is not fictitious
 * data — it is the fixed taxonomy every entry is expressed in, identical to the one the web
 * seeds, and a shop physically cannot record a sale without it. So the sale creates it, the
 * first time a sale happens, inside the sale's own transaction: either the sale and its
 * accounts are both there, or neither is.
 *
 * Idempotent by construction. `INSERT ... ON CONFLICT DO NOTHING` against
 * `ux_cuentas_contables_codigo_negocio`, then one SELECT. The unique index is the arbiter, not a
 * read-then-write race: two sales opening at the same second both insert, one loses on the index
 * and reads the winner's row.
 */
export function asegurarPlan(ctx) {
  const ts = new Date().toISOString()
  for (const cuenta of PLAN_CONTABLE) {
    ctx.db
      .prepare(
        `INSERT INTO cuentas_contables (codigo, nombre, tipo, descripcion, activo, negocio_id, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT (codigo, negocio_id) DO NOTHING`
      )
      .run(cuenta.codigo, cuenta.nombre, cuenta.tipo, cuenta.descripcion, ctx.negocioId, ctx.actorId, ts, ts)
  }
  return cuentasPorCodigo(ctx.db, ctx.negocioId)
}

/** `codigo -> { id, nombre, tipo }` for one business. Throws if the plan is incomplete. */
export function cuentasPorCodigo(db, negocioId, codigos = null) {
  const rows = db
    .prepare('SELECT id, codigo, nombre, tipo, activo FROM cuentas_contables WHERE negocio_id = ?')
    .all(negocioId)
  const map = new Map(rows.map((r) => [r.codigo, r]))
  const requeridas = codigos ?? PLAN_CONTABLE.map((c) => c.codigo)
  const faltantes = requeridas.filter((c) => !map.has(c))
  if (faltantes.length > 0) {
    throw new IpcError(
      'CUENTAS_INCOMPLETAS',
      500,
      `El plan de cuentas del negocio ${negocioId} no tiene: ${faltantes.join(', ')}. ` +
        'Llamá asegurarPlan() dentro de la misma transacción antes de asientos.'
    )
  }
  return map
}

/**
 * Write one journal entry: the `asientos_contables` header plus its `detalles_asientos` lines.
 *
 * MUST be called inside a transaction the caller controls. Returns `{ id, debe, haber }`, or
 * `null` when every line is zero on both sides — a genuinely free, no-cost item moves nothing, so
 * an entry with four zeros in it is a row that has to be explained at every future audit for no
 * accounting meaning.
 *
 * @param partidas [{ cuentaId, debeCentavos, haberCentavos, descripcion }]
 */
export function asentar(ctx, { fecha, descripcion, tipo, referencia = null, partidas }) {
  if (!Array.isArray(partidas) || partidas.length === 0) {
    throw new IpcError('ASIENTO_SIN_PARTIDAS', 500, 'Un asiento necesita al menos una partida')
  }

  const ts = new Date().toISOString()
  const fechaAsiento = fecha ?? ts

  // A partida that is zero on BOTH sides is dropped; one that is non-zero on BOTH sides is
  // refused. Neither is a style question — the first is noise and the second is a lie, because
  // `SUM(debe) = SUM(haber)` can still hold while the row claims the same peso was spent twice.
  const lineas = []
  for (const p of partidas) {
    const debe = p.debeCentavos ?? 0
    const haber = p.haberCentavos ?? 0
    if (!Number.isSafeInteger(debe) || !Number.isSafeInteger(haber)) {
      throw new IpcError(
        'ASIENTO_NO_CENTAVOS',
        500,
        `Partida de "${descripcion}" con debe/haber no entero: ${JSON.stringify({ debe, haber })}`
      )
    }
    if (debe !== 0 && haber !== 0) {
      throw new IpcError(
        'ASIENTO_PARTIDA_DOBLE',
        500,
        `Partida de "${descripcion}" con debe ${debe} y haber ${haber}: en doble partida una ` +
          'línea mueve UN lado.'
      )
    }
    if (debe === 0 && haber === 0) continue
    if (!p.cuentaId) {
      throw new IpcError('ASIENTO_SIN_CUENTA', 500, `Partida de "${descripcion}" sin cuenta contable`)
    }
    lineas.push({ ...p, debe, haber })
  }

  if (lineas.length === 0) return null

  const totalDebe = lineas.reduce((s, l) => s + l.debe, 0)
  const totalHaber = lineas.reduce((s, l) => s + l.haber, 0)
  // THE invariant. Thrown, not logged, and thrown before the first INSERT so an unbalanced entry
  // is impossible rather than merely unlikely.
  if (totalDebe !== totalHaber) {
    throw new IpcError(
      'ASIENTO_DESBALANCEADO',
      500,
      `Asiento "${descripcion}" desbalanceado: debe ${totalDebe} != haber ${totalHaber}. ` +
        'Un asiento que no balancea no se escribe; corregí las partidas.'
    )
  }

  const info = ctx.db
    .prepare(
      `INSERT INTO asientos_contables
         (fecha, descripcion, tipo, referencia, monto_total_centavos, negocio_id, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(fechaAsiento, descripcion, tipo, referencia, totalDebe, ctx.negocioId, ctx.actorId, ts, ts)
  const asientoId = Number(info.lastInsertRowid)

  const insDetalle = ctx.db.prepare(
    `INSERT INTO detalles_asientos
       (asiento_contable_id, cuenta_contable_id, debe_centavos, haber_centavos, descripcion, negocio_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const l of lineas) {
    insDetalle.run(asientoId, l.cuentaId, l.debe, l.haber, l.descripcion ?? null, ctx.negocioId, ts, ts)
  }

  return { id: asientoId, debe: totalDebe, haber: totalHaber }
}

/**
 * Read the trial balance for one entry, straight from `SUM()`.
 *
 * Exists so a test can ask the DATABASE what it thinks the balance is, instead of asking the
 * code that wrote the numbers. A test that sums the same JavaScript objects it just pushed
 * proves that addition works.
 */
export function balanceAsiento(db, asientoId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(debe_centavos), 0) AS debe, COALESCE(SUM(haber_centavos), 0) AS haber
         FROM detalles_asientos WHERE asiento_contable_id = ?`
    )
    .get(asientoId)
  return { debe: row.debe, haber: row.haber, balanceado: row.debe === row.haber }
}

/**
 * The trial balance for a whole business, per account. Every row must have `debe === haber`.
 *
 * @param referencias optional — restrict to entries carrying one of these `referencia` values
 *   (`['venta:12', 'pago:3']`). The default is every entry in the business. The scope exists because
 *   "this sale and its reversal cancel each other" is a claim about the SALE's entries, and once a
 *   till opening posts a balanced-but-non-zero float entry, a whole-ledger reading can no longer
 *   answer it: `Caja` and `Capital` carry a real balance that has nothing to do with the sale.
 */
export function balanceGeneral(db, negocioId, referencias = null) {
  const acotado = Array.isArray(referencias) && referencias.length > 0
  // The scope filters the DETAIL rows, not the account list, and it is applied in the WHERE with an
  // EXISTS over the entry. Filtering in the `a` join would be wrong: `d` is joined independently
  // of `a`, so a detail whose entry is not in scope would still be summed.
  const params = [negocioId]
  let alcance = ''
  if (acotado) {
    alcance = ` AND EXISTS (SELECT 1 FROM asientos_contables a
                             WHERE a.id = d.asiento_contable_id
                               AND a.referencia IN (${referencias.map(() => '?').join(', ')}))`
    params.push(...referencias)
  }
  return db
    .prepare(
      `SELECT c.codigo, c.nombre, c.tipo,
              COALESCE(SUM(d.debe_centavos), 0)  AS debe,
              COALESCE(SUM(d.haber_centavos), 0) AS haber
         FROM cuentas_contables c
         LEFT JOIN detalles_asientos d
           ON d.cuenta_contable_id = c.id AND d.negocio_id = c.negocio_id
        WHERE c.negocio_id = ?${alcance}
        GROUP BY c.id
        ORDER BY c.codigo`
    )
    .all(...params)
}
