/**
 * OPEN MINIMARCK THE WAY A PERSON DOES — one command, from any shell, and it stays open.
 *
 * `npm run launch` is `npm run build && electron out/main/index.js`, and that command is a trap on
 * two separate counts. Both fail the SAME way — no window, no dialog, an exit code that says
 * nothing — and both are already documented where they were paid for. This script exists so nobody
 * has to rediscover them:
 *
 *   1. AN INHERITED `ELECTRON_RUN_AS_NODE`. With it set, `electron.exe` runs the entry as plain
 *      Node and dies with `does not provide an export named 'BrowserWindow'` — a message that reads
 *      like a broken import in `src/main`. `entornoElectron` deletes it rather than blanking it,
 *      because a present-but-empty variable means the same thing (`electron-runner.mjs` §1).
 *
 *   2. THE SINGLE-INSTANCE LOCK. Chromium writes it inside `userData`, which defaults to
 *      `%APPDATA%\MiniMarck`. On a shell that cannot write outside the repository — an agent's tool
 *      shell, a CI runner, a service — the lock cannot be created, `requestSingleInstanceLock()`
 *      answers false, and the app quits BEFORE it opens a window
 *      (`src/main/index.js:57-68`). The app already ships the override for exactly this
 *      (`MINIMARCK_USER_DATA_DIR`); what was missing was something that sets it.
 *
 * THE PROFILE LIVES UNDER THE REPOSITORY. `run/` is gitignored and is the one place every such shell
 * can write, so the default profile is `run/perfil-prueba/` — the same directory for BOTH the
 * Chromium profile (`MINIMARCK_USER_DATA_DIR`) and the database base (`MINIMARCK_DATA_DIR`).
 * Splitting them is precisely how the lock stayed broken while the data looked moved: moving only
 * `MINIMARCK_DATA_DIR` relocates the database and leaves the lock in `%APPDATA%` (`dataDir.js:19-22`).
 *
 * It is deliberately NOT the shop's real file. This launches a profile for looking at the app, and
 * one that can be deleted without consequence is the point. Both overrides still win when they are
 * set, so a caller can point this at any profile.
 *
 * The default profile is SEEDED once, with the known credentials `perfil-de-prueba.mjs` leaves
 * behind, so the first screen is the app and not a sign-up form nobody can fill from a terminal.
 *
 * The Electron flags come from `FLAGS_ELECTRON`, never from a list invented here: a fourth spelling
 * of that list is how the two bugs above come back (`electron-runner.mjs` §"WHAT THESE FLAGS MUST
 * NEVER BECOME").
 *
 * Usage (from `desktop/`, or via the `MiniMarck.cmd` at the repository root):
 *   npm run abrir
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as dormir } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import electronPath from 'electron'
import { FLAGS_ELECTRON, entornoElectron } from './electron-runner.mjs'

/** How long to watch the child before believing it opened. A launch that dies does so immediately. */
const MS_ANTES_DE_CONFIAR = 4000

const here = fileURLToPath(new URL('.', import.meta.url))
const desktopRoot = join(here, '..')
const mainEntry = join('out', 'main', 'index.js')
const dirRun = join(desktopRoot, 'run')

const perfilPorDefecto = join(dirRun, 'perfil-prueba')
const perfil = process.env.MINIMARCK_USER_DATA_DIR || perfilPorDefecto
const datos = process.env.MINIMARCK_DATA_DIR || perfil
const esPerfilPorDefecto = perfil === perfilPorDefecto

// 1. Un negocio con el que entrar. Una sola vez; después el perfil persiste entre corridas.
if (esPerfilPorDefecto && !existsSync(join(datos, 'data', 'minimarck.db'))) {
  console.log('abrir — no hay perfil de prueba; preparándolo (una sola vez)…')
  const semilla = spawnSync(process.execPath, [join('scripts', 'perfil-de-prueba.mjs')], {
    cwd: desktopRoot,
    stdio: 'inherit'
  })
  if (semilla.status !== 0) process.exit(semilla.status ?? 1)
}

// 2. Un bundle que correr. `launch` construye SIEMPRE; acá sólo cuando no hay nada que correr.
if (!existsSync(join(desktopRoot, mainEntry))) {
  console.log('abrir — no hay build; construyendo (una sola vez)…')
  const build = spawnSync('npm', ['run', 'build'], { cwd: desktopRoot, stdio: 'inherit', shell: true })
  if (build.status !== 0) process.exit(build.status ?? 1)
}

mkdirSync(perfil, { recursive: true })

console.log('')
console.log('  MiniMarck  —  abriendo')
console.log('  ---------------------------------------------')
if (esPerfilPorDefecto) {
  console.log('  usuario   : duena')
  console.log('  password  : Prueba-2026-MiniMarck')
  console.log('  negocio   : Almacen de Prueba')
  console.log('  la tienda real NO se toca.')
} else {
  console.log(`  perfil    : ${perfil}`)
}
console.log(`  datos     : ${join(datos, 'data', 'minimarck.db')}`)
console.log('')

// 3. Desacoplada de esta consola, para que cerrar la terminal no cierre la caja — pero con la
//    salida a archivo, para que un arranque fallido se pueda leer en vez de adivinar.
const salida = openSync(join(dirRun, 'app.out.log'), 'w')
const errores = openSync(join(dirRun, 'app.err.log'), 'w')

const hijo = spawn(electronPath, [...FLAGS_ELECTRON, mainEntry], {
  cwd: desktopRoot,
  env: entornoElectron({
    MINIMARCK_DATA_DIR: datos,
    MINIMARCK_USER_DATA_DIR: perfil
  }),
  detached: true,
  stdio: ['ignore', salida, errores]
})
closeSync(salida)
closeSync(errores)

await dormir(MS_ANTES_DE_CONFIAR)

// `exitCode` sólo se llena si el bucle de eventos ya vió el 'exit'. Con `await` arriba, lo vio.
if (hijo.exitCode !== null) {
  console.error(`abrir — la app se cerró sola (código ${hijo.exitCode}). Salida de run/app.err.log:`)
  console.error('')
  console.error(readFileSync(join(dirRun, 'app.err.log'), 'utf8').trim() || '(vacío)')
  console.error('')
  console.error('  Si dice "Lock file can not be created", el perfil de Chromium quedó en %APPDATA%.')
  console.error('  Si dice "does not provide an export named", ELECTRON_RUN_AS_NODE volvió al entorno.')
  process.exit(1)
}

console.log('  MiniMarck está abierto. Cerrá la ventana cuando termines.')
hijo.unref()
