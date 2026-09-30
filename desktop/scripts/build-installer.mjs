/**
 * `npm run dist` — build the NSIS installer, into a STAGED output directory, and leave the
 * finished installer at a stable, predictable path.
 *
 * WHY STAGING, AND WHY THIS FILE EXISTS AT ALL
 * --------------------------------------------
 * `electron-builder` writes to `release/`, and on its next run it first tries to DELETE what is
 * there. On this machine that delete fails with EBUSY on `release/win-unpacked/resources/app.asar`,
 * reproducibly, and the build dies before it produces anything.
 *
 * What was ruled out, because each of these was a plausible culprit and none of them was:
 *
 *   - This project's own code. `scripts/probe-asar-handle.mjs` copies the asar, has a CHILD
 *     process read it exactly the way `verify-package.mjs` does, lets that child exit, and then
 *     renames and unlinks the copy. Both succeed, so `@electron/asar` does not leak a handle.
 *   - A stray Electron, MiniMarck, node, 7za, signtool or rcedit process. `Get-Process` was
 *     re-run including the processes whose `.Path` cannot be read, and there is none.
 *   - Antivirus blanket-locking archives. Defender real-time is off; a FRESH 4 KB `.asar` in the
 *     same directory is created and deleted without trouble; and `rename`/`delete` fail while a
 *     plain read+write-shared open succeeds.
 *
 * That last combination is the signature of an active MEMORY-MAPPED SECTION on the file. Something
 * outside this project — most likely the Avast engine (`aswEngSrv` is running), which maps an
 * archive it wants to inspect — has those two files mapped. A mapped file cannot be deleted or
 * renamed on Windows no matter what sharing flags the holder chose, and the holder is not something
 * this repository can ask to let go.
 *
 * So the build does not try to delete a directory it does not own the right to clear. It writes to
 * a FRESH subdirectory every run, and copies the one artefact the user needs up to a fixed path.
 * That is not a workaround for a bug in this project; it is the correct behaviour for a build that
 * runs on a machine it does not administer.
 *
 * WHAT THE USER GETS
 *   release/MiniMarck Setup.exe   — stable path, always the newest build
 *   release/build-<timestamp>/    — the full staged output, including win-unpacked for inspection
 *
 * `--dir` is passed through, so `npm run pack:dir` still produces an unpacked app without an
 * installer.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, copyFileSync, existsSync, statSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const release = path.join(root, 'release')

const dirOnly = process.argv.includes('--dir')
const args = process.argv.slice(2).filter((a) => a !== '--dir')

// A sortable, human-readable stamp. Local time, not UTC: the person reading `release/` is looking
// at their own clock, and "which of these five builds is the one I installed" is a question the
// directory listing has to answer without arithmetic.
const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`

// `MINIMARCK_RELEASE_DIR` exists so CI, or a machine where even a fresh subdirectory is watched by
// something, can send the whole output elsewhere. It is read, never guessed.
const stageDir = process.env.MINIMARCK_RELEASE_DIR
  ? path.resolve(root, process.env.MINIMARCK_RELEASE_DIR)
  : path.join(release, `build-${stamp}`)

mkdirSync(stageDir, { recursive: true })

const builderBin = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
)

console.log(`dist — staging into ${path.relative(root, stageDir)}`)
const builderArgs = [
  '--config',
  'electron-builder.yml',
  `--config.directories.output=${stageDir}`,
  ...(dirOnly ? ['--dir'] : []),
  ...args
]

const result = spawnSync(builderBin, builderArgs, {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: process.env
})

if (result.status !== 0) {
  console.error('')
  console.error(`dist FAILED — electron-builder exited ${result.status}`)
  console.error(`Staged output, if any, is in ${path.relative(root, stageDir)}`)
  process.exit(result.status === null ? 1 : result.status)
}

console.log('')
console.log('dist — verifying the packaged artifact')
const verify = spawnSync(process.execPath, [path.join(here, 'verify-package.mjs'), stageDir], {
  cwd: root,
  stdio: 'inherit'
})
if (verify.status !== 0) {
  console.error('dist FAILED — the packaged artifact did not pass verification (see above)')
  process.exit(verify.status === null ? 1 : verify.status)
}

// Copy the one file a person double-clicks up to a stable path. A build directory named after its
// timestamp is right for history and wrong for "send me the installer": the path would differ every
// time and nobody could remember yesterday's.
const built = existsSync(stageDir)
  ? readdirSync(stageDir).filter((f) => f.toLowerCase().endsWith('.exe') && f.toLowerCase().includes('setup'))
  : []

if (built.length > 0) {
  mkdirSync(release, { recursive: true })
  const src = path.join(stageDir, built[0])
  const dest = path.join(release, 'MiniMarck Setup.exe')
  copyFileSync(src, dest)
  const mb = (statSync(dest).size / 1048576).toFixed(1)
  console.log('')
  console.log(`INSTALLER: ${path.relative(root, dest)}  (${mb} MB)`)
  console.log('Double-click it. It installs per-user, with no administrator prompt.')
} else if (dirOnly) {
  console.log('')
  console.log(`UNPACKED APP: ${path.relative(root, path.join(stageDir, 'win-unpacked'))}`)
} else {
  console.error('')
  console.error('dist FAILED — electron-builder reported success but produced no installer .exe')
  process.exit(1)
}

// A pointer file, because a directory that accumulates one subdirectory per build stops being
// navigable after a week, and the answer to "which build is release/?" should not require sorting.
try {
  writeFileSync(
    path.join(release, 'LATEST.txt'),
    `MiniMarck installer build\n` +
      `staged output : ${path.relative(root, stageDir)}\n` +
      `installer     : release/MiniMarck Setup.exe\n` +
      `built at      : ${now.toISOString()}\n` +
      `mode          : ${dirOnly ? 'unpacked (--dir), no installer' : 'full NSIS installer'}\n`,
    'utf8'
  )
} catch {
  /* a pointer file is a convenience, never a build requirement */
}
