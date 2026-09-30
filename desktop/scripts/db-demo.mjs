/**
 * `npm run db:demo` — put a small, DELIBERATE catalog in the real shop file so the till can be
 * rung up by hand.
 *
 * WHY THIS IS A COMMAND AND NOT A SEED. `src/main/db/seed.js` is the first-run seed and it is
 * right to stay empty of products: a shop's database must contain what the shop has, and a
 * startup routine that invented stock would put fictitious kilos on a real shelf. That decision
 * is recorded as PLAT-1 and this script does not touch it.
 *
 * But an empty grid is also a screen nobody can evaluate. The POS on a fresh profile shows
 * «No se encontraron productos», there is nothing to click, and the only honest description of
 * the sale flow would be a sentence in a document. So the catalog is opt-in: a person types this
 * command, knows exactly what it did, and `db:reset` throws it away.
 *
 * THE CATALOG GOES IN THROUGH THE REPOSITORIES, not through raw INSERTs. That is the whole point
 * of using this route: `productos.crear` is the code the app runs, so a demo product cannot
 * differ from a real one in a column the seed forgot. Every price below is in PESOS, because
 * that is the unit `productos.crear` takes.
 *
 * IDEMPOTENT by barcode. Re-running it reports what already exists and does not duplicate: a
 * second run must not quietly double the stock of a shop that has started selling.
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const { resolveDataPaths } = await import(pathToFileURL(path.join(root, 'src', 'main', 'dataDir.js')).href)
const { openDatabase } = await import(pathToFileURL(path.join(root, 'src', 'main', 'db', 'connection.js')).href)
const { tablesCreatedBy } = await import(pathToFileURL(path.join(root, 'src', 'main', 'db', 'migrate.js')).href)
const { resolveLocalIdentity } = await import(
  pathToFileURL(path.join(root, 'src', 'main', 'db', 'identity.js')).href
)
const productos = await import(
  pathToFileURL(path.join(root, 'src', 'main', 'db', 'repositories', 'productos.repo.js')).href
)
const { DEFAULT_ADMIN, DEFAULT_NEGOCIO } = await import(
  pathToFileURL(path.join(root, 'src', 'main', 'db', 'seed.js')).href
)
const { readFileSync } = await import('node:fs')

const TABLES = tablesCreatedBy(
  readFileSync(path.join(root, 'src', 'main', 'db', 'migrations', '001_init.sql'), 'utf8')
)

/**
 * The demo shop catalogue is NOT defined here. It lives in `src/shared/demo-catalogo.js` and is
 * imported, so this terminal route and the renderer's first-run button seed byte-identical data.
 * Two copies would drift, and the day they did, the button in the app would load a catalogue the
 * script no longer matched.
 */
const { CATALOGO_DEMO, demoToProductoInput } = await import('../src/shared/demo-catalogo.js')

const paths = resolveDataPaths(process.env.APPDATA ? path.join(process.env.APPDATA, 'MiniMarck') : '', process.env)
if (!paths.dbFile) {
  console.error('db:demo — no hay una base de datos todavia. Lanzá la app una vez (npm run launch) y repetí.')
  process.exit(1)
}

const conn = openDatabase(paths.dbFile, { walFile: `${paths.dbFile}-wal`, tables: [...TABLES] })

try {
  const identity = resolveLocalIdentity(conn)
  if (!identity.negocioId || !identity.actorId) {
    console.error('db:demo — la base no tiene un negocio resoluble. Corré db:reset y lanzá la app.')
    process.exit(1)
  }
  const ctx = {
    db: conn.db,
    tx: conn.tx,
    negocioId: identity.negocioId,
    actorId: identity.actorId
  }

  console.log('db:demo — catalogo de prueba (opt-in, se borra con db:reset)')
  console.log(`  negocio : ${identity.negocioNombre} (${DEFAULT_NEGOCIO.nombre === identity.negocioNombre ? identity.negocioNombre : identity.negocioNombre})`)
  console.log(`  operador: ${identity.operadorNombre} (${identity.rol})`)
  console.log(`  archivo : ${paths.dbFile}`)
  console.log('')

  const creados = []
  const existentes = []
  for (const p of CATALOGO_DEMO) {
    const yaEsta = conn.db
      .prepare('SELECT id FROM productos WHERE negocio_id = ? AND codigo = ?')
      .get(ctx.negocioId, p.codigo)
    if (yaEsta) {
      existentes.push(p.nombre)
      continue
    }
    productos.crear(ctx, demoToProductoInput(p))
    creados.push(p.nombre)
  }

  console.log(`  creados  (${creados.length}): ${creados.join(', ') || '—'}`)
  console.log(`  ya estaban (${existentes.length}): ${existentes.join(', ') || '—'}`)
  console.log('')
  console.log('Ahora `npm run launch`: abrí la caja con un fondo, hacé una venta y mirá /ventas.')
} catch (err) {
  console.error(`db:demo FAILED — ${err && err.message ? err.message : err}`)
  if (err && err.code) console.error(`  code: ${err.code}`)
  process.exitCode = 1
} finally {
  try {
    conn.checkpointAndClose()
  } catch {
    /* the report above is the result; the close is housekeeping */
  }
}
