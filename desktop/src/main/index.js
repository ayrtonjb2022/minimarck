import { app, ipcMain, Menu, BrowserWindow, shell } from 'electron'
import { createRegistry } from './bridge/registry.js'
import { toIpcError } from './bridge/errors.js'
import { CHANNEL, ENVELOPE_VERSION } from '../shared/ipc-contract.js'
import { assertTrustedSender, applyWebContentsSecurity } from './security.js'
import { registerAppSchemePrivileges, registerAppProtocol, rendererUrl } from './protocol.js'
import { createWindow } from './window.js'
import { registerDbHandlers } from './ipc/db.js'
import { registerCajasHandlers } from './ipc/cajas.js'
import { registerVentasHandlers } from './ipc/ventas.js'
import { registerAuthHandlers } from './ipc/auth.js'
import { registerNegocioHandlers } from './ipc/negocio.js'
import { registerProductosHandlers } from './ipc/productos.js'
import { registerCategoriasHandlers } from './ipc/categorias.js'
import { registerDeudoresHandlers } from './ipc/deudores.js'
import { bootstrapDatabase } from './db/bootstrap.js'
import { identityWarning, resolveLocalIdentity } from './db/identity.js'
import { handleSecondInstance, planRendererRecovery, runBeforeQuit } from './lifecycle.js'
import { APP_NAME } from './dataDir.js'

const isPackaged = app.isPackaged

// PLAT-2: name the Electron profile BEFORE anything reads userData. Unpackaged, Electron
// derives the path from the package name, and an app run via `electron out/main/index.js`
// resolved to the SHARED `…\AppData\Roaming\Electron\` profile — the same directory every
// other Electron app on the machine uses, so two of them collide. This is what makes the
// data land under `…\AppData\Roaming\MiniMarck\` instead. Set from the constant, not from
// package.json, so a rename cannot silently move a user's database.
app.setName(APP_NAME)

// The `app` scheme must be declared privileged BEFORE the app is ready (design §B.1).
registerAppSchemePrivileges()

// PLAT-4: one process against one database file. Two windows on one SQLite file is a
// silent corruption path, so a second launch focuses the first instead of starting.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // PLAT-4: focus, never open a second window. Two windows on one SQLite file is the
    // corruption path; `BEGIN IMMEDIATE` would only turn it into a BUSY error.
    handleSecondInstance({ getWindows: () => BrowserWindow.getAllWindows() })
  })
}

/**
 * The ONE IPC endpoint. Every renderer request funnels through here and must pass, in
 * order: envelope version, trusted sender, then the allowlisted (group, op). Nothing
 * reaches business code without clearing all three (SEC-2, SEC-4).
 *
 * `identity` is the LOCAL IDENTITY — the business this file belongs to and the operator on duty
 * (design #275: no login, no session, no token). It is resolved ONCE at startup and closed over
 * here, which is the whole reason `installIpc` takes it as an argument rather than reading it
 * per request: a per-request read would be a per-request guess, and the one time the file has two
 * businesses in it is exactly when a guess is worst. With no resolvable identity the object
 * carries `negocioId: null` and every business operation answers the existing, already-tested
 * `TENANT_REQUIRED` — a refusal, not a silent default to some other shop's data.
 */
function installIpc(registry, identity) {
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
      // ctx is threaded explicitly (design §C.3). negocioId/actorId are the tenant boundary every
      // repository must scope by (SEC-6) and they come from the resolved local identity, not
      // from the renderer: a frame that named its own tenant would be a frame with admin rights.
      // `createCtx` destructures only these two, so the extra display fields below never reach a
      // repository — `auth.me` reads them from the request context instead.
      const ctx = {
        negocioId: identity.negocioId,
        actorId: identity.actorId,
        negocioNombre: identity.negocioNombre,
        operadorNombre: identity.operadorNombre,
        rol: identity.rol,
        motivo: identity.motivo
      }
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
  // S1 opens the REAL database: resolve paths once, open with WAL + FKs + the table
  // allowlist, run pending migrations, then the first-run seed. S1 ships no `001_init.sql`
  // (S2 owns the 22-table schema), so on a fresh profile this lands at version 0 with an
  // empty allowlist — which means no production code can write yet, correctly.
  const db = bootstrapDatabase({
    userDataPath: app.getPath('userData'),
    env: process.env
  })
  // db.info / db.schemaVersion are real now. db.reconcile stays 501 (S17).
  registerDbHandlers(registry, db)
  // Sales and the till. Both are one transaction each, both scope every statement to the
  // business the local identity resolved, and neither widens `OPS` — `ventas` (3), `cajas` (7)
  // and `cajaMovimientos` (3) are the operations the contract already named.
  registerVentasHandlers(registry, { conn: db.conn })
  registerCajasHandlers(registry, { conn: db.conn })

  // WHO IS SELLING, AND WHAT IS FOR SALE.
  //
  // Before this, every business operation in the app answered TENANT_REQUIRED: `installIpc`
  // passed `{negocioId: null}` and every repository calls `requireTenant` on the way in. The
  // handlers were right and the schema was right; the missing piece was the answer to "which
  // shop is this file?", which is a fact about the FILE and not about the request.
  //
  // Resolved once, after the seed has run, so it sees the business and operator the seed just
  // created. Every group below is a group the FROZEN contract already named — no `OPS` edit, so
  // the count is still 88. `auth.me` answers for the operator (there is no login on this
  // platform); `productos`/`categorias` are what a point of sale reads to show its grid and look
  // up a barcode; `deudores` is what makes a credit sale possible, since a credit sale with no
  // named debtor is income nobody can collect.
  const identity = resolveLocalIdentity(db.conn)
  const avisoIdentidad = identityWarning(identity)
  if (avisoIdentidad) console.warn(avisoIdentidad)
  else console.log(`[identity] ${identity.negocioNombre} · ${identity.operadorNombre} (${identity.rol})`)

  registerAuthHandlers(registry, { conn: db.conn })
  registerNegocioHandlers(registry, { conn: db.conn })
  registerProductosHandlers(registry, { conn: db.conn })
  registerCategoriasHandlers(registry, { conn: db.conn })
  registerDeudoresHandlers(registry, { conn: db.conn })
  installIpc(registry, identity)

  const win = createWindow({ isPackaged, rendererUrl: url })

  // PLAT-5: a crashed renderer is an UNKNOWN outcome, not a failed call. Re-read state, do
  // NOT re-invoke the request that died mid-flight — see lifecycle.js for why replaying it
  // would duplicate a committed sale until S4's idempotency key exists.
  win.webContents.on('render-process-gone', (_e, details) => {
    const plan = planRendererRecovery({ reason: details?.reason, exitCode: details?.exitCode })
    console.error('[lifecycle] renderer gone:', JSON.stringify(plan))
  })

  win.webContents.on('did-finish-load', () => {
    installMenu(() => shell.openPath(db.paths.dataDir))
    if (process.env.MINIMARCK_S0_PROBE) runLaunchProbe(win)
  })

  // PLAT-6: checkpoint the WAL so the on-disk .db is self-contained before close. S0 opened
  // no database and this handler was an empty comment; S1 runs the real
  // `PRAGMA wal_checkpoint(TRUNCATE)` then `db.close()` through the tested path in
  // lifecycle.js, and warns if a cash register is still open (S4 supplies the predicate).
  app.on('before-quit', () => {
    runBeforeQuit({
      conn: db.conn,
      // Real now, and deliberately tenant-less: this is a warning about the FILE, not about one
      // business, and the desktop seeds exactly one. Closing a database with a drawer still open
      // is an accounting problem, so the predicate is a query rather than a placeholder.
      hasOpenRegister: () =>
        db.conn.db
          .prepare(`SELECT COUNT(*) AS n FROM cajas WHERE estado = 'abierta' AND deleted_at IS NULL`)
          .get().n > 0,
      log: (m) => console.log(m),
      warn: (m) => console.warn(m)
    })
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

/**
 * `main()` is async, so a throw anywhere in it — a migration that refuses to run, a database
 * that cannot be opened, a path that cannot be resolved — used to become an UNHANDLED
 * REJECTION. Electron had already reached `whenReady`, so its event loop stayed alive with no
 * window and nothing scheduled to quit: the process hung, silently, forever.
 *
 * That is the worst possible failure mode in two directions at once. `probe:launch` could not
 * report a failure, it could only hang until something killed it, so the gate proved nothing.
 * And a real user whose database would not open got an invisible, windowless process instead
 * of an error — no dialog, no log, no exit code, just a task that refuses to die.
 *
 * A startup that cannot complete must TERMINATE and say why. `app.exit` is used once the app is
 * ready, because it skips the `before-quit` handlers, which is what is wanted here: the
 * lifecycle checkpoint is written for a database that opened cleanly, and running it against a
 * half-initialised one could obscure the real failure. Before readiness `app.exit` is not
 * reliable, so that path falls back to `process.exit`.
 */
function onStartupFailure(err) {
  const message = err?.stack || err?.message || String(err)
  console.error('[startup] fatal — the app could not start:')
  console.error(message)
  if (app.isReady()) app.exit(1)
  else process.exit(1)
}

if (gotLock) main().catch(onStartupFailure)
