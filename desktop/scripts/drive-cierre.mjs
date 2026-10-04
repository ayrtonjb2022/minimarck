/**
 * Run the TILL CLOSE DRIVE: the real app, counting the drawer on screen and reconciling the three
 * figures it ends up holding against the real SQLite file.
 *
 * Companions: `drive-payment.mjs` proves cash IN, `drive-deudores.mjs` collecting a debt,
 * `drive-compras.mjs` the supplier path, `drive-reportes.mjs` the sales numbers the shop prints, and
 * `drive-contabilidad.mjs` the trial balance. All of them OPEN a till. None of them ever COUNTED
 * one, because until this screen existed there was nothing on screen to drive. This one walks the
 * end of the day: type a count, get asked to acknowledge the shortage, change the count and watch
 * the acknowledgement be taken away, close, and open tomorrow's till.
 *
 * It runs against a THROWAWAY data directory so it can never touch a real shop's database:
 * MINIMARCK_DATA_DIR points the app at a folder under `desktop/run/`, which bootstrapDatabase honours.
 *
 * Exit code is the drive's: 0 only if every check passed. `npm run drive:cierre` is a real gate.
 */
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import electronPath from 'electron'
import { correrElectron, codigoDeSalida, dirDePrueba } from './electron-runner.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const desktopRoot = join(here, '..')
const mainEntry = join('out', 'main', 'index.js')

const dataDir = dirDePrueba('drive-cierre')
console.log(`drive:cierre — using throwaway data dir ${dataDir}`)

const result = correrElectron(electronPath, mainEntry, {
  cwd: desktopRoot,
  env: {
    MINIMARCK_CIERRE_DRIVE: '1',
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