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
    plugins: [react(), tailwindcss()],
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
      // 'app://bundle' is the scheme root; the protocol handler supplies index.html for
      // any path with no file behind it, so BrowserRouter deep-links keep working.
      base: '/'
    }
  }
})
