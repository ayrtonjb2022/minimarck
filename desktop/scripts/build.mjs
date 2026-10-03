/**
 * `npm run build` (and `npm run dev`) — electron-vite with a temp directory esbuild can delete from.
 *
 * WHY A WRAPPER SCRIPT AND NOT AN INLINE ENV VAR. `TEMP=... electron-vite build` in an npm script
 * works in bash and does not work in `cmd.exe` or in PowerShell, and this project is developed and
 * packaged on Windows. The cross-platform way to set an environment variable for one child process
 * is to set it in that process, which is what this file is for: no `cross-env` dependency, and the
 * override cannot leak into the developer's own shell.
 *
 * WHY THE OVERRIDE IS NEEDED AT ALL. See `staging-temp.mjs` for the full account. The short version:
 * esbuild stages transform payloads over ~1 MB through a temp file and its Go service then fails to
 * delete that file on this machine. The renderer bundle is ~1,19 MB, so `electron-vite build` dies
 * at the renderer phase with "Acceso denegado" after main and preload have already succeeded.
 *
 * WHAT IT ACTUALLY DOES. Runs the ordinary `electron-vite build` with the staging temp applied, so
 * this is the same build electron-vite would have run — not a second configuration that can drift
 * from the first. `build:release` layers its `MINIMARCK_PROBE=0` on top of the same staging
 * directory, and the two cannot drift because both call the same helper.
 *
 * WHY `dev` GOES THROUGH HERE TOO. The staging happens in esbuild's transform path, which the dev
 * server uses exactly as the build does. Leaving `npm run dev` pointing straight at `electron-vite`
 * would ship a build that works and a dev loop that fails, which is the worst way for this to show
 * up — halfway through a change, with the message blaming the code you are editing.
 *
 * `node scripts/build.mjs` with no argument builds. With a first argument, that subcommand is what
 * electron-vite receives, so `node scripts/build.mjs dev` runs the dev server.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stagingEnv, stagingDir } from './staging-temp.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const subcommand = process.argv[2] ?? 'build'
const known = new Set(['build', 'dev'])
if (!known.has(subcommand)) {
  console.error(`build — unknown subcommand "${subcommand}". Expected one of: ${[...known].join(', ')}`)
  process.exit(1)
}

// Locate the electron-vite binary through the local node_modules rather than relying on `npx`,
// which would be free to fetch a different version than the one in package-lock.json.
const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite')
if (!existsSync(bin)) {
  console.error(`build — ${bin} not found. Run: npm install`)
  process.exit(1)
}

if (subcommand === 'build') {
  // Worth saying out loud, because otherwise a failing build looks like it has nothing to do with
  // TEMP. See staging-temp.mjs.
  console.log(`build — staging esbuild payloads in ${stagingDir(root)}`)
}

const result = spawnSync(bin, [subcommand], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: stagingEnv(root)
})

if (result.status !== 0) {
  console.error(`build FAILED — electron-vite ${subcommand} exited ${result.status}`)
  console.error('build — if this says "Acceso denegado" on an esbuild-* temp file, the staging')
  console.error('build — override did not take effect. See scripts/staging-temp.mjs.')
  process.exit(result.status === null ? 1 : result.status)
}

// The staging directory is left in place on purpose. See staging-temp.mjs for why nothing here
// deletes it.
if (subcommand === 'build') {
  const indexHtml = path.join(root, 'out', 'renderer', 'index.html')
  if (!existsSync(indexHtml)) {
    // electron-vite exited 0 without a renderer entry point. Without this the script would report
    // success and every later `verify:*` would fail on a missing artefact instead.
    console.error(`build FAILED — electron-vite exited 0 but ${indexHtml} does not exist`)
    process.exit(1)
  }
  console.log('build — OK, out/renderer/index.html emitted')
}