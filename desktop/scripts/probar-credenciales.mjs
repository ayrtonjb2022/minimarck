/**
 * Prove that the credentials handed to a person actually open the file.
 *
 * WHY THIS EXISTS. `perfil-de-prueba.mjs` CREATES the owner, and creating is not the same as
 * logging in: a password can hash correctly and still be typed wrong in the handover. So this
 * calls `auth.login` twice — once with a deliberately WRONG password, which must be REFUSED, and
 * once with the real one — because a check that only tries the correct case cannot tell "the
 * password works" from "this function accepts anything".
 *
 * It is the negative case that makes the positive one mean something. Same rule the project applies
 * to every verifier in `scripts/`.
 *
 * Read-only in intent: `login` writes `ultimo_acceso` and may re-derive the secret under the
 * current policy, both of which the app does on a real sign-in. Nothing else is touched.
 *
 * Usage: node scripts/probar-credenciales.mjs
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const PERFIL = path.join(root, 'run', 'perfil-prueba')

const USUARIO = 'duena'
const PASSWORD = 'Prueba-2026-MiniMarck'
const INCORRECTA = 'no-es-la-clave'
const PERSONA = 'Duena de Prueba'

const load = (rel) => import(pathToFileURL(path.join(root, rel)).href)
const { resolveDataPaths } = await load('src/main/dataDir.js')
const { openDatabase } = await load('src/main/db/connection.js')
const { tablesCreatedBy } = await load('src/main/db/migrate.js')
const { createSession } = await load('src/main/auth/session.js')
const { login } = await load('src/main/auth/auth.service.js')

/**
 * THE ALLOWLIST HAS TO BE PASSED, and getting this wrong is how the first version of this script
 * reported a FALSE FAILURE. `openDatabase(..., { tables: [] })` opens with the authorizer in its
 * deny-all state, so `auth.login`'s very first `SELECT` against `user_identidades` is refused with
 * a bare "not authorized" — a correct refusal that has nothing to do with the password being
 * wrong. `login` is a WRITE path (it stamps `ultimo_acceso` and may re-derive the secret), so the
 * tables have to be allowlisted the same way `bootstrapDatabase` and `db:demo` do it: derived from
 * the migration text, never typed by hand.
 */
const dirMigrations = path.join(root, 'src', 'main', 'db', 'migrations')
const TABLES = [
  ...tablesCreatedBy(readFileSync(path.join(dirMigrations, '001_init.sql'), 'utf8')),
  ...tablesCreatedBy(readFileSync(path.join(dirMigrations, '002_identidades.sql'), 'utf8'))
]

const paths = resolveDataPaths(PERFIL, {})
const conn = openDatabase(paths.dbFile, { walFile: paths.walFile, tables: TABLES })
let fallos = 0

const check = (nombre, ok, detalle) => {
  if (!ok) fallos += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${nombre}${detalle ? ` — ${detalle}` : ''}`)
}

try {
  const sesion = createSession(conn)

  // NEGATIVE CONTROL FIRST. If this passes, the positive case below proves nothing.
  let rechazada = null
  try {
    login(conn, sesion, { nombre: USUARIO, password: INCORRECTA })
    rechazada = false
  } catch (err) {
    rechazada = err?.code ?? err?.name ?? 'error'
  }
  check('una contraseña incorrecta es RECHAZADA', rechazada !== false, `codigo=${rechazada}`)

  let quien = null
  try {
    const r = login(conn, sesion, { nombre: USUARIO, password: PASSWORD })
    quien = r
  } catch (err) {
    check('la contraseña correcta entra', false, err?.message ?? String(err))
  }
  check('la contraseña correcta entra', Boolean(quien), quien ? `rol=${quien.rol} id=${quien.id}` : 'sin sesion')
  // `sesionPublica` carries the PERSON's name, deliberately: the person who signs in is the one
  // stamped on every row they write, and the sign-in handle is the credential, not the audit name.
  // So the assertion is against the display name, and the handle is asserted by the fact that the
  // login call above was made WITH it.
  check('la sesion resuelve a la persona esperada', quien?.nombre === PERSONA, `nombre=${quien?.nombre}`)
  check('el rol es admin (puede abrir caja y crear empleados)', quien?.rol === 'admin', `rol=${quien?.rol}`)

  const productos = conn.db.prepare('SELECT count(*) AS n FROM productos WHERE deleted_at IS NULL').get().n
  check('el catalogo de ejemplo esta cargado', productos === 6, `${productos} producto(s)`)

  const identidades = conn.db.prepare('SELECT count(*) AS n FROM user_identidades').get().n
  check('hay exactamente una credencial', identidades === 1, `${identidades} fila(s)`)

  // The password must not be stored anywhere, which is the claim `passwords.js` makes. Scanning the
  // file itself is the version of that check a person can act on.
  const bytes = (await import('node:fs')).readFileSync(paths.dbFile)
  check('la contraseña no aparece en el archivo', !bytes.includes(Buffer.from(PASSWORD)), 'busqueda literal en los bytes')
} finally {
  try {
    conn.checkpointAndClose()
  } catch {
    /* reported above */
  }
}

console.log('')
console.log(fallos === 0 ? 'RESULTADO: credenciales verificadas.' : `RESULTADO: ${fallos} verificacion(es) fallaron.`)
process.exitCode = fallos === 0 ? 0 : 1
