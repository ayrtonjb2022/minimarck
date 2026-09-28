import { app, ipcMain, Menu, BrowserWindow, shell } from 'electron'
import { createRegistry } from './bridge/registry.js'
import { toIpcError } from './bridge/errors.js'
import { CHANNEL, ENVELOPE_VERSION } from '../shared/ipc-contract.js'
import { assertTrustedSender, applyWebContentsSecurity } from './security.js'
import { registerAppSchemePrivileges, registerAppProtocol, rendererUrl } from './protocol.js'
import { createWindow } from './window.js'
import { registerDbHandlers } from './ipc/db.js'

const isPackaged = app.isPackaged

// The `app` scheme must be declared privileged BEFORE the app is ready (design §B.1).
registerAppSchemePrivileges()

// PLAT-4: one process against one database file. Two windows on one SQLite file is a
// silent corruption path, so a second launch focuses the first instead of starting.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

/**
 * The ONE IPC endpoint. Every renderer request funnels through here and must pass, in
 * order: envelope version, trusted sender, then the allowlisted (group, op). Nothing
 * reaches business code without clearing all three (SEC-2, SEC-4).
 */
function installIpc(registry) {
  ipcMain.handle(CHANNEL, async (event, envelope) => {
    try {
      if (!envelope || envelope.v !== ENVELOPE_VERSION) {
        const e = new Error('bad envelope version')
        e.code = 'BAD_VERSION'
        e.status = 400
        throw e
      }
      // SEC-4: reject any frame that is not the trusted origin. Checked on senderFrame
      // so a child frame cannot spoof the parent.
      assertTrustedSender(event.senderFrame?.url, isPackaged)
      const handler = registry.resolve(envelope.group, envelope.op)
      // ctx is threaded explicitly (design §C.3); negocioId/actorId are filled in by S4's
      // local auth marker and are the tenant boundary every repository must scope by (SEC-6).
      const ctx = { negocioId: null, actorId: null }
      return await handler(envelope.payload ?? {}, ctx)
    } catch (err) {
      throw toIpcError(err)
    }
  })
}

function installMenu(onOpenDataDir) {
  const template = [
    // Backup engine is S15; the menu item is added with it, not stubbed now.
    { label: 'Abrir carpeta de datos', click: onOpenDataDir },
    { role: 'quit', label: 'Salir' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * S0 LAUNCH PROOF (OFFL-1..3, SEC-1..4, PLAT-2, VIS-3) — active only when
 * MINIMARCK_S0_PROBE=1.
 *
 * The renderer probe publishes its result on `window.__S0_PROBE__`. This polls for it, prints
 * every check, and exits the process with 0/1 so `npm run probe:launch` is a real pass/fail
 * gate over the ACTUAL window over the ACTUAL app:// origin with the ACTUAL preload. Nothing
 * here is a mock and nothing is asserted in the abstract: if the preload failed to load, or
 * the sandbox leaked, or the origin were opaque, the probe fails and the exit code is 1.
 */
function runLaunchProbe(win) {
  const deadline = Date.now() + 20_000
  const poll = async () => {
    let result
    try {
      result = await win.webContents.executeJavaScript('window.__S0_PROBE__ || null')
    } catch {
      result = null
    }
    if (result) {
      for (const r of result.results) {
        console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? '  — ' + r.detail : ''}`)
      }
      const ok = result.failed === 0
      console.log(`=== ${result.total - result.failed}/${result.total} launch probe checks passed ===`)
      console.log(`S0 LAUNCH PROBE ${ok ? 'PASSED' : 'FAILED'}: url=${win.webContents.getURL()}`)
      app.exit(ok ? 0 : 1)
      return
    }
    if (Date.now() > deadline) {
      console.error('S0 LAUNCH PROBE FAILED: renderer probe never reported within 20s')
      app.exit(1)
      return
    }
    setTimeout(poll, 200)
  }
  setTimeout(poll, 300)
}

async function main() {
  await app.whenReady()

  // SEC-3: apply the lockdown to EVERY webContents, now and in the future.
  app.on('web-contents-created', (_e, contents) => {
    applyWebContentsSecurity(contents, contents.session, isPackaged)
  })

  // S0 serves the built renderer over app:// so localStorage + BrowserRouter work (OFFL-3).
  // electron-vite dev serves over http://localhost:5173, which SEC-4 trusts when unpackaged.
  const devUrl = process.env.ELECTRON_RENDERER_URL
  registerAppProtocol()
  const url = rendererUrl(isPackaged, devUrl)

  const registry = createRegistry()
  // S0 registers the read-only db.* contract only. Every other contract op resolves to
  // NOT_IMPLEMENTED (501) until its owning slice lands — honest, never a silent no-op.
  const dataPaths = registerDbHandlers(registry, {
    userDataPath: app.getPath('userData'),
    env: process.env
  })
  installIpc(registry)

  const win = createWindow({ isPackaged, rendererUrl: url })
  win.webContents.on('did-finish-load', () => {
    installMenu(() => shell.openPath(dataPaths.dataDir))
    if (process.env.MINIMARCK_S0_PROBE) runLaunchProbe(win)
  })

  // PLAT-6: checkpoint the WAL so the on-disk .db is self-contained before close. S0 opens
  // no database, so there is nothing to checkpoint yet; S1 replaces this with the real
  // `PRAGMA wal_checkpoint(TRUNCATE)` then `db.close()` (and warns on an open register).
  app.on('before-quit', () => {
    // S1: warn if a register is open, then checkpoint + close.
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow({ isPackaged, rendererUrl: url })
    }
  })
}

if (gotLock) main()
