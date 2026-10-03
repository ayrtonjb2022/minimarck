/**
 * HOW EVERY GATE SCRIPT STARTS ELECTRON — one place, because the two ways it can be got wrong
 * both fail with an error that points at the wrong thing.
 *
 * ── 1. `ELECTRON_RUN_AS_NODE` IS INHERITED ───────────────────────────────────────────────────
 *
 * Each script spawns the Electron BINARY and hands it a `.js` entry. When that variable is set in
 * the parent environment the child does not start Electron at all: the file runs as plain Node, and
 * the app dies with `does not provide an export named 'BrowserWindow'` — a message that reads like
 * a broken import in `src/main`, when the cause is one inherited environment variable.
 *
 * Setting it to the EMPTY STRING is NOT equivalent: Electron reads a present-but-empty variable as
 * "run as Node" too. It has to be `delete`d.
 *
 * ── 2. WITHOUT `--no-sandbox` THE BINARY DIES WITH `0x80000003` ─────────────────────────────────
 *
 * On a Windows shell that is not attached to an interactive desktop session — a service, a CI
 * runner, an agent's tool shell — Chromium's sandbox cannot attach and the process breaks out with
 * Windows status `0x80000003` (`STATUS_BREAKPOINT`) before the first line of the entry point runs.
 *
 * The proof that it is the sandbox and not this project: `electron --version` dies with the same
 * status, and `electron --no-sandbox --version` prints `v44.4.5`. Nothing in `src/main` is involved
 * in either.
 *
 * ── `--user-data-dir` HANGS THIS SHELL, SO IT IS NOT IN THE LIST ─────────────────────────────────
 *
 * A fourth trap, found the hard way: adding `--user-data-dir <path>` to a spawn of this binary
 * makes Chromium ignore the "print and exit" fast paths and wait for an application that never
 * arrives. `electron --no-sandbox --version --user-data-dir X` prints nothing and never exits, and
 * the same flag on a script entry silences its output the same way. `--version` alone returns in a
 * second, so the flag is the only difference. The app therefore sets its own throwaway profile with
 * `app.setPath('userData', …)` from `MINIMARCK_DATA_DIR`, which is what `probe-launch.mjs` relies
 * on, and no script passes `--user-data-dir`.
 *
 * ── WHAT THESE FLAGS MUST NEVER BECOME ────────────────────────────────────────────────────────
 *
 * `--no-sandbox` disables a real security control, so it is confined to the scripts a developer
 * runs by hand and is NEVER added to the application itself: the packaged build keeps the sandbox
 * on. `--disable-gpu` and `--disable-dev-shm-usage` are the companion switches for the same
 * "no desktop" case and carry the same confinement. If a future slice needs to launch Electron from
 * a script, it imports `FLAGS_ELECTRON` from here instead of inventing its own list — a fourth
 * spelling of the same flag list is how the two bugs above come back.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** The switches every Electron-spawning gate script must pass. Never on the shipped app. */
export const FLAGS_ELECTRON = Object.freeze([
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage'
])

/**
 * WHERE A THROWAWAY BASE GOES — under the repository, not under `%TEMP%`.
 *
 * Every gate script here points Electron at a throwaway directory so it can never touch a real
 * shop's database, and the obvious place for one is `os.tmpdir()`. Measured on a Windows shell
 * that is not attached to an interactive desktop session — the shell an agent or a CI runner has —
 * an Electron MAIN process cannot write outside the repository at all:
 *
 *   mkdir %TEMP%\mm-write-probe      EPERM
 *   mkdir %APPDATA%\mm-write-probe   EPERM
 *   mkdir C:\mm-write-probe          EPERM
 *   mkdir <repo>\run\…               OK
 *
 * It is not `%TEMP%` being special. Every one of those paths answers `EPERM` while the same call
 * under `desktop/` succeeds, so a gate whose throwaway base lives in the temp directory fails
 * before it prints a line and reports a problem in `src/main` that is not there.
 *
 * `run/` is already in `.gitignore` ("Perfil de PRUEBA y artefactos de lanzamiento local"). A
 * throwaway database is exactly that, and a base under the repository is also debuggable after a
 * failed gate, which `%TEMP%` is not once the OS reaps it.
 *
 * The directory is still created by the PARENT (system Node), for the same reason: the child only
 * ever has to write inside a directory that already exists.
 */
export function dirDePrueba(etiqueta) {
  const raiz = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'run')
  mkdirSync(raiz, { recursive: true })
  return mkdtempSync(join(raiz, `${etiqueta}-`))
}

/**
 * The parent environment, minus `ELECTRON_RUN_AS_NODE`.
 *
 * @param {Record<string, string|undefined>} extra variables the child needs (`MINIMARCK_DATA_DIR`,
 *   the `MINIMARCK_*_DRIVE` switches, …). Spread last so a caller can override an inherited value.
 */
export function entornoElectron(extra = {}) {
  const entorno = { ...process.env, ...extra }
  delete entorno.ELECTRON_RUN_AS_NODE
  return entorno
}

/**
 * Run the Electron binary and hand the caller its raw `spawnSync` result.
 *
 * The STATUS IS NOT INTERPRETED HERE. `drive-*.mjs` exits with it, `spike.mjs` exits with it, and
 * `probe-launch.mjs` treats `null` as "killed by a signal", which is a failure. Only `result.error`
 * (the binary could not be started at all) is turned into an exit code here, because a caller that
 * forgets it would otherwise read `result.status === null` and report a crash as a pass.
 *
 * @param {string} electronPath absolute path to the Electron binary
 * @param {string[]} entry the app-relative entry, e.g. `out/main/index.js`
 * @param {{ cwd: string, env?: Record<string,string|undefined>, args?: string[] }} opts
 * @returns {import('node:child_process').SpawnSyncReturns<Buffer>}
 */
export function correrElectron(electronPath, entry, { cwd, env = {}, args = [] } = {}) {
  const resultado = spawnSync(electronPath, [...FLAGS_ELECTRON, ...args, entry], {
    cwd,
    stdio: 'inherit',
    env: entornoElectron(env)
  })
  if (resultado.error) {
    console.error(`could not start ${electronPath}: ${resultado.error.message}`)
    process.exit(1)
  }
  return resultado
}

/** A killed child reports `status === null`. That is a failure in every script here. */
export function codigoDeSalida(resultado) {
  return resultado.status === null ? 1 : resultado.status
}