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
 * The demo shop. Prices are pesos, quantities are kilos, and the weighed ones are weighed ON
 * PURPOSE: the scale is the part of this app that had two silent, million-times bugs, and a
 * catalog without a weighed product would let both come straight back.
 */
const CATALOGO = [
  { nombre: 'Queso artesanal', codigo: '7790123000015', precio: 2000, costo: 1200, stock: 12, unidad: 'kg' },
  { nombre: 'Pan de molde', codigo: '7790123000022', precio: 850, costo: 500, stock: 40, unidad: 'unidad' },
  { nombre: 'Leche entera 1 L', codigo: '7790123000039', precio: 1200, costo: 900, stock: 60, unidad: 'unidad' },
  { nombre: 'Gaseosa 500 ml', codigo: '7790123000046', precio: 900, costo: 650, stock: 144, unidad: 'unidad' },
  { nombre: 'Fideos 500 g', codigo: '7790123000053', precio: 750, costo: 480, stock: 80, unidad: 'unidad' },
  { nombre: 'Aceite 900 ml', codigo: '7790123000060', precio: 2400, costo: 1900, stock: 24, unidad: 'unidad' }
]

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
  for (const p of CATALOGO) {
    const yaEsta = conn.db
      .prepare('SELECT id FROM productos WHERE negocio_id = ? AND codigo = ?')
      .get(ctx.negocioId, p.codigo)
    if (yaEsta) {
      existentes.push(p.nombre)
      continue
    }
    productos.crear(ctx, {
      nombre: p.nombre,
      codigo: p.codigo,
      precio: p.precio,
      precioCompra: p.costo,
      stock: p.stock,
      unidadMedida: p.unidad,
      stockMinimo: p.unidad === 'kg' ? 1 : 5
    })
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
