import { BrowserWindow } from 'electron'
import path from 'node:path'

/**
 * The BrowserWindow's webPreferences, as a PURE function so the SEC-3 hardening flags are
 * directly assertable in a test rather than only observable by launching a window.
 *
 * SEC-3 mandates: contextIsolation:true, nodeIntegration:false, sandbox:true,
 * webSecurity:true, spellcheck:false, and devTools ONLY when unpackaged. `sandbox:true`
 * costs nothing here — the preload needs only `contextBridge` + `ipcRenderer`, both
 * available in a sandboxed preload — and it is what makes the renderer unable to reach
 * the filesystem, a socket, or `node:sqlite` by construction (design §A.3).
 */
export function buildWebPreferences(preloadPath, isPackaged) {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    spellcheck: false,
    devTools: !isPackaged
  }
}

/**
 * Resolve the preload path relative to THIS file's output dir (out/main -> out/preload).
 * The `.cjs` extension is required: SEC-3 demands `sandbox:true`, and a sandboxed preload
 * is always CommonJS. See the note in electron.vite.config.js.
 */
export function resolvePreloadPath() {
  return path.join(__dirname, '..', 'preload', 'index.cjs')
}

/**
 * Create the main window. `show:false` + `ready-to-show` avoids a white flash, and the
 * background matches the app's base token (#1e1e2e) so the first painted frame is right.
 */
export function createWindow({ isPackaged, rendererUrl }) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#1e1e2e',
    autoHideMenuBar: true,
    title: 'MiniMarck',
    webPreferences: buildWebPreferences(resolvePreloadPath(), isPackaged)
  })
  win.once('ready-to-show', () => win.show())
  if (rendererUrl) win.loadURL(rendererUrl)
  return win
}
