/**
 * Prepare a THROWAWAY shop file for a manual test run, inside this workspace.
 *
 * WHY A SCRIPT AND NOT THE SIGN-IN PANEL. The panel is the real path and it works, but "run it and
 * give me a password" has to end with a password that is ALREADY known, and the panel's first step
 * is asking a human to choose one. This does the same three writes the panel does — migrate, seed,
 * `auth.register` — through the SAME functions, so the profile it produces is the profile the app
 * would have produced, minus the typing.
 *
 * IT NEVER TOUCHES %APPDATA%. The profile lives under `run/perfil-prueba/` inside the repository,
 * which is where the sandbox allows writes and where `db:reset`-style accidents cannot reach the
 * shop's real file. `MINIMARCK_DATA_DIR` is the supported override (`dataDir.js` PLAT-2) and it
 * moves only the data base, never the Electron profile.
 *
 * IDEMPOTENT, AND GUARDED. Re-running it on a profile that already has credentials does not create
 * a second owner (`auth.register` refuses with `YA_CONFIGURADO`); the script reports that and exits
 * 0, because "the account is already there" is a success for a setup step.
 *
 * Usage:
 *   node scripts/perfil-de-prueba.mjs                 # owner "duena" / "Prueba-2026-MiniMarck"
 *   node scripts/perfil-de-prueba.mjs --reset         # delete the profile first, then recreate it
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, readFileSync, rmSync } from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const PERFIL = path.join(root, 'run', 'perfil-prueba')

// The credentials this script leaves behind. Handed to a person, so they are readable on purpose;
// `passwords.js` only enforces a minimum length and a maximum, not complexity theatre.
const USUARIO = 'duena'
const PASSWORD = 'Prueba-2026-MiniMarck'
const NEGOCIO = 'Almacen de Prueba'
const PERSONA = 'Duena de Prueba'

if (process.argv.includes('--reset')) {
  console.log(`perfil: borrando ${PERFIL}`)
  rmSync(PERFIL, { recursive: true, force: true })
}

const load = (rel) => import(pathToFileURL(path.join(root, rel)).href)

const { bootstrapDatabase } = await load('src/main/db/bootstrap.js')
const { createSession } = await load('src/main/auth/session.js')
const { registrar, login, me } = await load('src/main/auth/auth.service.js')
const { tablesCreatedBy } = await load('src/main/db/migrate.js')
const productos = await load('src/main/db/repositories/productos.repo.js')
const { CATALOGO_DEMO, demoToProductoInput } = await load('src/shared/demo-catalogo.js')

/**
 * Migrations come from SOURCE, not from `out/`. The packaged copy is what the installer runs and
 * `verify:migrations` already proves the two trees are byte-identical, so pointing at the source
 * here means this script works on a clean checkout with no build.
 */
const migrationsDir = path.join(root, 'src', 'main', 'db', 'migrations')
const TABLES = tablesCreatedBy(readFileSync(path.join(migrationsDir, '001_init.sql'), 'utf8'))
const TABLES_002 = tablesCreatedBy(readFileSync(path.join(migrationsDir, '002_identidades.sql'), 'utf8'))

console.log('perfil de prueba de MiniMarck')
console.log(`  carpeta : ${PERFIL}`)

const db = bootstrapDatabase({
  userDataPath: PERFIL,
  migrationsDir,
  tables: [...TABLES, ...TABLES_002]
})

const { conn, paths, migration, seeded } = db
console.log(`  archivo : ${paths.dbFile}`)
console.log(`  schema  : user_version = ${conn.userVersion()} (${migration.applied.length} migracion(es))`)
console.log(`  seed    : ${seeded.seeded ? `negocio #${seeded.negocioId}, admin #${seeded.userId}` : `no (${seeded.reason})`}`)

try {
  const session = createSession(conn)
  let cuenta

  try {
    cuenta = registrar(conn, session, {
      nombre: PERSONA,
      negocioNombre: NEGOCIO,
      nombreAcceso: USUARIO,
      password: PASSWORD
    })
    console.log(`  alta    : dueña creada (negocio "${cuenta.negocioNombre}", adopto negocio del seed: ${cuenta.adoptoNegocioExistente})`)
  } catch (err) {
    if (err?.code === 'YA_CONFIGURADO') {
      console.log('  alta    : este perfil YA tiene credenciales; no se crea un segundo dueño.')
      const ok = login(conn, session, { nombre: USUARIO, password: PASSWORD })
      console.log(`  login   : verificado como "${USUARIO}" (${ok.rol})`)
    } else {
      throw err
    }
  }

  // Same verification the app does on every launch: a session that does not resolve is not a
  // session, and printing the credentials without checking them is how a "handed over" password
  // turns out to be the wrong one.
  const quien = me(conn, session)
  if (!quien?.user) throw new Error('la sesion no resuelve: auth.me devolvio vacio')

  // `auth.me` builds `user` by hand and drops `negocioId`, so the tenant is the one `me` reports
  // for the BUSINESS plus the id the session itself carries. `Number()` is not cosmetic:
  // `lastInsertRowid` is a BigInt and `node:sqlite` refuses to bind one.
  const negocioId = Number(quien.negocio?.id ?? cuenta?.negocioId)
  const actorId = Number(quien.user.id)
  if (!Number.isSafeInteger(negocioId) || !Number.isSafeInteger(actorId)) {
    throw new Error(`tenant u operador irresolubles: negocioId=${negocioId} actorId=${actorId}`)
  }

  const ctx = { db: conn.db, tx: conn.tx, negocioId, actorId }
  let creados = 0
  for (const p of CATALOGO_DEMO) {
    const ya = conn.db
      .prepare('SELECT id FROM productos WHERE negocio_id = ? AND codigo = ?')
      .get(negocioId, p.codigo)
    if (ya) continue
    productos.crear(ctx, demoToProductoInput(p))
    creados += 1
  }
  const total = conn.db
    .prepare('SELECT count(*) AS n FROM productos WHERE negocio_id = ? AND deleted_at IS NULL')
    .get(negocioId).n

  // Log out explicitly: the app opens SIGNED OUT by design, and a script that left a session in a
  // file would be describing a state the app can never be in (`index.js` creates the session in
  // memory on every launch).
  console.log(`  catalogo: ${creados} producto(s) creado(s), ${total} en total`)
  console.log('')
  console.log('CREDENCIALES')
  console.log(`  usuario  : ${USUARIO}`)
  console.log(`  password : ${PASSWORD}`)
  console.log(`  negocio  : ${quien.negocio?.nombre ?? NEGOCIO}`)
  console.log(`  rol      : ${quien.user.rol}`)
  console.log('')
  console.log('LANZAR')
  console.log(`  $env:MINIMARCK_DATA_DIR="${PERFIL}"; .\\node_modules\\electron\\dist\\electron.exe .`)
} catch (err) {
  console.error(`perfil FAILED — ${err && err.message ? err.message : err}`)
  if (err && err.code) console.error(`  code: ${err.code}`)
  process.exitCode = 1
} finally {
  try {
    conn.checkpointAndClose()
  } catch {
    /* the report above is the result */
  }
}

if (!existsSync(PERFIL)) process.exitCode = 1
