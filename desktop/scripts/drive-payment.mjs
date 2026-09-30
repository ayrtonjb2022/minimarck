/**
 * Run the FIRSTHAND PAYMENT DRIVE: the real app, driven by real keys, and print what the shop
 * file then says. Companion to `probe:launch`, which proves the security posture; this one proves
 * the money path — open the till, put a product on the ticket, press F2, take the money, and then
 * cancel it — inside the same real window over the same real origin and the same real SQLite file.
 *
 * It runs against a THROWAWAY data directory so it can never touch a real shop's database:
 * MINIMARCK_DATA_DIR points the app at a temp folder, which bootstrapDatabase honours.
 *
 * Exit code is the drive's: 0 only if every check passed. `npm run drive:payment` is a real gate.
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

const dataDir = mkdtempSync(join(tmpdir(), 'minimarck-drive-'))
console.log(`drive:payment — using throwaway data dir ${dataDir}`)

const result = spawnSync(electronPath, [mainEntry], {
  cwd: desktopRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    MINIMARCK_PAYMENT_DRIVE: '1',
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
  console.error(`drive:payment — could not start ${electronPath}: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status === null ? 1 : result.status)
