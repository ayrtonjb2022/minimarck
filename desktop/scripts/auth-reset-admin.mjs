/**
 * `npm run auth:reset-admin` — what a shopkeeper runs when the owner forgot the password.
 *
 * ── WHY THIS IS PLAIN NODE AND NOT ANOTHER ELECTRON PROCESS ─────────────────────────────────────
 *
 * The first version ran under Electron, to ask `app.getPath('userData')` for the shop's directory.
 * It was measured on this machine and it does not work:
 *
 *   - `electron.exe` is a GUI-subsystem binary. Its main process receives an EMPTY `stdin` even when
 *     the parent redirects a real file into it — 18 bytes through Node, 0 through Electron, same
 *     file, same handle. A password prompt that cannot read a pipe cannot be scripted, and the
 *     documented "type clave.txt | …" was a lie until this file replaced it.
 *   - Chromium's single-instance lock cannot be created on a shell with no interactive desktop
 *     session (`index.js` documents why), so a check built on it reports "the app is running" on a
 *     machine where nothing is running.
 *   - It paid for GPU cache directories it never used, and failed to create them.
 *
 * Every one of those is a problem the tool must not have, and all of them come from choosing the
 * process type. `resolveUserDataSinElectron` in `src/main/dataDir.js` derives the same path with a
 * pure, tested rule, and the confirmation that the database is really inside it is done by the
 * `existsSync` below — loudly, with every candidate printed, rather than by guessing quietly.
 *
 * ── THE TRUST BOUNDARY, STATED PLAINLY BECAUSE IT IS THE WHOLE SECURITY MODEL ───────────────────
 *
 * Anyone who can run this can set the password of anybody in the shop. There is no password prompt
 * for the operator and there could not usefully be one: proving you are the owner requires the
 * password this tool exists to replace. What it relies on is the assumption every local-first
 * application makes — **the person who can open the database file is the shop** — and the thing the
 * app does own, that no renderer can reach and no IPC operation exists for, is written up in
 * `DIVERGENCES.md` next to the decision.
 *
 * ── EXIT CODES, so a script can branch on WHY and not just on "it failed" ──────────────────────
 *
 *   0  done            2  usage          3  refused
 *   5  no database     6  file predates credentials
 *
 * Usage:
 *   npm run auth:reset-admin -- --listar
 *   npm run auth:reset-admin -- duena
 *   type clave.txt | npm run auth:reset-admin -- duena      (non-interactive)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import { resolveDataPaths, resolveUserDataSinElectron } from '../src/main/dataDir.js'
import { openDatabase } from '../src/main/db/connection.js'
import { tablesCreatedBy } from '../src/main/db/migrate.js'
import { restablecerDesdeDisco, cuentasReseteables } from '../src/main/cli/reset-admin.js'

const here = path.dirname(fileURLToPath(import.meta.url))
// scripts/ -> desktop/. One `..`, not two: with two it resolved to `desktop/scripts`'s parent of the
// migration directory and `tablasPermitidas()` returned [], so `openDatabase` ran deny-all and
// `guardarCredencial`'s first UPDATE failed as "not authorized" — a correct refusal that reads like
// a broken tool.
const root = path.resolve(here, '..')

const SALIDA = { OK: 0, USO: 2, REFUSADO: 3, SIN_BASE: 5, BASE_VIEJA: 6 }

function usage() {
  return [
    'Recuperación de contraseña de MiniMarck',
    '',
    '  npm run auth:reset-admin -- --listar',
    '  npm run auth:reset-admin -- <nombre-de-acceso>',
    '',
    'El nombre de acceso va POSICIONAL a propósito: `npm run … -- --user dueña` no llega, porque npm',
    'se come `--user` como si fuera su propia configuración (npm 10 en Windows lo descarta entero,',
    'con o sin `=`). Invocando el archivo directo, `--user <nombre>` también funciona.',
    '',
    'La contraseña nueva se pide después, sin eco, y NO se acepta por argument.',
    '',
    'Quien puede abrir este archivo ES el negocio: la herramienta restablece la contraseña de',
    'cualquier cuenta sin preguntar quién sos. Está escrito en DIVERGENCES.md.'
  ].join('\n')
}

/**
 * The allowlist, derived from the migration text rather than typed.
 *
 * `openDatabase` starts deny-all, so `guardarCredencial`'s first `UPDATE` against
 * `user_identidades` would be refused with a bare "not authorized" — a correct refusal that reads
 * like a broken tool. Same derivation as `bootstrapDatabase`, and the reason it reads the WHOLE
 * directory: reading only `001_init.sql` left `user_identidades` out of the allowlist the moment
 * migration 002 existed.
 */
function tablasPermitidas() {
  const dir = path.join(root, 'src', 'main', 'db', 'migrations')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort()
    .flatMap((f) => tablesCreatedBy(readFileSync(path.join(dir, f), 'utf8')))
}

function parsear(argv) {
  const opciones = { usuario: null, listar: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--user' || arg === '--usuario') {
      opciones.usuario = argv[++i] ?? null
      if (!opciones.usuario) throw Object.assign(new Error('falta el valor de --user'), { code: 'USO' })
    } else if (arg === '--listar' || arg === '--list') {
      opciones.listar = true
    } else if (['--password', '--contrasena', '--contraseña', '--clave'].includes(arg.split('=')[0])) {
      // REFUSED, not ignored. A password on a command line is in the process list, in the shell
      // history, and in every screenshot of this window. Ignoring the flag would let somebody
      // believe they had passed a password safely; refusing is the only honest answer, and refusing
      // HERE — before anything is spawned or read — is the only place it is still safe to do.
      throw Object.assign(
        new Error(
          'La contraseña NO se acepta por argument: queda en la lista de procesos y en el historial\n' +
            'del shell, a la vista de cualquiera con acceso a esta máquina.\n' +
            'El programa la pide después, sin eco. Para correrlo sin nadie mirando:\n' +
            '  type clave.txt | npm run auth:reset-admin -- <nombre-de-acceso>'
        ),
        { code: 'USO' }
      )
    } else if (arg === '--help' || arg === '-h' || arg === '--ayuda') {
      opciones.ayuda = true
    } else if (arg.startsWith('-')) {
      throw Object.assign(new Error(`opción desconocida: ${arg}`), { code: 'USO' })
    } else if (opciones.usuario === null) {
      opciones.usuario = arg
    } else {
      throw Object.assign(
        new Error(`sobresaron argumentos: "${arg}". ¿Querías decir un solo nombre de acceso?`),
        { code: 'USO' }
      )
    }
  }
  return opciones
}

/**
 * Read the new password from stdin, muting the echo when it is a terminal.
 *
 * TWO READS, AND THE NON-TERMINAL ONE IS NOT A FALLBACK. `readline.question` waits for a `line`
 * event, which needs a newline; `echo clave.txt | …` against a file written with `-NoNewline` never
 * produced one, so the promise never settled and the tool HUNG after printing its prompt. A recovery
 * tool that hangs once it has asked the question is the worst failure mode here, so a non-terminal
 * stdin is read to EOF and the first line is taken — which cannot wait for a terminator that is not
 * coming.
 *
 * The line is NOT trimmed. A password may legitimately end in a space, and quietly eating one makes
 * a person think the tool lost their new password. The CRLF is handled by the split, where it
 * belongs.
 */
function leerPassword(prompt) {
  if (!process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let buffer = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk) => { buffer += chunk })
      process.stdin.on('end', () => resolve(buffer.split(/\r?\n/)[0] ?? ''))
      process.stdin.on('error', reject)
      process.stdin.resume()
    })
  }
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt)
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    // Mute AFTER readline has attached its own output, otherwise the first keystroke is echoed by
    // the terminal before the flag lands — and the password is on screen, which is the entire thing
    // this avoids.
    const escribirOriginal = rl._writeToOutput
    rl._writeToOutput = () => ''
    rl.question(prompt, (respuesta) => {
      rl._writeToOutput = escribirOriginal
      process.stdout.write('\n')
      rl.close()
      resolve(respuesta)
    })
    rl.on('error', reject)
  })
}

/**
 * FIND THE SHOP, OR SAY EVERY CANDIDATE AND STOP.
 *
 * `resolveUserDataSinElectron` computes a path; computing is not the same as being right, and this
 * function is the difference between a wrong guess that is loud and a wrong guess that silently
 * rewrites some other shop's credentials. Two candidates are checked because there are two ways the
 * shop can be relocated: `MINIMARCK_DATA_DIR`, which a shopkeeper may have set, and the default
 * profile. The override WINS when both exist, matching the app, and the message names every path it
 * looked at so a person can copy the right one into the command.
 */
function localizarLaBase() {
  const candidatos = []
  const override = process.env.MINIMARCK_DATA_DIR
  if (override) candidatos.push(path.join(override, 'data'))
  candidatos.push(path.join(resolveUserDataSinElectron(), 'data'))

  for (const dataDir of candidatos) {
    const dbFile = path.join(dataDir, 'minimarck.db')
    if (existsSync(dbFile)) return { dbFile, walFile: `${dbFile}-wal`, dataDir }
  }
  return { error: candidatos }
}

async function main(argv) {
  let opciones
  try {
    opciones = parsear(argv)
  } catch (err) {
    console.error(`${err.message}\n`)
    console.error(usage())
    return SALIDA.USO
  }
  if (opciones.ayuda) {
    console.log(usage())
    return SALIDA.OK
  }
  if (!opciones.usuario && !opciones.listar) {
    console.error(usage())
    return SALIDA.USO
  }

  const located = localizarLaBase()
  if (located.error) {
    console.error('No encontré la base de datos de MiniMarck. Busqué en:')
    for (const dir of located.error) console.error(`  ${path.join(dir, 'minimarck.db')}`)
    console.error(
      '\nSi tu shop está en otro lado, decime cuál con la variable MINIMARCK_DATA_DIR:\n' +
        '  set MINIMARCK_DATA_DIR=C:\\ruta\\de\\la\\carpeta'
    )
    return SALIDA.SIN_BASE
  }

  // True whether or not the app is running, so it cannot mislead. SQLite serialises the two
  // processes and the write is safe either way, but a RUNNING APP KEEPS ITS SESSION and will not
  // ask for the new password until the next sign-in — which looks exactly like a reset that did
  // nothing. The tool has no way to know (Chromium's single-instance lock is unusable here, see the
  // header), so it says the conditional instead of claiming to have checked.
  console.warn(
    'Si MiniMarck está abierto, cerralo: la app no va a pedir la contraseña nueva hasta el\n' +
      'próximo inicio de sesión. El archivo no se rompe por igual, pero vas a creer que no pasó.\n'
  )

  const conn = openDatabase(located.dbFile, { walFile: located.walFile, tables: tablasPermitidas() })
  try {
    // NOT MIGRATING. A password recovery does not get to change the shape of the shop's database —
    // a schema change nobody asked for, applied by a person who is already locked out and cannot
    // evaluate it. If the file is behind, the answer is a sentence telling them to open the app once.
    const version = conn.userVersion()
    if (version < 2) {
      console.error(
        `Esta base está en la versión ${version} y todavía no tiene credenciales.\n` +
          'Abrí MiniMarck una vez para actualizarla y después volvé a correr esto.'
      )
      return SALIDA.BASE_VIEJA
    }

    if (opciones.listar) {
      const cuentas = cuentasReseteables(conn)
      if (cuentas.length === 0) {
        console.log('No hay ninguna cuenta con contraseña en este archivo.')
      } else {
        console.log('Cuentas que se pueden restablecer:')
        for (const c of cuentas) console.log(`  ${c.nombreAcceso}  (${c.nombre}, ${c.rol})`)
      }
      return SALIDA.OK
    }

    const password = await leerPassword(`Nueva contraseña para ${opciones.usuario}: `)
    if (password === '') {
      console.error('No se escribió nada. No se cambió ninguna contraseña.')
      return SALIDA.USO
    }

    const r = restablecerDesdeDisco(conn, { nombreAcceso: opciones.usuario, password })
    console.log(`Contraseña restablecida para ${r.nombreAcceso} (${r.nombre}, ${r.rol}).`)
    console.log('Abrí MiniMarck e iniciá sesión con esa contraseña.')
    return SALIDA.OK
  } catch (err) {
    console.error(`No se pudo restablecer: ${err?.message ?? String(err)}`)
    console.error(`Código: ${err?.code ?? 'ERROR'}`)
    return SALIDA.REFUSADO
  } finally {
    try {
      conn.checkpointAndClose()
    } catch {
      /* the refusal above is what the person needs to read */
    }
  }
}

main(process.argv.slice(2)).then(
  (codigo) => { process.exitCode = codigo },
  (err) => {
    console.error(err?.stack ?? String(err))
    process.exitCode = 1
  }
)