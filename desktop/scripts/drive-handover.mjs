/**
 * Run the HANDOVER DRIVE: the real app, driven by real keys, through the whole
 * first-launch -> add employee -> handover -> employee sells -> take back story.
 *
 * It runs against a THROWAWAY data directory so it can never touch a real shop's
 * database: MINIMARCK_DATA_DIR points the app at a temp folder, which
 * bootstrapDatabase honours.
 *
 * TWO PROCESSES, ONE DATABASE. Phase 1 walks the story. Then the app EXITS and this script
 * launches it AGAIN on the same data directory, and phase 2 checks what survived: the money,
 * the credentials and the employee's name on the sale; NOT the session. A session is an object
 * in a process's memory, and the only way to prove it does not outlive the process is to end
 * the process. A comment, or a `session = null` on the same process, would prove nothing.
 *
 * Exit code is the drive's: 0 only if every check in BOTH phases passed. `npm run
 * drive:handover` is a real gate, not a report.
 */
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import electronPath from 'electron'
import { FLAGS_ELECTRON, entornoElectron, dirDePrueba } from './electron-runner.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const desktopRoot = join(here, '..')
const mainEntry = join('out', 'main', 'index.js')

const dataDir = dirDePrueba('drive-handover')
console.log(`drive:handover — using throwaway data dir ${dataDir}`)

/** Pull `HANDOVER_DRIVE_PHASE1 {...}` out of the child's combined output. */
const leerFase = (stdout, etiqueta) => {
  const linea = stdout.split(/\r?\n/).find((l) => l.startsWith(`HANDOVER_DRIVE_${etiqueta} `))
  if (!linea) return null
  try {
    return JSON.parse(linea.slice(`HANDOVER_DRIVE_${etiqueta} `.length))
  } catch {
    return null
  }
}

// `FLAGS_ELECTRON` and `entornoElectron` are imported from `electron-runner.mjs` rather than
// spelled out here, because this is the one drive that cannot use `correrElectron`: it needs to
// CAPTURE the child's stdout to read its report line, and `correrElectron` inherits stdio.
const correr = (env) =>
  spawnSync(electronPath, [...FLAGS_ELECTRON, mainEntry], {
    cwd: desktopRoot,
    encoding: 'utf8',
    env: entornoElectron({ MINIMARCK_DATA_DIR: dataDir, MINIMARCK_USER_DATA_DIR: dataDir, ...env })
  })

// `stdio: 'inherit'` cannot be combined with capturing output, and the drive's report IS its
// output. So it is piped and printed here — same console, one extra copy of the bytes.
const fase1 = correr({ MINIMARCK_HANDOVER_DRIVE: '1' })
process.stdout.write(fase1.stdout ?? '')
process.stderr.write(fase1.stderr ?? '')
const r1 = leerFase(fase1.stdout ?? '', 'PHASE1')

let r2 = null
let fase2 = null
if (fase1.status === 0 && r1?.ok) {
  console.log('')
  console.log('--- el proceso de la fase 1 salió; se lanza la app OTRA VEZ sobre la misma base ---')
  fase2 = correr({ MINIMARCK_HANDOVER_RESTART: '1' })
  process.stdout.write(fase2.stdout ?? '')
  process.stderr.write(fase2.stderr ?? '')
  r2 = leerFase(fase2.stdout ?? '', 'PHASE2')
}

// Best-effort cleanup: the database may still be open if Electron was killed hard, in which case
// Windows keeps a lock and rm throws. That is not a drive failure, so it does not change the code.
try {
  rmSync(dataDir, { recursive: true, force: true })
} catch {
  /* locked by a dead process — `desktop/run/` is gitignored and a later run makes a new one */
}

if (fase1.error || fase2?.error) {
  const err = fase1.error ?? fase2.error
  console.error(`drive:handover — could not start ${electronPath}: ${err.message}`)
  process.exit(1)
}
if (!r1) {
  console.error('drive:handover — la fase 1 no llegó a imprimir HANDOVER_DRIVE_PHASE1')
  process.exit(1)
}
if (!r2) {
  console.error('drive:handover — la fase 2 no llegó a imprimir HANDOVER_DRIVE_PHASE2')
  process.exit(1)
}

const total = r1.total + r2.total
const failed = r1.failed + r2.failed
const resumen = { ok: failed === 0, total, failed }
console.log(`HANDOVER_DRIVE_RESULT ${JSON.stringify(resumen)}`)
process.exit(resumen.ok ? 0 : 1)
