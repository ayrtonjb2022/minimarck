import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * Vitest runs under the SYSTEM Node, not Electron. Two consequences:
 *  1. `node:sqlite` must work under system Node too, because S1+ database tests will run
 *     here. `tests/node-sqlite.smoke.spec.js` proves that harness up front.
 *  2. The main-process modules that `import ... from 'electron'` cannot be loaded as-is,
 *     so `electron` is aliased to a stub. Only the PURE parts of those modules (the
 *     webPreferences builder, the CSP builder, the sender check, the bundle-path resolver)
 *     are under test; the stub exists purely so those pure functions can be imported.
 *
 * The alias uses `fileURLToPath`, never `new URL(...).pathname`: on Windows pathname is
 * `/C:/Users/...`, which is not a real path. That is the same anti-pattern
 * `scripts/verify-offline.mjs` hit and fixed — it is not worth reintroducing in the harness
 * that is supposed to catch such things.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.js'],
    // The S0 probe/glue modules are not themselves under test; the specs import the
    // pure functions they contain.
    exclude: ['node_modules/**', 'out/**', 'dist/**']
  },
  resolve: {
    alias: {
      electron: fileURLToPath(new URL('./tests/stubs/electron.js', import.meta.url))
    }
  }
})
