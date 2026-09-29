import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, copyFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapDatabase } from '../../src/main/db/bootstrap.js'
import { openDatabase } from '../../src/main/db/connection.js'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../src/main/db/migrations', import.meta.url))
const INIT_SQL = fileURLToPath(new URL('../../src/main/db/migrations/001_init.sql', import.meta.url))

/**
 * The schema is the one artifact in this app that every other slice builds on, and a schema
 * mistake is not a crash — it is a wrong number in a report months later. So these tests assert
 * the INVARIANTS (no money column is REAL, no stored balance, every enum is constrained)
 * rather than a snapshot of the DDL. A snapshot would pass while something money-shaped was
 * stored as a float, which is the exact failure the whole module exists to prevent.
 */

const TABLES = [
  'negocios', 'users', 'suscripciones', 'categorias', 'proveedores', 'productos',
  'cuentas_contables', 'asientos_contables', 'detalles_asientos', 'clientes_deudores',
  'cuentas_corrientes_deudas', 'pagos_deuda_contabilidad', 'cajas', 'ventas',
  'ventas_detalles', 'compras', 'compras_detalles', 'movimientos_caja', 'pagos_deuda',
  'auditoria'
]

/** The 20 tables the Sequelize models define, verified against `backend/src/models/`. */
const EXPECTED_TABLE_COUNT = 20

/**
 * Tables with `paranoid: true` carry `deleted_at`; the rest must NOT.
 *
 * Both lists below were extracted by grepping `paranoid:` across all 20 model files, NOT read
 * off by eye — the first version of this file wrongly listed `ventas_detalles` as soft,
 * because that model has no `paranoid` key at all and Sequelize then defaults to hard delete.
 * "No key" and "paranoid: false" mean the same thing, and both differ from `true`.
 *
 * 9 soft + 11 hard = 20.
 */
const PARANOID_TABLES = [
  'negocios', 'users', 'categorias', 'productos', 'proveedores',
  'clientes_deudores', 'ventas', 'compras', 'cajas'
]
const NON_PARANOID_TABLES = [
  'ventas_detalles', 'compras_detalles', 'movimientos_caja', 'pagos_deuda', 'auditoria',
  'suscripciones', 'cuentas_contables', 'asientos_contables', 'detalles_asientos',
  'cuentas_corrientes_deudas', 'pagos_deuda_contabilidad'
]

/** Rate columns: REAL is correct, and they are the ONLY REAL numeric columns. */
const RATE_COLUMNS = ['productos.iva_porcentaje', 'productos.margen', 'cuentas_corrientes_deudas.tasa_interes']

let dir
let conn
let templateDir
let templateDb

/**
 * Migrate and seed ONCE into a template file, then hand each test a COPY.
 *
 * The first version of this file ran the real `bootstrapDatabase()` 32 times — once per test —
 * and it made the suite FLAKY rather than slow. On run 3 of 5, `node-sqlite.smoke` and
 * `lifecycle.spec.js` both failed, and neither imports anything from this file. That is the
 * signature of resource exhaustion, not logic: 32 full migrate + WAL + checkpoint + close
 * cycles running in parallel with the rest of the suite, on Windows, which has a much lower
 * file-handle ceiling and stricter locking than the platform this was first reasoned about.
 *
 * A flaky test is worse than a slow one, because it teaches you to re-run instead of read.
 * The fix is to do the expensive part once. The copy is a few hundred KB; the migration is
 * 20 CREATE TABLEs, 60 indexes, a view and a seeded row each time.
 */
beforeAll(() => {
  templateDir = mkdtempSync(path.join(tmpdir(), 'mm-schema-template-'))
  const r = bootstrapDatabase({
    userDataPath: templateDir,
    migrationsDir: MIGRATIONS_DIR,
    now: () => '2026-01-01T00:00:00.000Z'
  })
  // Checkpoint first: the committed rows must be inside the .db, not in a -wal sidecar, or
  // the copy below would carry an empty database and every test would fail for the wrong reason.
  r.conn.checkpointAndClose()
  templateDb = r.paths.dbFile
})
afterAll(() => {
  rmSync(templateDir, { recursive: true, force: true })
})

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mm-schema-'))
})
afterEach(() => {
  try {
    conn?.checkpointAndClose()
  } catch {
    /* the assertion, not the close, is what this test is about */
  }
  conn = undefined
  rmSync(dir, { recursive: true, force: true })
})

function columnsOf(db, table) {
  return db.prepare(`SELECT name, type, "notnull" FROM pragma_table_info(?)`).all(table)
}
function column(db, table, name) {
  return columnsOf(db, table).find((c) => c.name === name)
}

/**
 * A fresh, fully migrated and seeded database for one test, from the template.
 *
 * The allowlist is passed explicitly as `TABLES` rather than relying on `migrate()` to
 * discover it: nothing is pending on an already-migrated copy, so `tablesCreatedBy` never
 * runs and nothing would be allowlisted. Passing the census is exactly what the real
 * `bootstrapDatabase` ends up with anyway, because that is the list the migration creates.
 */
function bootReal() {
  const file = path.join(dir, 'schema.db')
  copyFileSync(templateDb, file)
  conn = openDatabase(file, { walFile: `${file}-wal`, tables: [...TABLES] })
  return { conn, migration: { applied: [], userVersion: 1 }, seeded: { seeded: false, unresolved: [] } }
}

describe('001_init.sql applies through the real migration runner', () => {
  // These three use the REAL `bootstrapDatabase` rather than the template copy, because what is
  // under test is the runner itself: that it discovers the file, applies it, sets user_version
  // and only then seeds. Three real boots is cheap; the other 29 are file copies.
  it('boots, migrates to version 1 and seeds, for the first time end to end', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'mm-schema-boot-'))
    const result = bootstrapDatabase({
      userDataPath: base, migrationsDir: MIGRATIONS_DIR,
      now: () => '2026-01-01T00:00:00.000Z'
    })
    try {
      expect(result.migration.applied).toEqual([1])
      expect(result.conn.userVersion()).toBe(1)
      // Until this file existed, `seed()` reported `schema_not_present` and wrote nothing.
      expect(result.seeded.seeded).toBe(true)
      expect(result.seeded.reason).toBe('seeded')
      // The whole point of the exercise: the first run writes a business and an operator.
      expect(result.seeded.negocioId).toBeGreaterThan(0)
      expect(result.seeded.userId).toBeGreaterThan(0)
    } finally {
      result.conn.checkpointAndClose()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('is idempotent: a second bootstrap applies nothing and does not re-seed', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'mm-schema-idem-'))
    const first = bootstrapDatabase({
      userDataPath: base, migrationsDir: MIGRATIONS_DIR,
      now: () => '2026-01-01T00:00:00.000Z'
    })
    const negocioId = first.seeded.negocioId
    first.conn.checkpointAndClose()

    const second = bootstrapDatabase({
      userDataPath: base, migrationsDir: MIGRATIONS_DIR,
      now: () => '2026-01-02T00:00:00.000Z'
    })
    try {
      expect(second.migration.applied).toEqual([])
      expect(second.conn.userVersion()).toBe(1)
      expect(second.seeded.seeded).toBe(false)
      expect(second.seeded.reason).toBe('already_seeded')
      expect(second.seeded.negocioId).toBe(negocioId)
    } finally {
      second.conn.checkpointAndClose()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('creates exactly the 20 tables the Sequelize models define, and no others', () => {
    bootReal()
    const found = conn.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all()
      .map((r) => r.name)
      .filter((n) => n !== 'schema_migrations')
    // The census was counted by hand from 20 model files; `index.js` and `relations.js` are not
    // tables, which is where the "22" in earlier comments came from.
    expect(found).toHaveLength(EXPECTED_TABLE_COUNT)
    expect(found.sort()).toEqual([...TABLES].sort())
  })
})

describe('money is integer centavos in every column, without exception', () => {
  it('no numeric column anywhere is REAL except the three declared rate columns', () => {
    // The single most important assertion in this file. SQLite has no decimal type, so a
    // "harmless" extra column typed REAL becomes inexact arithmetic the moment anything sums
    // it, and nothing in the schema would say so.
    bootReal()
    const rateSet = new Set(RATE_COLUMNS)
    const offenders = []
    for (const table of TABLES) {
      for (const c of columnsOf(conn.db, table)) {
        if (c.type !== 'REAL') continue
        if (rateSet.has(`${table}.${c.name}`)) continue
        offenders.push(`${table}.${c.name} REAL`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the three rate columns are the REAL ones, and are bounded by a CHECK', () => {
    bootReal()
    for (const spec of RATE_COLUMNS) {
      const [table, name] = spec.split('.')
      expect(column(conn.db, table, name), spec).toMatchObject({ type: 'REAL' })
    }
    // Bounded at the schema, not the application: an unbounded REAL stores `2100` in a
    // column named iva_porcentaje and nothing about that number says "wrong".
    for (const bad of [2100, -1, 100.5]) {
      expect(() => ins(conn.db, 'productos', { nombre: 'p', precio_centavos: 1, iva_porcentaje: bad, user_id: 1, negocio_id: 1 }, 'r'), `iva=${bad}`).toThrow(/CHECK/)
    }
    expect(() => ins(conn.db, 'productos', { nombre: 'p', precio_centavos: 1, margen: -1, user_id: 1, negocio_id: 1 }, 'r')).toThrow(/CHECK/)
  })

  it('every money column is an INTEGER and carries the unit in its name', () => {
    bootReal()
    const expected = {
      productos: ['precio_centavos', 'precio_compra_centavos'],
      ventas: ['subtotal_centavos', 'iva_centavos', 'descuento_centavos', 'total_centavos', 'monto_recibido_centavos', 'monto_cambio_centavos'],
      ventas_detalles: ['precio_unitario_centavos', 'costo_unitario_centavos', 'descuento_centavos', 'subtotal_centavos'],
      compras: ['subtotal_centavos', 'iva_centavos', 'descuento_centavos', 'total_centavos'],
      compras_detalles: ['precio_unitario_centavos', 'subtotal_centavos'],
      cajas: ['saldo_inicial_centavos', 'saldo_final_centavos', 'total_ingresos_centavos', 'total_egresos_centavos'],
      movimientos_caja: ['monto_centavos', 'saldo_anterior_centavos', 'saldo_nuevo_centavos'],
      clientes_deudores: ['limite_credito_centavos'],
      pagos_deuda: ['monto_centavos'],
      cuentas_corrientes_deudas: ['monto_original_centavos', 'saldo_pendiente_centavos', 'monto_cuota_centavos'],
      pagos_deuda_contabilidad: ['monto_centavos'],
      asientos_contables: ['monto_total_centavos'],
      detalles_asientos: ['debe_centavos', 'haber_centavos']
    }
    for (const [table, names] of Object.entries(expected)) {
      for (const name of names) {
        const c = column(conn.db, table, name)
        expect(c, `${table}.${name} is missing`).toBeDefined()
        expect(c.type, `${table}.${name}`).toBe('INTEGER')
        expect(name.endsWith('_centavos'), `${table}.${name} must name its unit`).toBe(true)
      }
    }
  })

  it('no column is left with the bare name it had in the MySQL schema', () => {
    // `total` meaning 22061 instead of 220.61 is precisely the confusion the rename removes.
    bootReal()
    const bare = ['total', 'subtotal', 'precio', 'monto', 'iva', 'descuento', 'saldo_inicial']
    const offenders = []
    for (const table of TABLES) {
      for (const c of columnsOf(conn.db, table)) {
        if (bare.includes(c.name) && column(conn.db, table, c.name).type === 'INTEGER') {
          offenders.push(`${table}.${c.name}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('debe and haber are NOT NULL, because a NULL makes a row vanish from SUM()', () => {
    // The model declared neither, and SQLite infers nullable. SUM ignores NULL, so the row
    // would not break the trial balance — it would disappear from it, silently.
    bootReal()
    expect(column(conn.db, 'detalles_asientos', 'debe_centavos')['notnull']).toBe(1)
    expect(column(conn.db, 'detalles_asientos', 'haber_centavos')['notnull']).toBe(1)
  })

  it('double entry balances exactly, in integers', () => {
    bootReal()
    seedLedger(conn.db)
    // A REAL ledger drifts; an integer one does not. This is the whole justification.
    expect(balance(conn.db).diff).toBe(0)
    expect(balance(conn.db)).toMatchObject({ debe: 100, haber: 100 })
    // ...and the negative half too, which is where a float ledger silently goes wrong.
    ins(conn.db, 'detalles_asientos', { asiento_contable_id: 1, cuenta_contable_id: 2, debe_centavos: 0, haber_centavos: 7, negocio_id: 1 }, 'neg')
    expect(balance(conn.db).diff).toBe(-7)
  })
})

describe('debt balances are derived, never stored', () => {
  it('clientes_deudores has no deuda_total or deuda_pendiente column', () => {
    bootReal()
    const names = columnsOf(conn.db, 'clientes_deudores').map((c) => c.name)
    expect(names).not.toContain('deuda_total')
    expect(names).not.toContain('deuda_pendiente')
  })

  it('the view derives debt from credit sales minus payments', () => {
    bootReal()
    seedDeudor(conn.db)
    // Formula verified against venta.controller.js:288-305 and deudor.controller.js:321-338.
    ins(conn.db, 'ventas', { folio: 'F1', total_centavos: 10000, metodo_pago: 'credito', user_id: 1, negocio_id: 1, deudor_id: 1 }, 'c1')
    ins(conn.db, 'ventas', { folio: 'F2', total_centavos: 5000, metodo_pago: 'efectivo', user_id: 1, negocio_id: 1, deudor_id: 1 }, 'c2')
    ins(conn.db, 'pagos_deuda', { monto_centavos: 2500, deudor_id: 1, user_id: 1, negocio_id: 1 }, 'p1')
    // Cash sale is ignored: only `metodo_pago = 'credito'` creates debt.
    expect(viewRow(conn.db)).toEqual({ deuda_total_centavos: 10000, deuda_pendiente_centavos: 7500 })
  })

  it('a cancelled credit sale creates no debt', () => {
    bootReal()
    seedDeudor(conn.db)
    ins(conn.db, 'ventas', { folio: 'F1', total_centavos: 10000, metodo_pago: 'credito', user_id: 1, negocio_id: 1, deudor_id: 1, estado: 'cancelada' }, 'c1')
    expect(viewRow(conn.db)).toEqual({ deuda_total_centavos: 0, deuda_pendiente_centavos: 0 })
  })

  it('a soft-deleted credit sale creates no debt', () => {
    bootReal()
    seedDeudor(conn.db)
    ins(conn.db, 'ventas', { folio: 'F1', total_centavos: 10000, metodo_pago: 'credito', user_id: 1, negocio_id: 1, deudor_id: 1, deleted_at: '2026-01-01' }, 'c1')
    expect(viewRow(conn.db)).toEqual({ deuda_total_centavos: 0, deuda_pendiente_centavos: 0 })
  })

  it('a payment outliving its sale clamps at zero instead of showing a negative debt', () => {
    // Measured, not assumed: cancelling the only credit sale of a debtor who already paid
    // gives deuda_total 0, so the raw subtraction is negative. A debtor cannot owe the shop
    // minus 25 pesos, and `deudor.controller.js:282` already refuses overpayment.
    bootReal()
    seedDeudor(conn.db)
    ins(conn.db, 'ventas', { folio: 'F1', total_centavos: 10000, metodo_pago: 'credito', user_id: 1, negocio_id: 1, deudor_id: 1, estado: 'cancelada' }, 'c1')
    ins(conn.db, 'pagos_deuda', { monto_centavos: 2500, deudor_id: 1, user_id: 1, negocio_id: 1 }, 'p1')
    const row = viewRow(conn.db)
    // Clamped...
    expect(row.deuda_pendiente_centavos).toBe(0)
    // ...but the audit figure is NOT clamped, so the anomaly stays visible.
    expect(row.deuda_total_centavos).toBe(0)
  })

  it('a debtor with no sales and no payments is zero, not null', () => {
    bootReal()
    seedDeudor(conn.db)
    expect(viewRow(conn.db)).toEqual({ deuda_total_centavos: 0, deuda_pendiente_centavos: 0 })
  })
})

describe('users has no password column', () => {
  it('does not, because a NOT NULL one with no default blocks the first run', () => {
    bootReal()
    const names = columnsOf(conn.db, 'users').map((c) => c.name)
    expect(names).not.toContain('password')
  })

  it('the seeder no longer reports the password column as unresolved', () => {
    // A real boot, because this is the seeder's own output. The template copy was made from a
    // run where the column did not exist, so it cannot prove the seeder agrees.
    const base = mkdtempSync(path.join(tmpdir(), 'mm-schema-pw-'))
    const result = bootstrapDatabase({
      userDataPath: base, migrationsDir: MIGRATIONS_DIR,
      now: () => '2026-01-01T00:00:00.000Z'
    })
    try {
      expect(result.seeded.unresolved).toEqual([])
    } finally {
      result.conn.checkpointAndClose()
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('soft delete shape is exactly what the models declare', () => {
  it('paranoid tables have deleted_at', () => {
    bootReal()
    for (const t of PARANOID_TABLES) {
      expect(column(conn.db, t, 'deleted_at'), `${t}.deleted_at`).toBeDefined()
    }
  })

  it('non-paranoid tables do NOT have deleted_at', () => {
    // A `deleted_at` on a table the model never soft-deletes is a column a query could start
    // filtering on and get a wrong answer from.
    bootReal()
    for (const t of NON_PARANOID_TABLES) {
      expect(column(conn.db, t, 'deleted_at'), `${t} must not have deleted_at`).toBeUndefined()
    }
  })
})

describe('unique indexes are partial where the models scoped them', () => {
  it('a soft-deleted product releases its codigo for reuse', () => {
    // Plain UNIQUE would make soft delete mean "this code is burned forever", which is the
    // opposite of the point of a soft delete.
    bootReal()
    seedTenant(conn.db)
    ins(conn.db, 'productos', { nombre: 'A', codigo: 'CX1', precio_centavos: 1, user_id: 1, negocio_id: 1 }, 'a')
    expect(() => ins(conn.db, 'productos', { nombre: 'B', codigo: 'CX1', precio_centavos: 1, user_id: 1, negocio_id: 1 }, 'b')).toThrow(/UNIQUE/)
    conn.db.prepare(`UPDATE productos SET deleted_at = '2026-01-01' WHERE codigo = 'CX1'`).run()
    expect(() => ins(conn.db, 'productos', { nombre: 'C', codigo: 'CX1', precio_centavos: 1, user_id: 1, negocio_id: 1 }, 'c')).not.toThrow()
  })

  it('many products may have a NULL codigo', () => {
    // The `WHERE codigo IS NOT NULL` guard is load-bearing, not decoration: a plain UNIQUE
    // would let one NULL block every other product without a code.
    bootReal()
    seedTenant(conn.db)
    expect(() => {
      ins(conn.db, 'productos', { nombre: 'A', precio_centavos: 1, user_id: 1, negocio_id: 1 }, 'a')
      ins(conn.db, 'productos', { nombre: 'B', precio_centavos: 1, user_id: 1, negocio_id: 1 }, 'b')
    }).not.toThrow()
  })

  it('a repeated idempotency_key is refused, and unlimited NULL ones are allowed', () => {
    bootReal()
    seedTenant(conn.db)
    ins(conn.db, 'ventas', { folio: 'V1', idempotency_key: 'k1', user_id: 1, negocio_id: 1 }, 'v1')
    expect(() => ins(conn.db, 'ventas', { folio: 'V2', idempotency_key: 'k1', user_id: 1, negocio_id: 1 }, 'v2')).toThrow(/UNIQUE/)
    // SQLite treats NULLs as distinct in a unique index, which is the desired semantic here.
    expect(() => {
      ins(conn.db, 'ventas', { folio: 'V3', user_id: 1, negocio_id: 1 }, 'v3')
      ins(conn.db, 'ventas', { folio: 'V4', user_id: 1, negocio_id: 1 }, 'v4')
    }).not.toThrow()
  })

  it('suscripciones.negocio_id is unique, which is what makes hasOne true', () => {
    bootReal()
    seedTenant(conn.db)
    ins(conn.db, 'suscripciones', { negocio_id: 1 }, 's1')
    expect(() => ins(conn.db, 'suscripciones', { negocio_id: 1 }, 's2')).toThrow(/UNIQUE/)
  })
})

describe('foreign keys declared only in relations.js now actually fire', () => {
  it('ventas.caja_id rejects a caja that does not exist', () => {
    bootReal()
    seedTenant(conn.db)
    expect(() => ins(conn.db, 'ventas', { folio: 'V1', caja_id: 999, user_id: 1, negocio_id: 1 }, 'v')).toThrow(/FOREIGN KEY/)
  })

  it('ventas.deudor_id rejects a deudor that does not exist', () => {
    bootReal()
    seedTenant(conn.db)
    expect(() => ins(conn.db, 'ventas', { folio: 'V1', deudor_id: 999, user_id: 1, negocio_id: 1 }, 'v')).toThrow(/FOREIGN KEY/)
  })

  it('pagos_deuda.venta_id rejects a venta that does not exist', () => {
    bootReal()
    seedTenant(conn.db)
    expect(() => ins(conn.db, 'pagos_deuda', { monto_centavos: 1, deudor_id: 1, venta_id: 999, user_id: 1, negocio_id: 1 }, 'p')).toThrow(/FOREIGN KEY/)
  })

  it('auditoria keeps its ids unconstrained, so a CASCADE cannot erase history', () => {
    bootReal()
    expect(() => ins(conn.db, 'auditoria', { tabla: 'ventas', accion: 'CREATE', user_id: 999, negocio_id: 999 }, 'a')).not.toThrow()
  })
})

describe('enums are constrained in the schema, not only in the application', () => {
  it('refuses a metodo_pago that is not in the list', () => {
    bootReal()
    seedTenant(conn.db)
    expect(() => ins(conn.db, 'ventas', { folio: 'V1', metodo_pago: 'tarjetaa', user_id: 1, negocio_id: 1 }, 'v')).toThrow(/CHECK/)
  })

  it('pagos_deuda has no "credito", unlike ventas — faithful to the model', () => {
    // The two payment tables really do differ. "Helpfully" unifying them would let a credit
    // method be recorded as a payment.
    bootReal()
    seedTenant(conn.db)
    expect(() => ins(conn.db, 'pagos_deuda', { monto_centavos: 1, metodo_pago: 'credito', deudor_id: 1, user_id: 1, negocio_id: 1 }, 'p')).toThrow(/CHECK/)
    expect(() => ins(conn.db, 'ventas', { folio: 'V1', metodo_pago: 'credito', user_id: 1, negocio_id: 1 }, 'v')).not.toThrow()
  })

  it('pagos_deuda_contabilidad.metodo_pago is deliberately unconstrained TEXT', () => {
    // That table uses `STRING(30)` in the model, not an ENUM. Left free rather than given a
    // CHECK it never had.
    bootReal()
    expect(column(conn.db, 'pagos_deuda_contabilidad', 'metodo_pago').type).toBe('TEXT')
    seedTenant(conn.db)
    // The debt row first: this table's FK to `cuentas_corrientes_deudas` is RESTRICT-free but
    // real, and an absent parent is a FOREIGN KEY failure, not a metodo_pago failure.
    ins(conn.db, 'cuentas_corrientes_deudas', { id: 1, nombre: 'Prestamo', tipo: 'prestamo_bancario', monto_original_centavos: 1000, saldo_pendiente_centavos: 1000, fecha_inicio: '2026-01-01', negocio_id: 1, user_id: 1 }, 'd')
    expect(() => ins(conn.db, 'pagos_deuda_contabilidad', { cuenta_corriente_deuda_id: 1, monto_centavos: 1, fecha: '2026-01-01', metodo_pago: 'cualquiera', negocio_id: 1, user_id: 1 }, 'p')).not.toThrow()
  })

  it('a zero-valued cash movement is refused, because the model says min 0.01', () => {
    bootReal()
    seedTenant(conn.db)
    const row = { tipo: 'ingreso', concepto: 'c', monto_centavos: 0, saldo_anterior_centavos: 0, saldo_nuevo_centavos: 0, origen: 'manual', caja_id: 1, user_id: 1, negocio_id: 1 }
    expect(() => ins(conn.db, 'movimientos_caja', row, 'm')).toThrow(/CHECK/)
  })
})

describe('fractional quantities: the web cannot store these at all', () => {
  // `backend/src/models/venta.detalle.js:12` is `cantidad: { type: INTEGER, min: 1 }` while
  // `producto.js:112` allows `kg`/`l`. The web truncates a half-kilo line to 1 and decrements
  // stock by a whole unit (`PuntoVenta.jsx:615-616`). These tests are the mechanism that fixes it.
  it('a weighed sale line stores a fractional quantity, in thousandths', () => {
    bootReal()
    seedTenant(conn.db)
    ins(conn.db, 'productos', { nombre: 'Fideos', precio_centavos: 500, unidad_medida: 'kg', stock_milli: 10_000, user_id: 1, negocio_id: 1 }, 'p')
    ins(conn.db, 'ventas', { folio: 'V1', user_id: 1, negocio_id: 1 }, 'v')
    // 0.5 kg. The web cannot express this at all.
    expect(() => ins(conn.db, 'ventas_detalles', {
      cantidad_milli: 500, precio_unitario_centavos: 500, subtotal_centavos: 250, venta_id: 1, producto_id: 1
    }, 'd')).not.toThrow()
    const got = conn.db.prepare('SELECT cantidad_milli FROM ventas_detalles WHERE venta_id = 1').get()
    expect(got.cantidad_milli).toBe(500)
  })

  it('a zero or negative quantity is still refused, so min 1 is not lost in the rescale', () => {
    bootReal()
    seedTenant(conn.db)
    ins(conn.db, 'ventas', { folio: 'V1', user_id: 1, negocio_id: 1 }, 'v')
    for (const bad of [0, -1]) {
      expect(() => ins(conn.db, 'ventas_detalles', {
        cantidad_milli: bad, precio_unitario_centavos: 1, subtotal_centavos: 0, venta_id: 1
      }, 'd'), `cantidad_milli=${bad}`).toThrow(/CHECK/)
    }
  })

  it('stock is in the SAME unit as the quantity it is decremented by', () => {
    // The defect this guards is arithmetic, not schema: if a line is 500 milli-units and stock
    // is in whole units, `WHERE stock_milli >= cantidad_milli` compares 10 against 500 and
    // refuses every weight sale. Both columns must carry the ×1000.
    bootReal()
    seedTenant(conn.db)
    const cols = (t) => conn.db.prepare(`SELECT name FROM pragma_table_info(?)`).all(t).map((c) => c.name)
    expect(cols('productos')).toContain('stock_milli')
    expect(cols('productos')).toContain('stock_minimo_milli')
    expect(cols('productos')).not.toContain('stock')
    expect(cols('productos')).not.toContain('stock_minimo')
    for (const t of ['ventas_detalles', 'compras_detalles']) {
      expect(cols(t), t).toContain('cantidad_milli')
      expect(cols(t), t).not.toContain('cantidad')
    }
  })

  it('stock_minimo_milli defaults to 5000 — the model default of 5, in thousandths', () => {
    bootReal()
    seedTenant(conn.db)
    ins(conn.db, 'productos', { nombre: 'Lapiz', precio_centavos: 100, user_id: 1, negocio_id: 1 }, 'p')
    const got = conn.db.prepare('SELECT stock_milli, stock_minimo_milli FROM productos WHERE nombre = ?').get('Lapiz')
    expect(got.stock_minimo_milli).toBe(5000)
    expect(got.stock_milli).toBe(0)
  })

  it('es_pesable is derived from unidad_medida and cannot be written', () => {
    bootReal()
    seedTenant(conn.db)
    for (const [um, expected] of [['kg', 1], ['l', 1], ['g', 0], ['ml', 0], ['unidad', 0], ['caja', 0]]) {
      ins(conn.db, 'productos', { nombre: `p-${um}`, precio_centavos: 1, unidad_medida: um, user_id: 1, negocio_id: 1 }, um)
      const got = conn.db.prepare('SELECT es_pesable FROM productos WHERE nombre = ?').get(`p-${um}`)
      expect(got.es_pesable, `unidad_medida=${um}`).toBe(expected)
    }
    // A generated column cannot be assigned, in an INSERT or an UPDATE.
    expect(() => ins(conn.db, 'productos', { nombre: 'x', precio_centavos: 1, es_pesable: 1, user_id: 1, negocio_id: 1 }, 'x')).toThrow()
    expect(() => conn.db.prepare(`UPDATE productos SET es_pesable = 1 WHERE nombre = 'p-kg'`).run()).toThrow()
  })
})

describe('invariants the database owns, so application code cannot drift them', () => {
  it('at most one register may be open per business', () => {
    // The web serialises this with `SELECT ... FOR UPDATE`; SQLite has no row locks, so a
    // partial UNIQUE index is what replaces it. Two concurrent opens, one register.
    bootReal()
    seedTenant(conn.db) // already leaves caja 1 open
    const open = (tag) => ins(conn.db, 'cajas', { user_id: 1, usuario_apertura: 1, negocio_id: 1 }, tag)
    expect(open, 'a second open register in the same business').toThrow(/UNIQUE/)
    // A CLOSED register is not in conflict, and neither is a soft-deleted one.
    conn.db.prepare(`UPDATE cajas SET estado = 'cerrada'`).run()
    open('c2')
    conn.db.prepare(`UPDATE cajas SET deleted_at = '2026-01-01' WHERE estado = 'abierta'`).run()
    open('c3')
  })

  it('a movement is from a sale exactly when it carries one', () => {
    bootReal()
    seedTenant(conn.db)
    ins(conn.db, 'ventas', { folio: 'V1', user_id: 1, negocio_id: 1 }, 'v')
    const base = { tipo: 'ingreso', concepto: 'caja', monto_centavos: 100, saldo_anterior_centavos: 0, saldo_nuevo_centavos: 100, caja_id: 1, user_id: 1, negocio_id: 1 }
    // The consistent pairs are accepted...
    expect(() => ins(conn.db, 'movimientos_caja', { ...base, origen: 'venta', venta_id: 1 }, 'a')).not.toThrow()
    expect(() => ins(conn.db, 'movimientos_caja', { ...base, origen: 'manual' }, 'b')).not.toThrow()
    expect(() => ins(conn.db, 'movimientos_caja', { ...base, origen: 'compra' }, 'c')).not.toThrow()
    // ...and both inconsistent ones are refused. Neither direction is allowed to drift.
    expect(() => ins(conn.db, 'movimientos_caja', { ...base, origen: 'venta' }, 'd')).toThrow(/CHECK/)
    expect(() => ins(conn.db, 'movimientos_caja', { ...base, origen: 'manual', venta_id: 1 }, 'e')).toThrow(/CHECK/)
  })

  it('origen is a real column, not a generated one that could only say venta/manual', () => {
    // A generated column would have had to flatten 'compra' and 'caja_apertura' into
    // 'manual' and mislabelled every purchase payment in the till history.
    bootReal()
    seedTenant(conn.db)
    const [col] = conn.db.prepare(`SELECT name, "notnull" FROM pragma_table_info('movimientos_caja') WHERE name = 'origen'`).all()
    expect(col).toBeDefined()
    expect(col.notnull).toBe(1)
  })

  it('cuentas_contables.codigo is unique per business, not globally', () => {
    // The model's `unique: true` is a GLOBAL unique, which breaks the moment a second business
    // shares the file. Per business is the strictly more permissive choice.
    bootReal()
    seedTenant(conn.db)
    ins(conn.db, 'negocios', { nombre: 'Segundo', tipo_comercio: 'otro' }, 'n2')
    const mk = (negocioId, tag) => ins(conn.db, 'cuentas_contables', { codigo: '1.1', nombre: 'Caja', tipo: 'activo', negocio_id: negocioId, user_id: 1 }, tag)
    mk(1, 'a')
    expect(() => mk(1, 'b')).toThrow(/UNIQUE/)
    expect(() => mk(2, 'c')).not.toThrow()
  })

  it('a role outside the three real ones is refused, so a typo is not a silent nobody', () => {
    bootReal()
    expect(() => ins(conn.db, 'users', { nombre: 'X', email: 'x@minimarck.local', rol: 'Admin', negocio_id: 1 }, 'x')).toThrow(/CHECK/)
    for (const rol of ['admin', 'supervisor', 'vendedor']) {
      expect(() => ins(conn.db, 'users', { nombre: 'Y', email: `y-${rol}@minimarck.local`, rol, negocio_id: 1 }, rol)).not.toThrow()
    }
  })

  it('the four JSON columns refuse a malformed blob', () => {
    // Sequelize JSON into SQLite TEXT is an encoding contract. `json_valid` is what turns a
    // convention into something the database enforces.
    bootReal()
    expect(() => ins(conn.db, 'negocios', { nombre: 'N', tipo_comercio: 'otro', configuracion: '{oops' }, 'n')).toThrow(/CHECK/)
    expect(() => ins(conn.db, 'negocios', { nombre: 'N2', tipo_comercio: 'otro', configuracion: '{"a":1}' }, 'n2')).not.toThrow()
    expect(() => ins(conn.db, 'auditoria', { tabla: 'ventas', accion: 'CREATE', valores_nuevos: 'not json' }, 'a')).toThrow(/CHECK/)
    // NULL stays legal: "no previous values" is not a malformed document.
    expect(() => ins(conn.db, 'auditoria', { tabla: 'ventas', accion: 'CREATE' }, 'a2')).not.toThrow()
    expect(() => ins(conn.db, 'suscripciones', { negocio_id: 1, features: '[' }, 's')).toThrow(/CHECK/)
  })

  it('cash taken and change handed back are nullable, so "no cash" is not "zero cash"', () => {
    bootReal()
    seedTenant(conn.db)
    ins(conn.db, 'ventas', { folio: 'V1', user_id: 1, negocio_id: 1 }, 'v')
    expect(() => ins(conn.db, 'ventas', { folio: 'V2', user_id: 1, negocio_id: 1 }, 'v2')).not.toThrow()
    ins(conn.db, 'ventas', { folio: 'V3', monto_recibido_centavos: 5000, monto_cambio_centavos: 1234, user_id: 1, negocio_id: 1 }, 'v3')
    const got = conn.db.prepare('SELECT folio, monto_recibido_centavos, monto_cambio_centavos FROM ventas WHERE folio IN (?, ?) ORDER BY folio').all('V1', 'V3')
    expect(got[0].monto_recibido_centavos).toBeNull()
    expect(got[1].monto_recibido_centavos).toBe(5000)
    expect(got[1].monto_cambio_centavos).toBe(1234)
  })
})

describe('bounds the model does not have are not invented', () => {
  it('a till may go negative, because a shop can spend more cash than it held', () => {
    // `MovimientoCaja.js` declares NO minimum on `saldoAnterior` or `saldoNuevo`. A `>= 0`
    // bound here would leave that register permanently unable to close. This is the one
    // removed constraint that was a genuine defect rather than a theoretical one.
    bootReal()
    seedTenant(conn.db)
    expect(() => ins(conn.db, 'movimientos_caja', {
      tipo: 'egreso', concepto: 'pago', monto_centavos: 5000,
      saldo_anterior_centavos: 1000, saldo_nuevo_centavos: -4000,
      origen: 'manual', caja_id: 1, user_id: 1, negocio_id: 1
    }, 'm')).not.toThrow()
  })

  it('the other model-less bounds stay off: asientos, ledger lines, shop debt, contab payments', () => {
    bootReal()
    seedTenant(conn.db)
    // asientos_contables.montoTotal — no minimum in asientoContable.js
    expect(() => ins(conn.db, 'asientos_contables', { fecha: '2026-01-01', descripcion: 'd', tipo: 'apertura', monto_total_centavos: -1, negocio_id: 1, user_id: 1 }, 'a')).not.toThrow()
    // cuentas_corrientes_deudas — no minimum on any money column
    expect(() => ins(conn.db, 'cuentas_corrientes_deudas', { nombre: 'P', tipo: 'otro', monto_original_centavos: -1, saldo_pendiente_centavos: -1, fecha_inicio: '2026-01-01', negocio_id: 1, user_id: 1 }, 'd')).not.toThrow()
    // pagos_deuda_contabilidad.monto — no minimum in pagoDeudaContabilidad.js
    const deudaId = conn.db.prepare('SELECT id FROM cuentas_corrientes_deudas LIMIT 1').get().id
    expect(() => ins(conn.db, 'pagos_deuda_contabilidad', { cuenta_corriente_deuda_id: deudaId, monto_centavos: 0, fecha: '2026-01-01', metodo_pago: 'x', negocio_id: 1, user_id: 1 }, 'p')).not.toThrow()
  })
})

describe('the file itself stays honest', () => {
  it('every CHECK that matters is actually in the SQL text', () => {
    // Guards against a refactor that drops a constraint from the prose but not the DDL.
    const sql = readFileSync(INIT_SQL, 'utf8')
    expect(sql).toMatch(/debe_centavos\s+INTEGER NOT NULL/)
    expect(sql).toMatch(/haber_centavos\s+INTEGER NOT NULL/)
    expect(sql).toMatch(/iva_porcentaje\s+REAL/)
    expect(sql).toMatch(/monto_centavos >= 1/)
  })
})

// ---------------------------------------------------------------- helpers

function ins(db, table, obj, tag) {
  const keys = Object.keys(obj)
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
  db.prepare(sql).run(...keys.map((k) => obj[k]))
}

function viewRow(db) {
  const r = db.prepare('SELECT deuda_total_centavos, deuda_pendiente_centavos FROM v_clientes_deudores WHERE id = 1').get()
  return { deuda_total_centavos: r.deuda_total_centavos, deuda_pendiente_centavos: r.deuda_pendiente_centavos }
}

function balance(db) {
  const r = db.prepare('SELECT COALESCE(SUM(debe_centavos),0) AS debe, COALESCE(SUM(haber_centavos),0) AS haber FROM detalles_asientos').get()
  // A balanced entry has SUM(debe) == SUM(haber), not two zeros. The invariant is the
  // DIFFERENCE, which is what the trial balance actually checks.
  return { debe: r.debe, haber: r.haber, diff: r.debe - r.haber }
}

/**
 * The bootstrap already seeded negocio 1 and admin 1. These tests build ON TOP of a real first
 * run instead of replacing it, so the seeder stays exercised rather than being bypassed.
 * (The first version inserted its own `negocios` row and collided on `id`, which would have
 * masked every failure behind a UNIQUE violation.)
 */
function seedTenant(db) {
  const neg = db.prepare('SELECT id FROM negocios WHERE id = 1').get()
  const usr = db.prepare('SELECT id FROM users WHERE id = 1').get()
  expect(neg, 'the seeder must have created negocio 1').toBeDefined()
  expect(usr, 'the seeder must have created admin user 1').toBeDefined()
  ins(db, 'cajas', { id: 1, user_id: usr.id, usuario_apertura: usr.id, negocio_id: neg.id }, 'c')
  return { negocioId: neg.id, userId: usr.id }
}

function seedDeudor(db) {
  seedTenant(db)
  ins(db, 'clientes_deudores', { id: 1, nombre: 'D', user_id: 1, negocio_id: 1 }, 'd')
}

function seedLedger(db) {
  seedTenant(db)
  for (const [i, codigo] of ['1', '2', '3'].entries()) {
    ins(db, 'cuentas_contables', { id: i + 1, codigo, nombre: `c${i}`, tipo: 'activo', negocio_id: 1, user_id: 1 }, `cc${i}`)
  }
  ins(db, 'asientos_contables', { id: 1, fecha: '2026-01-01', descripcion: 'd', tipo: 'apertura', monto_total_centavos: 100, negocio_id: 1, user_id: 1 }, 'as')
  ins(db, 'detalles_asientos', { asiento_contable_id: 1, cuenta_contable_id: 1, debe_centavos: 100, negocio_id: 1 }, 'd1')
  ins(db, 'detalles_asientos', { asiento_contable_id: 1, cuenta_contable_id: 2, haber_centavos: 100, negocio_id: 1 }, 'd2')
}
