/**
 * Prove the installer's wizard is in SPANISH by RUNNING it and reading the captions off the window.
 *
 * `scripts/verify-package.mjs` used to grep the .exe for `Siguiente` / `Next` as plaintext. That can
 * never succeed: NSIS compresses its data section, so the wizard's strings are not in the file as
 * plaintext in any encoding. The check reported FAIL on an installer whose UI was entirely Spanish.
 * A check that fails on correct output is worse than no check, because it teaches everyone to
 * ignore it — and it blocked every release build in the meantime.
 *
 * So the language claim is checked where it is actually true: on the screen. This launches the real
 * installer, waits for its first page, enumerates the Win32 child controls, and asserts on the
 * captions a user would read.
 *
 * WHAT IT DOES NOT DO: it does not complete the installation. It reads the FIRST page and closes
 * the wizard, precisely so the check is safe to run on a machine that already has MiniMarck
 * installed. Proving the install itself is `npm run verify:installed`'s job, and that script has its
 * own uninstall at the end so the two can be run back to back.
 *
 * WHY THE EXPECTATIONS ARE EXPLICIT rather than a list of "any Spanish-looking string": a loose
 * check passes on a half-translated UI. These are the captions electron-builder's `es_ES` pack
 * produces on the welcome page, and each one is a word that does not appear in the English pack.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const RELEASE = process.argv[2] ? path.resolve(root, process.argv[2]) : path.join(root, 'release')
const PS = path.join(here, 'read-installer-controls.ps1')

const isSetupExe = (f) => f.toLowerCase().endsWith('.exe') && f.toLowerCase().includes('setup')
const installerNames = existsSync(RELEASE) ? readdirSync(RELEASE).filter(isSetupExe) : []
const installer = installerNames.includes('MiniMarck Setup.exe')
  ? path.join(RELEASE, 'MiniMarck Setup.exe')
  : installerNames.length > 0
    ? path.join(RELEASE, installerNames[0])
    : null

if (installer === null) {
  console.error(`No NSIS installer found in ${RELEASE}. Run \`npm run dist\` first.`)
  process.exit(1)
}

console.log(`Installer: ${installer}`)
console.log(`Reading the wizard's own captions from the running window...\n`)

const work = mkdtempSync(path.join(tmpdir(), 'installer-ui-'))
const jsonOut = path.join(work, 'controls.json')
const child = spawn(installer, [], { cwd: RELEASE, stdio: 'ignore' })

let controls = null
let title = ''
try {
  controls = await waitForFirstPage(child.pid, jsonOut)
  title = controls.title
  printTable(controls.controls)
} finally {
  // Close the wizard without installing. `WM_CLOSE` is what the X button sends; a silent taskkill
  // would also kill any MiniMarck the user already had open, which is not this script's business.
  if (child.exitCode === null) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T'], { stdio: 'ignore' })
  }
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* the temp dir is disposable */
  }
}

console.log(`\nWindow title: ${title}`)
const captions = controls.controls.map((c) => c.text).filter((t) => t && t.trim().length > 0)

// Each phrase is present in electron-builder's `es_ES` pack and absent from the English one, which is
// what makes this an assertion about the LANGUAGE rather than a search for a shared word.
const spanish = ['Instalación de MiniMarck', 'Siguiente', 'Cancelar', 'Instalar']
const english = ['Installation', 'Next', 'Cancel', 'Install', 'Select Install Location']

const found = spanish.filter((p) => captions.some((c) => c.includes(p)))
// WORD BOUNDARIES, NOT SUBSTRING. The first version of this check reported "English captions
// present: Cancel" on a wizard reading "Cancelar" — `String.includes` matches inside a longer word,
// so every Spanish caption that begins with an English one was counted as a language leak. The
// check failed on a fully Spanish installer, which is the same class of bug as the NSIS grep it
// replaced: a verifier that cannot tell right from wrong is worse than none, because it is believed.
const leaked = english.filter((p) =>
  captions.some((c) => new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(c))
)

console.log(`\nSpanish captions found: ${found.length > 0 ? found.join(', ') : 'NONE'}`)
if (leaked.length > 0) console.log(`English captions present: ${leaked.join(', ')}`)

const pass = found.length > 0 && leaked.length === 0
console.log(
  pass
    ? '\nOK: the installer wizard is in Spanish.'
    : `\nFAILED: the wizard is not demonstrably Spanish. Found ${found.length} Spanish and ${leaked.length} English captions.`
)
process.exit(pass ? 0 : 1)

/**
 * NSIS needs a moment to unpack and create its first page. Poll rather than sleep a fixed amount:
 * a fixed sleep is either too short on a slow disk (false negative) or a waste on a fast one.
 */
async function waitForFirstPage(pid, out) {
  const deadline = Date.now() + 90_000
  let lastError = 'the installer never opened a window'
  while (Date.now() < deadline) {
    if (spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).stdout.includes(pid) === false) {
      lastError = 'the installer process exited before showing a window'
      break
    }
    const read = spawnSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS, '-ProcessId', String(pid), '-Out', out],
      { encoding: 'utf8' }
    )
    if (read.status === 0 && existsSync(out)) {
      const parsed = JSON.parse(readFileSync(out, 'utf8'))
      if (parsed.controls.length > 0) return parsed
      lastError = 'the window had no child controls yet'
    } else {
      lastError = (read.stdout || read.stderr || '').trim()
    }
    await new Promise((r) => setTimeout(r, 1200))
  }
  throw new Error(`could not read the installer window: ${lastError}`)
}

function printTable(list) {
  console.log('  id      class             text')
  console.log('  ------  ----------------  --------------------------------------------')
  for (const c of list) {
    if (!c.text || c.text.trim().length === 0) continue
    const text = c.text.replace(/\s+/g, ' ').slice(0, 60)
    console.log(`  ${String(c.id).padEnd(6)}  ${String(c.cls).padEnd(16)}  ${text}`)
  }
}
