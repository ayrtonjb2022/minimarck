/**
 * A no-op `electron` stub so main-process modules with a top-level `import ... from
 * 'electron'` can be imported under Vitest (system Node) to unit-test their PURE parts.
 *
 * It is NOT a mock of Electron behaviour — it only satisfies the import so a pure function
 * can be reached. `contextBridge.exposeInMainWorld` records what a module exposes, which
 * is how the preload smoke asserts the four-member surface (SEC-1) without a real window.
 */
export const exposed = []

export const contextBridge = {
  exposeInMainWorld(key, value) {
    exposed.push({ key, value })
  }
}

export const ipcRenderer = {
  invoke: async () => undefined,
  on: () => undefined,
  removeListener: () => undefined
}

export const BrowserWindow = function BrowserWindow() {}
BrowserWindow.getAllWindows = () => []

export const ipcMain = { handle: () => undefined }

// S1 EXTENSION (was: `on: () => undefined`, which discarded every registration).
//
// `app.on` now RECORDS its listeners so `desktop/tests/lifecycle.spec.js` can assert that
// `before-quit` is actually wired and that firing it checkpoints the database. S0's
// registration surface was `db.*` only and no test needed the listeners back; PLAT-6's entire
// claim is "this handler exists and runs", and a stub that throws the handler away cannot
// prove it. `emit` is the matching test-side driver. Nothing else in the stub changes, and no
// Electron behaviour is simulated beyond "the listener is retrievable".
export const appEvents = Object.create(null)
export function emitApp(event, ...args) {
  const list = appEvents[event] || []
  for (const fn of list) fn(...args)
}
export function appListenerCount(event) {
  return (appEvents[event] || []).length
}
export const app = {
  isPackaged: false,
  name: 'electron',
  setName: (n) => { app.name = n },
  getPath: () => '/tmp/minimarck-userdata',
  whenReady: async () => {},
  on: (event, fn) => {
    (appEvents[event] ||= []).push(fn)
    return app
  },
  emit: emitApp,
  quit: () => undefined,
  exit: () => undefined,
  requestSingleInstanceLock: () => true
}
export const protocol = {
  registered: [],
  registerSchemesAsPrivileged: (schemes) => { protocol.registered.push(...schemes) },
  handle: () => undefined
}
export const Menu = { setApplicationMenu: () => undefined, buildFromTemplate: () => ({}) }
export const shell = { openPath: () => undefined }
export const dialog = {}
export const net = {}
