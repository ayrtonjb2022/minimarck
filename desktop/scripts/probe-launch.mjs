/**
 * Launch the real app under the S0 probe and propagate its exit code.
 *
 * `probe:launch` used to be `electron out/main/index.js`, which only runs the probe when
 * MINIMARCK_S0_PROBE is already set in the environment. That made it awkward to put in a
 * gate: the reviewer had to know the variable. This sets it for the child unconditionally,
 * so `npm run probe:launch` IS the probe whether or not you set the variable yourself —
 * setting it is still harmless, so the documented command keeps working.
 */
import { rmSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import electronPath from 'electron'
import { correrElectron, codigoDeSalida, dirDePrueba } from './electron-runner.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const desktopRoot = join(here, '..')
const mainEntry = join('out', 'main', 'index.js')

/**
 * REFUSE TO START unless `out/` is a build that can actually answer this gate.
 *
 * WHY THIS IS HERE, AND WHY IT IS NOT DEFENSIVE FILLER. The probe is a RENDERER instrument: it is
 * `src/renderer/probe.js`, it publishes on `window.__S0_PROBE__`, and `src/main/index.js` polls
 * that global for 20 seconds before declaring failure. But `stripProbeForRelease()` in
 * `electron.vite.config.js` REMOVES the probe from a release build on purpose — so if `out/` happens
 * to hold the output of `npm run build:release` (or of `npm run dist`, which builds that first),
 * the main process arms a probe that is not in the bundle, waits the full timeout, and reports
 * "renderer probe never reported within 20s". That message names the renderer as the fault when the
 * renderer was never given the thing it was asked about.
 *
 * This exact failure happened here: `out/` was left over from a release build, and the first
 * honest reading of the log was "the renderer is broken". It is not. `npm run build` fixed it and
 * the probe went 25/25 plus 4/4 deep links on the next run, with no source change at all.
 *
 * A gate that fails for the wrong reason is a gate that gets deleted, so it fails HERE instead —
 * immediately, and with the command that fixes it. The marker is the `<ul id="results">` element,
 * because that is the exact element `stripProbeForRelease()` removes along with the script tag, and
 * the element is what survives into the emitted HTML either way the bundler rewrites the scripts.
 */
if (!existsSync(mainEntry)) {
  console.error(`probe:launch — ${mainEntry} does not exist. Run \`npm run build\` first.`)
  process.exit(1)
}

const rendererHtml = join(desktopRoot, 'out', 'renderer', 'index.html')
if (!existsSync(rendererHtml) || !readFileSync(rendererHtml, 'utf8').includes('id="results"')) {
  console.error(
    [
      `probe:launch — the build in out/ carries NO launch probe.`,
      ``,
      `  src/main/index.js arms the renderer probe whenever MINIMARCK_S0_PROBE is set, and then`,
      `  polls window.__S0_PROBE__ for 20s. A RELEASE build has no probe in it by design`,
      `  (stripProbeForRelease() in electron.vite.config.js), so the wait can never succeed.`,
      ``,
      `  This is a stale out/, not a broken renderer. Build the gate's own artifact:`,
      ``,
      `      npm run build        # probe INCLUDED — this is what verify:s0 drives`,
      `      npm run build:release # probe EXCLUDED — only for npm run dist`,
      ``,
      `  Found: ${rendererHtml.replace(desktopRoot + '\\', '')}${existsSync(rendererHtml) ? ' (no <ul id="results">)' : ' (missing)'}`
    ].join('\n')
  )
  process.exit(1)
}

// A throwaway base per run, so the probe never touches the shop's real profile and a half-written
// one from a killed run cannot make the next probe fail for the wrong reason.
//
// It is created HERE by THIS process, under `desktop/run/`, rather than by the Electron child in
// `%TEMP%`. Both halves are measured and both are documented in `electron-runner.mjs`: a Chromium
// main process on a shell with no interactive desktop session cannot write outside the repository
// at all. One directory carries the whole probe — the app reads `MINIMARCK_DATA_DIR` for BOTH the
// shop file and the throwaway `userData` profile, so nothing here can reach a real shop.
const dataDir = dirDePrueba('probe')
console.log(`probe:launch — using throwaway data dir ${dataDir}`)

const result = correrElectron(electronPath, mainEntry, {
  cwd: desktopRoot,
  env: {
    MINIMARCK_S0_PROBE: '1',
    MINIMARCK_DATA_DIR: dataDir,
    MINIMARCK_USER_DATA_DIR: dataDir
  }
})

try {
  rmSync(dataDir, { recursive: true, force: true })
} catch {
  /* locked by a dead process — `desktop/run/` is gitignored and a later run makes a new one */
}

process.exit(codigoDeSalida(result))
