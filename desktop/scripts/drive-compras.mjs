/**
 * Run the FIRSTHAND SUPPLIER AND PURCHASE DRIVE: the real app, driven through the real screens,
 * printing what the shop file then says. Companion to `drive-payment.mjs` (cash in) and
 * `drive-deudores.mjs` (collecting a debt). This one proves the direction neither of them covers —
 * goods and money arriving TOGETHER, which moves stock, changes the average cost, and posts to the
 * ledger.
 *
 * It runs against a THROWAWAY data directory so it can never touch a real shop's database:
 * MINIMARCK_DATA_DIR points the app at a temp folder, which bootstrapDatabase honours.
 *
 * Exit code is the drive's: 0 only if every check passed. `npm run drive:compras` is a real gate.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import electronPath from 'electron'

const here = fileURLToPath(new URL('.', import.meta.url))
const desktopRoot = join(here, '..')
const mainEntry = join('out', 'main', 'index.js')

const dataDir = mkdtempSync(join(tmpdir(), 'minimarck-compras-'))
console.log(`drive:compras — using throwaway data dir ${dataDir}`)

const result = spawnSync(electronPath, [mainEntry], {
  cwd: desktopRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    MINIMARCK_COMPRAS_DRIVE: '1',
    MINIMARCK_DATA_DIR: dataDir
  }
})

// Best-effort cleanup: the database may still be open if Electron was killed hard, in which case
// Windows keeps a lock and rm throws. That is not a drive failure, so it does not change the code.
try {
  rmSync(dataDir, { recursive: true, force: true })
} catch {
  /* locked by a dead process — the temp dir will be reaped by the OS */
}

if (result.error) {
  console.error(`drive:compras — could not start ${electronPath}: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status === null ? 1 : result.status)
