import { defineConfig } from 'electron-vite'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// This package is `"type": "module"`, so `__dirname` is not defined here. The config already
// leans on `path.resolve('...')` (which resolves against process.cwd) for the migrations dir;
// the alias below needs a real absolute path, so it comes from `import.meta.url` instead of
// depending on where the build was invoked from.
const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Emit `001_init.sql` next to the main bundle.
 *
 * `db/paths.js` `defaultMigrationsDir()` resolves `./migrations/` against the main bundle's own
 * `import.meta.url`, so the SQL has to sit at `out/main/migrations/`. Without this the app
 * builds, launches, and silently runs at `user_version = 0` with an empty database — the
 * packaging failure mode is a WORKING app with no schema, not a crash, so nothing upstream
 * would ever notice.
 *
 * A hand-rolled plugin rather than `viteStaticCopy` because this is one directory of read-only
 * assets, and the alternative is a dependency whose job is to move files. `emitFile` keeps the
 * SQL inside the build graph, so rollup reports it as an emitted asset and a missing file fails
 * the build instead of producing an empty directory.
 *
 * `verify:migrations` then asserts the emitted tree matches `src/main/db/migrations/`, so a
 * rename or a new migration cannot land without being packaged.
 */
function emitMigrations() {
  const srcDir = path.resolve('src/main/db/migrations')
  return {
    name: 'minimarck:emit-migrations',
    generateBundle() {
      let files
      try {
        files = readdirSync(srcDir)
      } catch {
        // No migrations yet is a legitimate state (the runner is allowed to run against an
        // absent directory), so this is a warning rather than a build failure.
        this.warn('src/main/db/migrations not found; no migration will be packaged')
        return
      }
      for (const file of files) {
        if (!file.toLowerCase().endsWith('.sql')) continue
        this.emitFile({
          type: 'asset',
          fileName: `migrations/${file}`,
          source: readFileSync(path.join(srcDir, file))
        })
      }
    }
  }
}

/**
 * Strip the launch probe out of the renderer for a RELEASE build.
 *
 * WHAT THE PROBE IS. `src/renderer/probe.js` is the S0 launch proof: it wraps
 * fetch/XHR/WebSocket/EventSource/sendBeacon, watches the DOM with a MutationObserver, and fires
 * a set of DELIBERATELY REFUSED calls (a bad IPC group, a blocked inline script, an attempted
 * network beacon) to prove the sandbox and the CSP actually hold. `probe:launch` reads its
 * results off `window.__S0_PROBE__` and turns them into a pass/fail gate over the real window.
 *
 * WHY IT MUST NOT SHIP. It is a development instrument, and it is not harmless decoration in a
 * shop:
 *
 *   1. It fires refused IPC calls on EVERY page load, forever, in a production app. Each one
 *      crosses the process boundary, is rejected by the security layer, and raises an
 *      `IpcError`. A till is a machine that is expected to run all day, and the cost of the
 *      instrument is paid on every single navigation for the lifetime of the install.
 *   2. It is a denial-of-self vector by construction: a MutationObserver plus patched network
 *      APIs is permanent overhead on the same UI thread that has to render a sale under time
 *      pressure. Not fatal, but not free, and not needed by a user.
 *   3. It leaves debug state in the page (`window.__S0_PROBE__`, the `#results` list). A user who
 *      opens devtools sees a pass report for checks that have nothing to do with their shop, and
 *      anyone reading the DOM sees probe output mixed into the app.
 *
 * WHY IT IS NOT DELETED. The security claim it proves is load-bearing: "the renderer cannot reach
 * SQL or the filesystem" is only true if something checks, on every page load, that the sandbox
 * and the CSP are really in force. Deleting the probe would delete the evidence and keep the
 * claim, which is the worst of both.
 *
 * SO: the probe stays in the repository and stays in the GATE, and the release build simply does
 * not contain it. Two builds, one source tree:
 *
 *   npm run build         -> probe INCLUDED. This is what `verify:s0` builds and then drives
 *                            with `probe:launch`, so the gate keeps testing the real thing.
 *   npm run build:release -> probe EXCLUDED. This is what `npm run dist` packages.
 *
 * The gate is `MINIMARCK_PROBE`. It defaults to ON, because a build that silently stopped
 * emitting the probe would turn `probe:launch` into a test that waits 20 seconds and fails for
 * the wrong reason, and a failing-for-the-wrong-reason gate gets deleted. Explicitly OFF is the
 * only way to get the release artifact.
 *
 * WHY THE HTML IS REWRITTEN RATHER THAN THE MODULE. A guard inside `probe.js` cannot work: the
 * flag would have to survive a client-side navigation, and the deep-link check (NAV-3) depends on
 * the probe re-executing on the NEW document without the URL carrying anything. Removing the
 * script tag makes the absence structural - there is no probe code in the bundle to run, and no
 * flag that could accidentally re-enable it - instead of a runtime condition that could be
 * forgotten, mis-set, or defeated by a query parameter.
 */
function stripProbeForRelease() {
  const included = process.env.MINIMARCK_PROBE !== '0'
  return {
    name: 'minimarck:release-probe',
    // Runs on the index.html transform, before it is written out. There is no
    // `transformIndexHtml` hook, because that hook runs at DEV-server request time and this
    // decision has to be baked into the BUILD OUTPUT, not re-decided per request.
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (included) return html
        return (
          html
            // The probe's own module script.
            .replace(/[ \t]*<script[^>]*probe\.js[^>]*><\/script>\r?\n?/g, '')
            // The hidden <ul> it writes into.
            .replace(/[ \t]*<ul id="results"[^>]*><\/ul>\r?\n?/g, '')
            // AND THE COMMENTS THAT EXPLAIN THEM, which is the part a first pass gets wrong.
            //
            // Both elements in this file are preceded by a multi-line comment that says, in
            // detail, why the probe is first and where it writes. Removing the tags and keeping
            // the prose leaves the shipped index.html claiming the page "must be in place BEFORE
            // React mounts" for a module that is not there, and it makes the "is the probe gone?"
            // check ambiguous: grep for `probe.js` and the file still answers yes, in a comment,
            // long after the thing is gone. A build output that misdescribes itself is worse than
            // no comment, and a verifier that cannot distinguish the two stops being trusted.
            //
            // Non-greedy, so it matches one comment at a time, and it is anchored on the word
            // `probe` so the unrelated comments in this file (the data: favicon note, which
            // matters and must survive) are left alone.
            .replace(/[ \t]*<!--(?:(?!--)[\s\S])*?probe(?:(?!--)[\s\S])*?-->\r?\n?/gi, '')
        )
      }
    }
  }
}

/**
 * electron-vite build for the desktop shell. Three targets: the Electron main process,
 * the sandboxed preload bridge, and the renderer that is served over the `app://` scheme.
 *
 * The main process resolves the preload and the renderer root at runtime RELATIVE to its
 * own `__dirname`, so the layout below is the contract:
 *   main     -> out/main/index.js      (so  ../preload  and ../renderer  resolve)
 *   preload  -> out/preload/index.cjs
 *   renderer -> out/renderer           (served as app://bundle/...)
 *
 * Deviation from design §B.1/§A.1, recorded in desktop/README.md: the design assumed an
 * unbundled main at `src/main` and therefore wrote the renderer root as `../../dist/renderer`.
 * electron-vite emits `out/main`, so the equivalent root is `../renderer`. The shape from
 * main to preload (one `..`) is unchanged.
 *
 * The preload is deliberately emitted as CommonJS `.cjs`. SEC-3 requires `sandbox: true`,
 * and a sandboxed preload is ALWAYS CommonJS: with the package `"type": "module"`,
 * electron-vite's default ESM output would be `index.mjs`, which a sandboxed preload
 * cannot load (the bridge would silently not exist).
 *
 * `build` does NOT verify that. It will happily emit `index.mjs` and exit 0. What
 * verifies it is `npm run verify:preload` (reads this file AND the emitted output) plus
 * `npm run probe:launch` (launches the real window and asserts the 4-member bridge), and
 * both run inside `npm run verify:s0`.
 */
export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: 'src/main/index.js' },
        plugins: [emitMigrations()]
      }
    }
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: 'src/preload/index.js' },
        // Sandbox: the preload cannot be ESM, so force the CJS output format + extension.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    // `tailwindcss()` is what turns `@import "tailwindcss"` in styles/index.css into real
    // utility CSS. Without it that import resolves to nothing and every `dark:` utility in
    // the vendored pages silently becomes an unknown class — the pages still render, they
    // just never get their dark variants.
    //
    // `stripProbeForRelease()` is first so its index.html transform runs before React's.
    plugins: [stripProbeForRelease(), react(), tailwindcss()],
    resolve: {
      // `@shared/*` is `src/shared/*`, the money/quantity/contract modules main and the renderer
      // BOTH import. It is the whole point of that directory: a total computed by `lineTotalCentavos`
      // in the renderer and one computed by `ventas.repo.js` in main are the same function, not two
      // implementations that agree today. The alias is here so a renderer file does not have to
      // count `../` hops out of `src/renderer/app/pages/` to reach a sibling of `main/`, which is
      // exactly the kind of path that silently gains a level and resolves to nothing.
      alias: { '@shared': path.resolve(here, 'src/shared') }
    },
    build: {
      outDir: 'out/renderer',
      // NO `base` HERE, ON PURPOSE. electron-vite UNCONDITIONALLY overwrites the renderer's
      // `base` with './' in production (its `electronRendererVitePlugin` runs an `enforce: 'pre'`
      // config hook that assigns `config.base = './'` when mode is production), so a value set
      // here — top-level or nested, it makes no difference — is discarded without a word and the
      // build exits 0. The emitted index.html therefore references `./assets/<hash>.js`.
      //
      // That is FINE for a document at the scheme root, and WRONG for this app's nested routes:
      // a relative URL resolves against the document's DIRECTORY, so serving the same shell at
      // `app://bundle/reportes/gastos` asks for `app://bundle/reportes/assets/<hash>.js`, which
      // 404s, and the window comes up blank with no console error to explain it. `protocol.js`
      // fixes it where it can actually be fixed — when the shell is served for a route, it
      // rewrites those URLs to the scheme root. Do not try to solve it here.
    }
  }
})
