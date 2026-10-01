import { app, ipcMain, Menu, BrowserWindow, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
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
import { registerProveedoresHandlers } from './ipc/proveedores.js'
import { registerComprasHandlers } from './ipc/compras.js'
import { bootstrapDatabase } from './db/bootstrap.js'
import { identityWarning, resolveLocalIdentity } from './db/identity.js'
import { createSession } from './auth/session.js'
import { contextoDesdeEnvelope } from './ipc/contexto.js'
import { handleSecondInstance, planRendererRecovery, runBeforeQuit } from './lifecycle.js'
import { APP_NAME } from './dataDir.js'
import { runPaymentDrive } from './payment-drive.js'
import { runDeudoresDrive } from './deudores-drive.js'
import { runComprasDrive } from './compras-drive.js'
import { runHandoverDrive, runHandoverRestartPhase } from './handover-drive.js'

const isPackaged = app.isPackaged

// PLAT-2: name the Electron profile BEFORE anything reads userData. Unpackaged, Electron
// derives the path from the package name, and an app run via `electron out/main/index.js`
// resolved to the SHARED `…\AppData\Roaming\Electron\` profile — the same directory every
// other Electron app on the machine uses, so two of them collide. This is what makes the
// data land under `…\AppData\Roaming\MiniMarck\` instead. Set from the constant, not from
// package.json, so a rename cannot silently move a user's database.
app.setName(APP_NAME)

// THE LAUNCH PROBE GETS ITS OWN PROFILE. `userData` is the developer's real MiniMarck profile,
// so a probe that boots against it inherits whatever the last run of the real app left behind:
// a shop, its sales, and — since the sign-in feature landed — a CREDENTIAL. The first version of
// the deep-link step died on `Este equipo ya tiene usuarios con contraseña` for exactly that
// reason, and the honest reading was that the probe was not testing a first launch at all.
//
// A fixed subdirectory keyed to the marker env var is the throwaway profile, and it is REMOVED
// first, so every run is a genuine first launch. This is set here, right after `setName`, because
// everything downstream — `app.getPath('userData')` at the bootstrap, the single-instance lock's
// sibling window — reads it, and `setPath` after a read is the exact bug PLAT-2 is about.
if (process.env.MINIMARCK_S0_PROBE) {
  const perfil = path.join(app.getPath('temp'), 'minimarck-s0-probe')
  fs.rmSync(perfil, { recursive: true, force: true })
  app.setPath('userData', perfil)
}

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
 * `identity` is the LOCAL IDENTITY — WHICH BUSINESS this file belongs to. It is resolved ONCE at
 * startup and closed over here, which is the whole reason `installIpc` takes it as an argument
 * rather than reading it per request: a per-request read would be a per-request guess, and the
 * one time the file has two businesses in it is exactly when a guess is worst. With no
 * resolvable business the object carries `negocioId: null` and every business operation answers
 * the existing, already-tested `TENANT_REQUIRED` — a refusal, not a silent default to some other
 * shop's data.
 *
 * WHO IS OPERATING IS NOT IN `identity` ANY MORE, and this is the change that matters.
 *
 * `identity.actorId` used to be a startup snapshot of "the operator this file has", the same
 * person for the whole life of the process. It is now `session.actorId()`: the person who typed
 * their password, read from the main process on EVERY call, so it changes mid-run when the till
 * is handed over. The renderer cannot reach it — `envelope.payload` goes to the handler untouched
 * and is never merged into `ctx`, so a frame that sends `{ user_id: 7 }` has its own key ignored
 * and the sale lands under whoever is actually signed in. `tests/auth/attribution.spec.js` is the
 * test that fails if that merge is ever added.
 */
function installIpc(registry, identity, session) {
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
      // repository must scope by (SEC-6) and they come from the process, not from the renderer: a
      // frame that named its own tenant would be a frame with admin rights.
      //
      // `actorId` is read per call, NOT captured at startup, so a handover takes effect on the
      // next operation. With nobody signed in it is null and every repository that stamps an
      // audit column answers the already-tested `ACTOR_REQUERIDO`: a sale cannot be rung up by
      // nobody.
      const ctx = contextoDesdeEnvelope(identity, session, envelope)
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
/**
 * SPA DEEP LINK, PROVED AT RUNTIME — after the base checks pass.
 *
 * `main.jsx` uses `BrowserRouter`, deliberately, on the argument that `isNavigationRequest()`
 * serves index.html for an extensionless path so `app://bundle/ventas` reaches the app instead
 * of a 404. That argument was, until this step, a comment. Every probe run before this loaded
 * `app://bundle/index.html` and never asked the origin for a route.
 *
 * So the probe navigates for real and asks the resulting page three questions:
 *
 *   NAV-1  Does the deep link LOAD? `did-finish-load` with no `did-fail-load` is the difference
 *          between "the fallback served index.html" and "the fallback 404d and the window is a
 *          Chromium error page that happens to be silent".
 *   NAV-2  Did the ROUTE match, or did the app render its own 404? Only the `/ventas` route
 *          passes `titulo="Ventas"` to the top bar, so the top bar's own text is the assertion.
 *          Asserting the URL alone would pass for an error page.
 *   NAV-3  Is the deep-linked page as safe as the index? The renderer probe is a module, so it
 *          re-runs on the new document and republishes `window.__S0_PROBE__`. Requiring the same
 *          zero outbound attempts and the same four-member bridge on THIS page is what stops
 *          "it rendered" from quietly meaning "it rendered without the preload".
 */
function runDeepLinkProbe(win, baseResult) {
  const deepUrl = 'app://bundle/ventas'
  return new Promise((resolve) => {
    const checks = []
    const record = (label, ok, detail) => {
      checks.push({ label, ok, detail })
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
    }

    // SIGN IN FIRST, THROUGH THE REAL BRIDGE. Since the app opens signed out, a deep link now
    // lands on the sign-in panel for the same reason a fresh launch does: nobody has proved who
    // they are. That is the feature working, so the probe has to sign in before it can ask
    // whether the ROUTE rendered.
    //
    // It goes through `window.minimarck.call`, which is the preload bridge and the real IPC
    // channel — the same three hops a person's keystroke makes. Calling the auth service
    // directly from main would have been easier and would have proved nothing about the window
    // the deep link actually opened.
    const firmarEnLaVentana = async () => {
      let registro = null
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        try {
          registro = await win.webContents.executeJavaScript(`(async () => {
            if (!window.minimarck || typeof window.minimarck.call !== 'function') return { listo: false, motivo: 'no hay puente' };
            const r = await window.minimarck.call('auth', 'register', {
              nombre: 'Dueña del Probeta',
              negocioNombre: 'Tienda de la Probeta',
              nombreAcceso: 'duena',
              password: 'clave-de-probeta'
            });
            return { listo: true, nombre: r && r.nombre, adoptada: r && r.adoptoNegocioExistente };
          })()`)
          if (registro?.listo) return registro
        } catch (err) {
          registro = { listo: false, motivo: String(err && err.message) }
        }
        await new Promise((r) => setTimeout(r, 250))
      }
      return registro || { listo: false, motivo: 'el puente no respondio en 15s' }
    }

    let failedToLoad = null
    const onFail = (_e, code, desc, url) => {
      failedToLoad = `ERR_${code} ${desc} (${url})`
    }
    win.webContents.on('did-fail-load', onFail)
    win.webContents.once('did-finish-load', async () => {
      win.webContents.removeListener('did-fail-load', onFail)
      // Let React mount and the route render before asking the page about itself.
      await new Promise((r) => setTimeout(r, 1200))

      record(
        'NAV-1 deep link app://bundle/ventas loads through the SPA fallback',
        !failedToLoad,
        failedToLoad || `url=${win.webContents.getURL()}`
      )

      let nav2 = { ok: false, detail: 'la pagina no respondio' }
      try {
        const r = await win.webContents.executeJavaScript(`(() => {
          const titulo = document.querySelector('.mm-topbar-title');
          return {
            path: location.pathname,
            titulo: titulo ? titulo.textContent.trim() : null,
            montado: document.getElementById('root').children.length > 0
          };
        })()`)
        nav2 = {
          ok: r.path === '/ventas' && r.titulo === 'Ventas' && r.montado,
          detail: `path=${r.path} titulo=${JSON.stringify(r.titulo)} rootMontado=${r.montado}`
        }
      } catch (err) {
        nav2 = { ok: false, detail: String(err && err.message) }
      }
      record('NAV-2 the /ventas ROUTE rendered, not an error page', nav2.ok, nav2.detail)

      let nav3 = { ok: false, detail: 'el probe no volvio a publicar en la pagina nueva' }
      // The probe is a MODULE, so the new document re-executes it — but its checks are async
      // (it arms a recorder, then sweeps element tags), so reading `window.__S0_PROBE__` once at
      // a fixed delay is a race. Poll it, with a deadline, exactly like the base probe does.
      const navDeadline = Date.now() + 15_000
      let after = null
      while (Date.now() < navDeadline) {
        try {
          after = await win.webContents.executeJavaScript('window.__S0_PROBE__ || null')
        } catch {
          after = null
        }
        if (after) break
        await new Promise((r) => setTimeout(r, 250))
      }
      if (after) {
        const zero = after.results.filter((r) => r.id === 'OFFL-1').every((r) => r.ok)
        const sec = after.results.filter((r) => String(r.id).startsWith('SEC-1')).every((r) => r.ok)
        nav3 = {
          ok: after.failed === 0 && zero && sec,
          detail: `checks=${after.total - after.failed}/${after.total} en app://bundle/ventas (las mismas ${baseResult.total} que en index.html)`
        }
      } else {
        nav3 = { ok: false, detail: 'el probe no volvio a publicar en la pagina nueva en 15s' }
      }
      record('NAV-3 the deep-linked page is as safe offline as the index', nav3.ok, nav3.detail)

      const passed = checks.filter((c) => c.ok).length
      console.log(`=== ${passed}/${checks.length} deep-link checks passed ===`)
      resolve({ ok: passed === checks.length, total: checks.length, passed })
    })

    // Sign in on the page that is already open, THEN navigate. Doing it in this order matters:
    // the credential is created once (register refuses a second owner), and the session lives in
    // main, so the new document only has to ask `auth.me` who it is talking to.
    firmarEnLaVentana()
      .then((sesion) => {
        if (!sesion?.listo) {
          record('NAV-0 the owner signs in through the real bridge before the deep link', false, sesion?.motivo || String(sesion))
          win.webContents.removeListener('did-fail-load', onFail)
          console.log(`=== 0/${checks.length} deep-link checks passed ===`)
          resolve({ ok: false, total: checks.length, passed: 0 })
          return
        }
        record('NAV-0 the owner signs in through the real bridge before the deep link', true, `sesion para ${JSON.stringify(sesion.nombre)}`)
        win.loadURL(deepUrl).catch((err) => {
          win.webContents.removeListener('did-fail-load', onFail)
          record('NAV-1 deep link app://bundle/ventas loads through the SPA fallback', false, String(err))
          console.log(`=== ${checks.filter((c) => c.ok).length}/${checks.length} deep-link checks passed ===`)
          resolve({ ok: false, total: checks.length, passed: checks.filter((c) => c.ok).length })
        })
      })
      .catch((err) => {
        record('NAV-0 the owner signs in through the real bridge before the deep link', false, String(err))
        resolve({ ok: false, total: checks.length, passed: 0 })
      })
  })
}

function runLaunchProbe(win) {
  const deadline = Date.now() + 20_000
  // `settled` exists because the poll below reschedules ITSELF. Every tick that found no result
  // left another tick pending, so the moment the result appeared, N of them printed the same 25
  // lines and N deep-link probes started on the same window. The first run of this probe printed
  // its report five times. One report, one deep link, one exit code.
  let settled = false
  const poll = async () => {
    let result
    try {
      result = await win.webContents.executeJavaScript('window.__S0_PROBE__ || null')
    } catch {
      result = null
    }
    if (result) {
      if (settled) return
      settled = true
      for (const r of result.results) {
        console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? '  — ' + r.detail : ''}`)
      }
      const baseOk = result.failed === 0
      console.log(
        `=== ${result.total - result.failed}/${result.total} launch probe checks passed ===`
      )
      // The base origin is only half the claim. `app://bundle/ventas` is the other half, and it
      // is asked of the SAME window, over the SAME origin, with the SAME preload.
      runDeepLinkProbe(win, result).then((nav) => {
        const ok = baseOk && nav.ok
        console.log(
          `S0 LAUNCH PROBE ${ok ? 'PASSED' : 'FAILED'}: ${nav.passed}/${nav.total} deep-link checks; url=${win.webContents.getURL()}`
        )
        app.exit(ok ? 0 : 1)
      })
      return
    }
    if (Date.now() > deadline) {
      if (settled) return
      settled = true
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

  // WHICH SHOP, AND WHO IS ON THE TILL.
  //
  // `identity` answers "which shop is this file?" — a fact about the FILE, resolved once after
  // the seed, and the tenant every repository scopes by. It no longer answers "who is
  // operating": that is the session, and the session is empty until somebody signs in.
  //
  // The session is created HERE, in the main process, and passed to `installIpc`. It starts
  // empty on every launch, which is the product requirement stated as a fact about the process:
  // nobody is signed in when the app opens. The renderer reloads, the deep link navigates, the
  // window is rebuilt after a crash — the session survives all of them, because none of them
  // restart the process. Restarting the app is what ends a session.
  const identity = resolveLocalIdentity(db.conn)
  const avisoIdentidad = identityWarning(identity)
  if (avisoIdentidad) console.warn(avisoIdentidad)
  else console.log(`[negocio] ${identity.negocioNombre} · abrito, sin sesión (se pide contraseña al entrar)`)

  const session = createSession(db.conn)

  registerAuthHandlers(registry, { conn: db.conn, session })
  registerNegocioHandlers(registry, { conn: db.conn })
  registerProductosHandlers(registry, { conn: db.conn })
  registerCategoriasHandlers(registry, { conn: db.conn })
  registerDeudoresHandlers(registry, { conn: db.conn })
  registerProveedoresHandlers(registry, { conn: db.conn })
  registerComprasHandlers(registry, { conn: db.conn })
  installIpc(registry, identity, session)

  const win = createWindow({ isPackaged, rendererUrl: url })

  // PLAT-5: a crashed renderer is an UNKNOWN outcome, not a failed call. Re-read state, do
  // NOT re-invoke the request that died mid-flight — see lifecycle.js for why replaying it
  // would duplicate a committed sale until S4's idempotency key exists.
  win.webContents.on('render-process-gone', (_e, details) => {
    const plan = planRendererRecovery({ reason: details?.reason, exitCode: details?.exitCode })
    console.error('[lifecycle] renderer gone:', JSON.stringify(plan))
  })

  // The launch probe is a GATE, and a gate runs once. `did-finish-load` is not a once-event
  // here: this window loaded five times on a single probe run, and every one of them re-armed
  // `runLaunchProbe` with its own private `settled` flag — so the same 25 checks printed five
  // times and five deep-link probes queued on one window.
  //
  // The guard lives in `main()`'s scope, not at module level, and that is deliberate: the
  // listener below is created once per window and closes over THIS binding, so every
  // `did-finish-load` shares one flag. `runLaunchProbe` keeps its own `settled` for a different
  // job — that one guards its self-rescheduling poll, which is a per-invocation problem. Two
  // different repeats, two different flags, and neither one is a module-level global that a
  // second window would have to contend for.
  let probeStarted = false
  // Separate from `probeStarted` on purpose: the two drives can both be requested by a reviewer
  // in one run, and one flag would let the second silently reuse the first's single-shot guard.
  let driveStarted = false
  // A third flag for a third one-shot drive, for the same reason: the debtor drive, the payment
  // drive and the launch probe can all be requested in one run and one flag would let the second
  // silently reuse the first's guard.
  let deudoresDriveStarted = false
  // A fourth flag, same reason: the purchase drive joins the other two and the probe, and one flag
  // would let a second drive silently reuse the first's single-shot guard.
  let comprasDriveStarted = false
  let handoverDriveStarted = false
  let handoverRestartStarted = false
  win.webContents.on('did-finish-load', () => {
    installMenu(() => shell.openPath(db.paths.dataDir))
    if (process.env.MINIMARCK_S0_PROBE && !probeStarted) {
      probeStarted = true
      runLaunchProbe(win)
    }
    // The payment drive, same gating story as the probe above: off unless the env var is set, and
    // it drives THIS window - the real one, with the real preload over the real app:// origin.
    // Its `onReady` resolves `{ ok, total, failed }` and the exit code follows.
    // The handover drive: the whole first-launch -> add employee -> handover -> employee sells ->
    // take the till back story, in this window, on real keys. Same gating and same watchdog
    // discipline as the other three.
    if (process.env.MINIMARCK_HANDOVER_DRIVE && !handoverDriveStarted) {
      handoverDriveStarted = true
      const watchdog = setTimeout(() => {
        console.error('HANDOVER_DRIVE_ERROR timeout after 240s — the drive never reached finish()')
        app.exit(1)
      }, 240_000)
      runHandoverDrive(win, db)
        .then((r) => {
          clearTimeout(watchdog)
          console.log(`HANDOVER_DRIVE_PHASE1 ${JSON.stringify(r)}`)
          app.exit(r.ok ? 0 : 1)
        })
        .catch((err) => {
          clearTimeout(watchdog)
          console.error(`HANDOVER_DRIVE_ERROR ${err && err.stack ? err.stack : err}`)
          app.exit(1)
        })
    }
    // PHASE 2, A SECOND PROCESS. The launcher starts the app a second time on the SAME data
    // directory with `MINIMARCK_HANDOVER_RESTART=1`, so this is a real relaunch and not a reload:
    // a fresh OS process, a fresh main process, and therefore no in-memory session to inherit.
    if (process.env.MINIMARCK_HANDOVER_RESTART && !handoverRestartStarted) {
      handoverRestartStarted = true
      const watchdog = setTimeout(() => {
        console.error('HANDOVER_RESTART_ERROR timeout after 120s')
        app.exit(1)
      }, 120_000)
      runHandoverRestartPhase(win, db)
        .then((r) => {
          clearTimeout(watchdog)
          console.log(`HANDOVER_DRIVE_PHASE2 ${JSON.stringify(r)}`)
          app.exit(r.ok ? 0 : 1)
        })
        .catch((err) => {
          clearTimeout(watchdog)
          console.error(`HANDOVER_RESTART_ERROR ${err && err.stack ? err.stack : err}`)
          app.exit(1)
        })
    }
    if (process.env.MINIMARCK_PAYMENT_DRIVE && !driveStarted) {
      driveStarted = true
      // A rejection here would otherwise leave the window open and the process alive with no
      // output, so the drive carries both a catch and a wall-clock watchdog. A driven window that
      // never reaches `finish()` is a failure, not something to wait on forever.
      const watchdog = setTimeout(() => {
        console.error('PAYMENT_DRIVE_ERROR timeout after 120s — the drive never reached finish()')
        app.exit(1)
      }, 120_000)
      runPaymentDrive(win, db)
        .then((r) => {
          clearTimeout(watchdog)
          console.log(`PAYMENT_DRIVE_RESULT ${JSON.stringify(r)}`)
          app.exit(r.ok ? 0 : 1)
        })
        .catch((err) => {
          clearTimeout(watchdog)
          console.error(`PAYMENT_DRIVE_ERROR ${err && err.stack ? err.stack : err}`)
          app.exit(1)
        })
    }
    // The debtor drive: create a customer, bill a credit sale, take a part payment, and read the
    // drawer, the journal and the balance back out of the real file. Same gating, same watchdog
    // discipline as the payment drive above, and it drives THIS window.
    if (process.env.MINIMARCK_DEUDORES_DRIVE && !deudoresDriveStarted) {
      deudoresDriveStarted = true
      const watchdog = setTimeout(() => {
        console.error('DEUDORES_DRIVE_ERROR timeout after 180s — the drive never reached finish()')
        app.exit(1)
      }, 180_000)
      runDeudoresDrive(win, db)
        .then((r) => {
          clearTimeout(watchdog)
          console.log(`DEUDORES_DRIVE_RESULT ${JSON.stringify(r)}`)
          app.exit(r.ok ? 0 : 1)
        })
        .catch((err) => {
          clearTimeout(watchdog)
          console.error(`DEUDORES_DRIVE_ERROR ${err && err.stack ? err.stack : err}`)
          app.exit(1)
        })
    }

    // The supplier and purchase drive: create a supplier, buy a FRACTIONAL quantity in cash, buy
    // again by card and on credit, watch the three methods move three different accounts, cancel
    // one purchase, and prove that a cash purchase CANNOT be cancelled with the till closed without
    // losing the money. Same gating and same watchdog discipline as the two above, and it drives
    // THIS window.
    if (process.env.MINIMARCK_COMPRAS_DRIVE && !comprasDriveStarted) {
      comprasDriveStarted = true
      const watchdog = setTimeout(() => {
        console.error('COMPRAS_DRIVE_ERROR timeout after 240s — the drive never reached finish()')
        app.exit(1)
      }, 240_000)
      runComprasDrive(win, db)
        .then((r) => {
          clearTimeout(watchdog)
          console.log(`COMPRAS_DRIVE_RESULT ${JSON.stringify(r)}`)
          app.exit(r.ok ? 0 : 1)
        })
        .catch((err) => {
          clearTimeout(watchdog)
          console.error(`COMPRAS_DRIVE_ERROR ${err && err.stack ? err.stack : err}`)
          app.exit(1)
        })
    }
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
