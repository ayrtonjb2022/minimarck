/**
 * Launch the real app under the S0 probe and propagate its exit code.
 *
 * `probe:launch` used to be `electron out/main/index.js`, which only runs the probe when
 * MINIMARCK_S0_PROBE is already set in the environment. That made it awkward to put in a
 * gate: the reviewer had to know the variable. This sets it for the child unconditionally,
 * so `npm run probe:launch` IS the probe whether or not you set the variable yourself —
 * setting it is still harmless, so the documented command keeps working.
 */
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import electronPath from 'electron'
import { correrElectron, codigoDeSalida, dirDePrueba } from './electron-runner.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const desktopRoot = join(here, '..')
const mainEntry = join('out', 'main', 'index.js')

// A throwaway base per run, so the probe never touches the shop's real profile and a half-written
// one from a killed run cannot make the next probe fail for the wrong reason.
//
// It is created HERE by THIS process, under `desktop/run/`, rather than by the Electron child in
// `%TEMP%`. Both halves are measured and both are documented in `electron-runner.mjs`: a Chromium
// main process on a shell with no interactive desktop session cannot write outside the repository
// at all. One directory carries the whole probe — the app reads `MINIMARCK_DATA_DIR` for BOTH the
// shop file and the throwaway `userData` profile, so nothing here can reach a real shop.
const dataDir = dirDePrueba('probe')
console.log(`probe:launch — using throwaway data dir ${dataDir}`)

const result = correrElectron(electronPath, mainEntry, {
  cwd: desktopRoot,
  env: {
    MINIMARCK_S0_PROBE: '1',
    MINIMARCK_DATA_DIR: dataDir,
    MINIMARCK_USER_DATA_DIR: dataDir
  }
})

try {
  rmSync(dataDir, { recursive: true, force: true })
} catch {
  /* locked by a dead process — `desktop/run/` is gitignored and a later run makes a new one */
}

process.exit(codigoDeSalida(result))
