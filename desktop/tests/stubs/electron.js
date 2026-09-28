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
export const app = {
  isPackaged: false,
  name: 'electron',
  setName: (n) => { app.name = n },
  getPath: () => '/tmp/minimarck-userdata',
  whenReady: async () => {},
  on: () => undefined,
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
