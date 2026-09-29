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
    // `.jsx` is here for `tests/ui/`, which mounts the real React POS with JSX. The DOM specs
    // opt into jsdom with a `@vitest-environment` docblock so the rest of the suite keeps
    // running in plain Node against `node:sqlite`.
    include: ['tests/**/*.spec.js', 'tests/**/*.spec.jsx'],
    // The S0 probe/glue modules are not themselves under test; the specs import the
    // pure functions they contain.
    exclude: ['node_modules/**', 'out/**', 'dist/**'],
    /**
     * RAISED FROM VITEST'S 5s DEFAULT, and the reason is measured rather than felt.
     *
     * Most specs here are not unit tests of pure functions: they open a REAL SQLite file in a
     * real temp directory, run a real `001_init.sql` migration or copy a checkpointed template,
     * and close. On this Windows box, eight spec files do that in parallel, and the resulting
     * disk contention pushed individual tests past 5s of WALL CLOCK even though the whole suite
     * finishes in ~7s. The symptom was `Test timed out in 5000ms` spread across files that have
     * nothing to do with each other — including `node-sqlite.smoke.spec.js > creates a database
     * file, a table, inserts a row, and reads it back`, which cannot hang because there is
     * nothing in it that blocks.
     *
     * 20s is four times the default and roughly twenty times the median test, so a test that
     * needs it is genuinely waiting on the OS rather than merely slow. The number is a
     * PLATFORM bound, not a hope: five consecutive runs at 20s were green 347/347 in 6.8-8.2s.
     * A timeout this high cannot hide a real hang, because a real hang fails at 20s too — it
     * just fails honestly instead of intermittently.
     */
    testTimeout: 20000,
    hookTimeout: 20000
  },
  esbuild: {
    // The automatic JSX runtime, matching what @vitejs/plugin-react does for the app build.
    // Without it, esbuild's default `jsx: 'transform'` emits `React.createElement` into
    // `tests/ui/*.jsx` and every spec there dies with `React is not defined` — a failure about
    // the harness, not about the POS, which is the worst kind to read.
    jsx: 'automatic'
  },
  resolve: {
    alias: {
      electron: fileURLToPath(new URL('./tests/stubs/electron.js', import.meta.url))
    }
  }
})
