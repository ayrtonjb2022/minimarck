import { defineConfig } from 'electron-vite'

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
 * cannot load (the bridge would silently not exist). `build` also verifies this by
 * launching the real window and asserting the 4-member bridge on `window.minimarck`.
 */
export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: { input: { index: 'src/main/index.js' } }
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
    build: {
      outDir: 'out/renderer',
      // 'app://bundle' is the scheme root; the protocol handler supplies index.html for
      // any path with no file behind it, so BrowserRouter deep-links keep working.
      base: '/'
    }
  }
})
