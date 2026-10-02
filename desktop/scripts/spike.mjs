/**
 * `npm run spike` — the `node:sqlite` runtime proof, under Electron.
 *
 * WHY A WRAPPER AND NOT `electron src/main/spike/node-sqlite.spike.js` IN package.json.
 *
 * The spike must run INSIDE Electron, because its whole claim is "the Electron 44.4.5 runtime ships
 * a working `node:sqlite`" — running it under system Node would prove something about the machine
 * and nothing about the app. But `electron <file.js>` selects between two completely different
 * behaviours based on one inherited environment variable:
 *
 *   ELECTRON_RUN_AS_NODE unset  -> Electron starts, and the file runs as the Electron MAIN process
 *   ELECTRON_RUN_AS_NODE set    -> Electron does not start at all; the file runs as plain Node
 *
 * With it set, the spike still PRINTS ITS VERSION HEADER and then dies at the first Chrome-dependent
 * step, because there is no Electron runtime underneath it. On a developer machine that has that
 * variable exported, the first command of `verify:s0` fails with a stack trace about `node:sqlite`
 * and the real cause is an environment variable.
 *
 * The same trap hits the six gate scripts that spawn the Electron binary (`probe-launch.mjs` and the
 * five `drive-*.mjs`); they delete the variable from the child's environment for this reason. This
 * wrapper is the same fix for the one command that is spelled out in `package.json` instead of in a
 * script file.
 *
 * Setting it to the EMPTY STRING is not equivalent: Electron reads a present-but-empty variable as
 * "run as Node" too.
 *
 * ── `--no-sandbox`, AND WHY THE GATE NEEDS IT ────────────────────────────────────────────────
 *
 * Every script that spawns the Electron binary passes `--no-sandbox --disable-gpu
 * --disable-dev-shm-usage`, and on a Windows shell that is not attached to an interactive desktop
 * it is the difference between a gate that runs and a gate that cannot: without the flag the
 * binary dies BEFORE the first line of this script's entry point with Windows status `0x80000003`.
 * The flags, and the proof that the sandbox is the cause, are documented in `electron-runner.mjs`.
 *
 * Usage: node scripts/spike.mjs
 */
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import electronPath from 'electron'
import { correrElectron, codigoDeSalida, dirDePrueba } from './electron-runner.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const desktopRoot = join(here, '..')
const spike = 'src/main/spike/node-sqlite.spike.js'

// The throwaway directory is created HERE, not by the spike inside Electron, and it is under
// `desktop/run/` rather than `%TEMP%`. Both facts are measured, and both are explained in
// `electron-runner.mjs`: a Chromium main process on this kind of shell cannot write outside the
// repository, so a spike that made its own directory would abort with EPERM and the gate would
// report a missing `node:sqlite` that is present.
const spikeTmp = dirDePrueba('spike')

const result = correrElectron(electronPath, spike, {
  cwd: desktopRoot,
  env: { MINIMARCK_SPIKE_TMP: spikeTmp }
})

try {
  rmSync(spikeTmp, { recursive: true, force: true })
} catch {
  /* locked by a dead process — `desktop/run/` is gitignored and a later run makes a new one */
}

// The spike's OWN exit code is the verdict, so it is passed through rather than reinterpreted.
process.exit(codigoDeSalida(result))
