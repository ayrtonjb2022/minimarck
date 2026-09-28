/**
 * Launch the real app under the S0 probe and propagate its exit code.
 *
 * `probe:launch` used to be `electron out/main/index.js`, which only runs the probe when
 * MINIMARCK_S0_PROBE is already set in the environment. That made it awkward to put in a
 * gate: the reviewer had to know the variable. This sets it for the child unconditionally,
 * so `npm run probe:launch` IS the probe whether or not you set the variable yourself —
 * setting it is still harmless, so the documented command keeps working.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import electronPath from 'electron'

const here = fileURLToPath(new URL('.', import.meta.url))
const desktopRoot = join(here, '..')
const mainEntry = join('out', 'main', 'index.js')

const result = spawnSync(electronPath, [mainEntry], {
  cwd: desktopRoot,
  stdio: 'inherit',
  env: { ...process.env, MINIMARCK_S0_PROBE: '1' }
})

if (result.error) {
  console.error(`probe:launch — could not start ${electronPath}: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status === null ? 1 : result.status)
