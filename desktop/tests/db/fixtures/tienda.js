import { mkdtempSync, rmSync, copyFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { bootstrapDatabase } from '../../../src/main/db/bootstrap.js'
import { openDatabase } from '../../../src/main/db/connection.js'
import { tablesCreatedBy } from '../../../src/main/db/migrate.js'
import { abrir } from '../../../src/main/db/repositories/cajas.repo.js'

/**
 * A REAL shop database for one test: fully migrated, seeded with the default business and
 * admin, and — per test — a fresh COPY.
 *
 * The copy is the point, and the reason is the one `tests/db/schema.spec.js` already documents:
 * on Windows, running the full migrate + WAL + checkpoint + close cycle once per test exhausts
 * file handles and makes the suite FLAKY, and a flaky test teaches you to re-run instead of
 * read. The template is booted once per process; each test copies the checkpointed file and
 * opens its own connection. Everything in these specs is REAL SQLite — there is no mock
 * anywhere in the fixture.
 */

/**
 * Resolve a path inside this package, from the process CWD.
 *
 * This used to be a `fileURLToPath(new URL('../../..', import.meta.url))` walk, which is the
 * usual way and which still works under `environment: 'node'`. It stopped working the moment
 * `tests/ui/` arrived: under the jsdom environment Vite rewrites the module's URL machinery and
 * the walk produced `tests/db/fixtures/undefined` — a path that is at least honest about being
 * wrong, which is more than `The URL must be of scheme file` was.
 *
 * The CWD is the better anchor anyway. Vitest roots every run at the package directory, that
 * directory is the one that holds `src/main/db/migrations`, and `existsSync` below turns any
 * future mistake into a sentence that says which file was looked for and where, instead of an
 * ENOENT with a path nobody can interpret.
 */
function enPaquete(...partes) {
  return path.resolve(process.cwd(), ...partes)
}

const MIGRATIONS_DIR = enPaquete('src', 'main', 'db', 'migrations')
const INIT_SQL = enPaquete('src', 'main', 'db', 'migrations', '001_init.sql')

if (!existsSync(INIT_SQL)) {
  throw new Error(
    `No se encuentra la migración inicial en ${INIT_SQL}. ` +
      `La fixture se ancla en el CWD (${process.cwd()}); corré los tests desde desktop/.`
  )
}

/**
 * The same 20-table census `schema.spec.js` carries, derived from the ACTUAL migration file
 * instead of retyped. If the migration ever creates a 21st table, `bootstrapDatabase` widens the
 * allowlist through `tablesCreatedBy` and the fixture follows automatically — a retyped list is
 * how a census and a migration drift apart.
 */
export const TABLES = tablesCreatedBy(readFileSync(INIT_SQL, 'utf8'))

let templateDir = null
let templateDb = null
let templateSeed = null

function bootTemplate() {
  if (templateDb) return
  templateDir = mkdtempSync(path.join(tmpdir(), 'mm-tienda-template-'))
  const r = bootstrapDatabase({
    userDataPath: templateDir,
    migrationsDir: MIGRATIONS_DIR,
    now: () => '2026-01-01T00:00:00.000Z'
  })
  r.conn.checkpointAndClose()
  templateDb = r.paths.dbFile
  templateSeed = r.seeded
}

/** A fresh, fully migrated and seeded database in its own directory. */
export function tienda() {
  bootTemplate()
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-tienda-'))
  const file = path.join(dir, 'tienda.db')
  copyFileSync(templateDb, file)
  const conn = openDatabase(file, { walFile: `${file}-wal`, tables: [...TABLES] })
  return {
    conn,
    dir,
    /** The seeded default business and operator — the tenant every repository scopes by. */
    negocioId: templateSeed.negocioId,
    usuarioId: templateSeed.userId,
    /** Checkpoint + close + delete. Call in `afterEach`. */
    cerrar() {
      try {
        conn.checkpointAndClose()
      } catch {
        /* the assertion, not the close, is what the test is about */
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** An `{ db, tx, negocioId, actorId }` context over a running shop. */
export function ctxDe(t, negocioId, actorId) {
  return {
    db: t.conn.db,
    tx: t.conn.tx,
    negocioId,
    actorId
  }
}

/** Insert a product the tests sell: returns its row. */
export function insertarProducto(t, { negocioId, usuarioId, overrides = {} }) {
  const info = t.conn.db
    .prepare(
      `INSERT INTO productos
         (nombre, precio_centavos, precio_compra_centavos, stock_milli, stock_minimo_milli,
          unidad_medida, tiene_iva, iva_porcentaje, margen, activo, user_id, negocio_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 5000, 'kg', 1, 21, 30, 1, ?, ?, ?, ?)`
    )
    .run(
      overrides.nombre ?? 'Queso artesanal',
      overrides.precio_centavos ?? 20000,
      overrides.precio_compra_centavos ?? 12000,
      overrides.stock_milli ?? 3000,
      usuarioId,
      negocioId,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    )
  return t.conn.db.prepare('SELECT * FROM productos WHERE id = ?').get(Number(info.lastInsertRowid))
}

/** Open the till through the REPO, so a test never seeds a till the app could not have produced. */
export function abrirCaja(t, { negocioId, usuarioId, saldoInicialCentavos = 50000 } = {}) {
  // `abrir` speaks PESOS (the renderer's language), like every repository entry point; tests
  // think in centavos, so the conversion happens here and stays in one place.
  return abrir(
    { db: t.conn.db, tx: t.conn.tx, negocioId, actorId: usuarioId },
    { saldoInicial: saldoInicialCentavos / 100 }
  )
}

/**
 * Insert a debtor for credit sales; returns the row.
 *
 * `documento` DEFAULTS TO NULL, and that is a change: it used to be a hardcoded `'28456789'`, which
 * made the second call in one test shop fail on `ux_clientes_deudores_documento` — a fixture that
 * refuses to be called twice is a fixture that quietly limits a test to one customer. Most tests
 * are not about the document, so it passes one when it is.
 */
export function insertarDeudor(
  t,
  { negocioId, usuarioId, nombre = 'Juan Carlos Pérez', documento = null, limiteCreditoCentavos = 100000 }
) {
  const ts = '2026-01-01T00:00:00.000Z'
  const info = t.conn.db
    .prepare(
      `INSERT INTO clientes_deudores
         (nombre, documento, limite_credito_centavos, notas, user_id, negocio_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`
    )
    .run(nombre, documento, limiteCreditoCentavos, usuarioId, negocioId, ts, ts)
  return t.conn.db.prepare('SELECT * FROM clientes_deudores WHERE id = ?').get(Number(info.lastInsertRowid))
}

/** The line totals SQLite itself computes, straight from the columns — the DB's own verdict. */
export function saldosAsiento(conn, asientoId) {
  const row = conn.db
    .prepare(
      `SELECT COALESCE(SUM(debe_centavos), 0) AS debe, COALESCE(SUM(haber_centavos), 0) AS haber
         FROM detalles_asientos WHERE asiento_contable_id = ?`
    )
    .get(asientoId)
  return { debe: row.debe, haber: row.haber }
}

/** Every `detalles_asientos` row for one business, for a whole-ledger identity check. */
export function partidasDe(t, negocioId) {
  return t.conn.db
    .prepare(
      `SELECT d.debe_centavos AS debe, d.haber_centavos AS haber, c.codigo, c.tipo
         FROM detalles_asientos d
         JOIN cuentas_contables c ON c.id = d.cuenta_contable_id
        WHERE d.negocio_id = ?
        ORDER BY d.asiento_contable_id, d.id`
    )
    .all(negocioId)
}