/**
 * Read-only census of a MiniMarck database file.
 *
 * WHAT IT IS FOR. Before launching the app I need to know whether the profile already has
 * credentials — the sign-in panel refuses to create a second owner on a machine that already has
 * one (`auth.service.js` `YA_CONFIGURADO`), so "run it and tell me a password" has two different
 * answers depending on what is already in the file.
 *
 * It opens the file READ-ONLY (`readOnly: true`), so it cannot checkpoint, migrate or write. It
 * prints the sign-in handle and the role, and NEVER the `secret`/`salt` columns: a tool that
 * prints a hash invites somebody to paste it into a chat.
 *
 * Usage:
 *   node scripts/inspeccionar-perfil.mjs [ruta\al\minimarck.db]
 *   node scripts/inspeccionar-perfil.mjs              # the installed app's profile
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const porDefecto = path.join(os.homedir(), 'AppData', 'Roaming', 'MiniMarck', 'data', 'minimarck.db')
const archivo = process.argv[2] ? path.resolve(process.argv[2]) : porDefecto

if (!existsSync(archivo)) {
  console.log(`NO EXISTE  ${archivo}`)
  console.log('La app todavia no creo su base: el perfil es "primer arranque" y el panel pedira crear el negocio.')
  process.exit(0)
}

console.log(`archivo : ${archivo}`)
console.log(`tamano  : ${(await import('node:fs')).statSync(archivo).size} bytes`)

/**
 * `readOnly: true` FAILS on a WAL database with `SQLITE_CANTOPEN` (errcode 14): a read-only
 * connection cannot create the `-shm` file the WAL index needs, and the app's file is in WAL mode.
 * So the connection is opened normally and the tool is kept SELECT-only by construction — every
 * statement below is a read. A `-wal` left behind by a crashed run is replayed by the open, which
 * is the same thing the app itself would do.
 */
let db
try {
  db = new DatabaseSync(archivo, { readOnly: true })
} catch (err) {
  if (err?.errcode !== 14) throw err
  console.log('nota    : WAL + readOnly no se puede abrir; se abre en modo normal (solo SELECT)')
  db = new DatabaseSync(archivo)
}
try {
  console.log(`version : user_version = ${db.prepare('PRAGMA user_version').get().user_version}`)

  const tablas = db
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")
    .get().n
  console.log(`tablas  : ${tablas}`)

  const migraciones = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()
  console.log(`migradas: ${migraciones.map((m) => `${m.version}:${m.name}`).join(' ') || '(ninguna)'}`)

  const negocios = db.prepare('SELECT id, nombre, activo FROM negocios').all()
  console.log(`negocios: ${negocios.length}`)
  for (const n of negocios) console.log(`          #${n.id} "${n.nombre}" activo=${n.activo}`)

  // `user_identidades` is the credential table (002); `users` is the person. The join is the only
  // place the sign-in HANDLE lives, which is the thing a person needs in order to log in.
  const cuentas = db
    .prepare(
      `SELECT u.id, u.nombre, u.rol, u.activo, i.nombre_acceso
         FROM users u
         LEFT JOIN user_identidades i ON i.user_id = u.id
        ORDER BY u.id`
    )
    .all()
  console.log(`cuentas : ${cuentas.length}`)
  for (const c of cuentas) {
    console.log(
      `          #${c.id} usuario="${c.nombre_acceso ?? '(sin credencial)'}" persona="${c.nombre}" rol=${c.rol} activo=${c.activo}`
    )
  }

  if (cuentas.some((c) => c.nombre_acceso)) {
    console.log('')
    console.log('VEREDICTO: ya hay credenciales -> el panel pedira INICIAR SESION, no crear el negocio.')
  } else {
    console.log('')
    console.log('VEREDICTO: no hay credenciales -> el panel ofrecera CREAR EL NEGOCIO.')
  }
} finally {
  db.close()
}
