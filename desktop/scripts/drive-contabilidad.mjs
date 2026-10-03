/**
 * Run the CONTABILIDAD DRIVE: the real app, driven through the four accounting screens and
 * reconciling every figure it prints against the real SQLite file.
 *
 * Companions: `drive-payment.mjs` proves the cash path, `drive-deudores.mjs` the collect-the-debt
 * path, `drive-compras.mjs` the supplier path and `drive-reportes.mjs` the numbers the shop prints
 * about its SALES. None of them ever opened `/contabilidad`, even though every peso they moved went
 * through the ledger on its way to being counted. This one proves the thing the other four cannot:
 * that the TRIAL BALANCE on screen is the trial balance in the file, and that it balances.
 *
 * It runs against a THROWAWAY data directory so it can never touch a real shop's database:
 * MINIMARCK_DATA_DIR points the app at a temp folder, which bootstrapDatabase honours.
 *
 * Exit code is the drive's: 0 only if every check passed. `npm run drive:contabilidad` is a real
 * gate.
 */
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import electronPath from 'electron'
import { correrElectron, codigoDeSalida, dirDePrueba } from './electron-runner.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const desktopRoot = join(here, '..')
const mainEntry = join('out', 'main', 'index.js')

const dataDir = dirDePrueba('drive-contabilidad')
console.log(`drive:contabilidad — using throwaway data dir ${dataDir}`)

const result = correrElectron(electronPath, mainEntry, {
  cwd: desktopRoot,
  env: {
    MINIMARCK_CONTABILIDAD_DRIVE: '1',
    MINIMARCK_DATA_DIR: dataDir,
    MINIMARCK_USER_DATA_DIR: dataDir
  }
})

// Best-effort cleanup: the database may still be open if Electron was killed hard, in which case
// Windows keeps a lock and rm throws. That is not a drive failure, so it does not change the code.
try {
  rmSync(dataDir, { recursive: true, force: true })
} catch {
  /* locked by a dead process — `desktop/run/` is gitignored and a later run makes a new one */
}

process.exit(codigoDeSalida(result))