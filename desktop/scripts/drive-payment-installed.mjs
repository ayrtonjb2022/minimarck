/**
 * Run the FIRSTHAND PAYMENT DRIVE against an ALREADY-INSTALLED MiniMarck, using the SHOP's real
 * database.
 *
 * WHY A SEPARATE SCRIPT. `drive-payment.mjs` deliberately runs against a THROWAWAY data directory
 * (`MINIMARCK_DATA_DIR`), and that is correct for a routine gate: a payment drive must never be
 * able to touch a real shop's ledger. But it also means the routine drive proves nothing about the
 * INSTALLED app, which has three things the dev build does not have — a different working
 * directory, the code inside `app.asar` instead of loose files in `out/`, and migrations resolved
 * from that asar rather than from the repo. Those are exactly the conditions under which a sale can
 * fail while every unit test still passes.
 *
 * So this launches the INSTALLED `MiniMarck.exe`, not the development Electron binary, and lets it
 * open `%APPDATA%\MiniMarck\data\minimarck.db` — the real profile, no override. The caller is
 * responsible for that being a disposable profile; `verify-installed-e2e.mjs` sets one up and then
 * checks afterwards that the sale survived an uninstall.
 *
 * The drive itself is not reimplemented here. The same `MINIMARCK_PAYMENT_DRIVE` code path in the
 * app does the work, so running the installed binary exercises the installed binary.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const installed = join(
  process.env.LOCALAPPDATA || '',
  'Programs',
  'MiniMarck',
  'MiniMarck.exe'
)

if (!existsSync(installed)) {
  console.error(`drive:installed — not installed at ${installed}. Run 'npm run dist' and install first.`)
  process.exit(1)
}

console.log(`drive:installed — driving the INSTALLED app at ${installed}`)
console.log(`drive:installed — using the real shop profile %APPDATA%\\MiniMarck (no data-dir override)`)

const child = spawn(installed, [], {
  stdio: 'inherit',
  env: {
    ...process.env,
    MINIMARCK_PAYMENT_DRIVE: '1',
    // Explicitly cleared rather than merely omitted: if this process were ever launched from a
    // shell that still had it set, the drive would quietly run against a throwaway folder and
    // report success while proving nothing about the real profile.
    MINIMARCK_DATA_DIR: ''
  }
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`drive:installed — killed by ${signal}`)
    process.exit(1)
  }
  process.exit(code === null ? 1 : code)
})
