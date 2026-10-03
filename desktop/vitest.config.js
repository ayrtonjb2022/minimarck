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
     * A COMMITTED `.only` IS A SILENT SUITE REDUCTION, so it is refused outright.
     *
     * `npm test` is the only automated gate in this package: there is no CI workflow and no git
     * hook, so nothing else here would ever notice one. A developer debugging a single spec writes
     * `.only`, sees green, and — if the file is committed — `npm test` then runs a handful of tests
     * instead of the suite and still prints a passing summary. The failure mode is not a red build,
     * it is the ABSENCE of one, which is why it needs a config-level refusal rather than a review
     * habit. With this set, a focused test fails the run with
     * `[Vitest] Unexpected .only modifier. Remove it or pass --allowOnly argument to bypass this
     * error` — measured, not assumed.
     *
     * ⚠ IT IS `allowOnly: false`, AND IT IS NOT A TYPO FOR `forbidOnly`.
     *
     * `forbidOnly` is JEST's name for this. VITest has no such key: grepping `node_modules/vitest/dist`
     * returns zero occurrences of the string. An unknown key is not rejected by Vitest's config
     * resolution — it is silently dropped — so writing `forbidOnly: true` produces a line of config
     * that READS like a safety gate, APPEARS to a reviewer to be one, and enforces nothing. That is
     * the worst possible outcome for this option and it was measured here rather than reasoned about:
     * with `forbidOnly: true` in place and a `.only` in a spec, the run was GREEN with the focused
     * test passing and the other skipped.
     *
     * Vitest spells the same intent as `allowOnly`, with the polarity INVERTED
     * (`defaults: allowOnly: !isCI`, and it is forwarded into the project config as
     * `allowOnly: config.allowOnly`). The default is therefore "allow" on a developer machine and
     * "forbid" in CI — and this package has no CI, so it was running on the permissive branch with
     * nothing to catch it. Pin it off explicitly.
     */
    allowOnly: false,
    /**
     * RAISED FROM VITEST'S 5s DEFAULT, and the reason is measured rather than felt.
     *
     * Most specs here are not unit tests of pure functions: they open a REAL SQLite file in a
     * real temp directory, run a real `001_init.sql` migration or copy a checkpointed template,
     * and close. On this Windows box, eight spec files do that in parallel, and the resulting
     * disk contention pushed individual tests past 5s of WALL CLOCK. The symptom was
     * `Test timed out in 5000ms` spread across files that have nothing to do with each other —
     * including `node-sqlite.smoke.spec.js > creates a database file, a table, inserts a row, and
     * reads it back`, which cannot hang because there is nothing in it that blocks.
     *
     * 20s is four times the default, so a test that needs it is genuinely waiting on the OS
     * rather than merely slow. A timeout this high cannot hide a real hang, because a real hang
     * fails at 20s too — it just fails honestly instead of intermittently.
     *
     * WHAT 20s DOES NOT MEAN, because the number is a PER-TEST ceiling and not a budget for the
     * run. An earlier version of this comment justified itself with "five consecutive runs at 20s
     * were green 347/347 in 6.8-8.2s" — that was TRUE for the 347 tests that existed then, and it
     * is NOT a statement about the suite as it stands. The suite is now 861 tests across 46 files
     * and a full `npm test` measures 68s to 114s of WALL CLOCK across three runs on this box, a
     * 1.7x spread, with `tests/db/backup.spec.js` alone at ~17s in isolation. Anyone reading "20s"
     * as "the suite runs in 20s" would be off by more than three times over; read it as "no single
     * test is allowed to occupy more than a fifth of the slowest observed full run, which is
     * roughly three times the slowest file measured in isolation".
     *
     * The spread is the honest reason this is a ceiling and not a target: at 20s the suite is
     * green on a quiet machine AND on a loaded one, because per-test pressure does not scale with
     * the contention as sharply as the total wall clock does. Do not lower it on the strength of a
     * fast run — that is what put `tests/ui/respaldos.spec.jsx` in a state where two tests passed
     * alone and failed in the 46-file run.
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
