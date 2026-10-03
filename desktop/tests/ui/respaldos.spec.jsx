// @vitest-environment jsdom
/**
 * THE BACKUP SCREEN, driven the way the operator who just lost a morning of sales does it.
 *
 * `tests/db/backup.spec.js` proves the five operations are honest: it tampers with an archive and
 * watches `verify` catch it by checksum alone, it restores the safety copy to prove the net
 * catches, and it asserts the WAL rows really are inside the archive. None of that touches
 * `Respaldos.jsx`. This file is the layer where the claims that reach the PERSON are tested, and
 * for this screen that layer is not a formality — `Restaurar` is the only operation in the app with
 * no undo, so the thing that matters is whether the dialog said enough BEFORE the click, and
 * whether the panel afterwards says what actually came back.
 *
 * THE HARNESS is the one `tests/ui/deudores.spec.jsx` established: the real React screen, the real
 * handler registry, a real migrated SQLite file, and a real backup directory on disk. The ONLY seam
 * is the Electron transport — and `escenario` RECORDS every call rather than merely forwarding it,
 * because a claim about what the screen asks main for is a claim about a payload nobody looked at.
 *
 * TWO THINGS ARE DONE DIFFERENTLY HERE, both because this screen needs them:
 *
 *   - `send` IS THE SEAM, NOT A STUB. `backup:progress` is the first event this app emits, so the
 *     transport here implements `on(topic, cb)` and the test can both OBSERVE what main sent
 *     (`eventos`) and DRIVE an event into the renderer (`enviar`). A harness that only forwarded
 *     calls could not tell a screen that renders the event from one that renders a spinner it
 *     invented, and that is exactly the claim this screen makes.
 *   - THERE IS A GATE. `bloquear(op)` holds a call open, which is the only way to test the lock
 *     this screen puts on its own buttons. A backup of a shop-sized database takes SECONDS; an
 *     unchanged button for seconds is a button somebody presses twice, which starts a second copy.
 *     Testing that needs a slow backup, and a fast fixture cannot provide one honestly.
 *
 * EVERY `data-testid` USED BELOW ALREADY EXISTS on the screen. None was added for this file.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastContainer } from 'react-toastify'

import path from 'node:path'
import { copyFileSync, readdirSync, statSync, appendFileSync, readFileSync } from 'node:fs'

import { createRegistry } from '../../src/main/bridge/registry.js'
import { registerBackupHandlers } from '../../src/main/ipc/backup.js'
import { registerVentasHandlers } from '../../src/main/ipc/ventas.js'
import { registerCajasHandlers } from '../../src/main/ipc/cajas.js'
import { crearRespaldo } from '../../src/main/db/backup.js'

import { tienda, ctxDe, insertarProducto, iniciarSesion, abrirCaja } from '../db/fixtures/tienda.js'

import Respaldos, { fechaDeId } from '../../src/renderer/app/pages/Respaldos.jsx'

/**
 * THE PATHS THE BACKUP ENGINE NEEDS, next to the fixture's own database file.
 *
 * `tienda()` opens the connection with the same `-wal` path, so the sidecars this names are the
 * ones the open handle actually has — which matters because `restaurarRespaldo` DELETES them, and
 * deleting a sidecar the connection never had would be a test of nothing.
 */
const rutas = (t) => ({
  dbFile: t.archivo,
  walFile: `${t.archivo}-wal`,
  shmFile: `${t.archivo}-shm`,
  backupDir: path.join(t.dir, 'backups'),
  migrationsDir: path.resolve(process.cwd(), 'src', 'main', 'db', 'migrations')
})

function escenario() {
  const t = tienda()
  const ctx = ctxDe(t, t.negocioId, t.usuarioId)
  const paths = rutas(t)

  const llamadas = []
  /** Every topic MAIN sent, recorded. The claim "main emits progress" is checkable because of this. */
  const eventos = []
  /** topic -> the renderer's live listeners, so a leaked subscription is visible. */
  const suscriptores = new Map()
  /** op -> a promise the test holds open, so a call can be observed mid-flight. */
  const puertas = new Map()

  const enviar = (topic, payload) => {
    eventos.push({ topic, payload })
    for (const cb of suscriptores.get(topic) ?? []) cb(payload)
  }

  const registry = createRegistry()
  const { session: sesion } = iniciarSesion(t)
  registerVentasHandlers(registry, { conn: t.conn })
  registerCajasHandlers(registry, { conn: t.conn })
  registerBackupHandlers(registry, { conn: t.conn, paths, send: enviar })

  globalThis.minimarck = {
    calls: llamadas,
    call: async (group, op, payload) => {
      const handler = registry.resolve(group, op)
      // SHALLOW COPY, for the reason `reportes.spec.jsx` gives: a handler that mutated its own
      // argument would make the recorded payload show the MUTATED version, and the spy would report
      // what the code ended up with rather than what it was given.
      const entrada = { ...(payload ?? {}) }
      // Recorded BEFORE the call, so an operation that was ATTEMPTED and refused is still visible.
      // A backup test that cannot see the refusal is a backup test that cannot prove the refusal.
      const registro = { group, op, payload: entrada, respuesta: null, fallo: null }
      llamadas.push(registro)
      const puerta = puertas.get(op)
      if (puerta) await puerta
      try {
        registro.respuesta = await handler(entrada, ctx)
      } catch (err) {
        registro.fallo = err
        throw err
      }
      return registro.respuesta
    },
    on: (topic, cb) => {
      const lista = suscriptores.get(topic) ?? []
      lista.push(cb)
      suscriptores.set(topic, lista)
      return () => {
        const viva = suscriptores.get(topic) ?? []
        const i = viva.indexOf(cb)
        if (i >= 0) viva.splice(i, 1)
      }
    }
  }

  return {
    t,
    paths,
    llamadas,
    eventos,
    suscriptores,
    sesion,
    enviar,
    /**
     * Hold every call to `op` open until `abrir()` is called. The gate is REMOVED on release, so
     * the reloads that follow an operation are not held hostage by it.
     */
    bloquear: (op) => {
      let abrir
      const promesa = new Promise((r) => {
        abrir = r
      })
      puertas.set(op, promesa)
      return {
        abrir: () => {
          puertas.delete(op)
          abrir()
        }
      }
    }
  }
}

const stores = []
afterEach(() => {
  cleanup()
  delete globalThis.minimarck
  while (stores.length > 0) stores.pop().cerrar()
})

/**
 * `Respaldos` reads no provider — no router, no query client, no session. `<ToastContainer />` is the
 * one piece of the app's tree that is NOT optional here, for the reason `deudores.spec.jsx` states
 * at length: a `toast` call with no container renders NOTHING, no error and no text. Without it this
 * file could not tell "the screen told the operator it was safe to restore" from "the screen threw
 * before it could say so", which is the whole thing a backup screen exists to do.
 */
function montar() {
  return render(
    <>
      <Respaldos />
      <ToastContainer />
    </>
  )
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * The timeout for a wait that is waiting on REAL DISK I/O, as opposed to a state transition.
 *
 * Testing Library's default is 1000ms, which is generous for a React state update and wrong for
 * `node:sqlite`'s online backup: checkpointing a WAL, copying the file and reading it back is real
 * work, and this suite runs alongside 45 other files. Left at the default, two of the tests below
 * passed in isolation and in a 7-file run and then failed in the 46-file run — a test that is green
 * only when the machine is quiet is worse than no test, because it trains you to re-run it.
 *
 * So the split is deliberate: waits on a click or a render keep the 1000ms default and stay sharp,
 * and only the waits that genuinely cross into SQLite and the filesystem get this. It is still a
 * bounded wait, not a sleep: if the operation never completes, the test still fails, just later.
 */
const REAL_IO = { timeout: 10000 }

/**
 * A real sale, through the real operation, so a backup holds a `ventas` count that is not zero.
 *
 * The count is the point. A restore panel that printed `0 venta(s)` for a shop that had sold all
 * morning would satisfy a test written against an empty shop, so every assertion below about the
 * number the panel reports is made against a shop where that number is DIFFERENT from zero AND
 * different from what the file holds after the mutation.
 */
async function vender(t, { nombre, precio = 20000, stock = 9000 } = {}) {
  const producto = insertarProducto(t, {
    negocioId: t.negocioId,
    usuarioId: t.usuarioId,
    overrides: { nombre, precio_centavos: precio, stock_milli: stock }
  })
  await globalThis.minimarck.call('ventas', 'create', {
    items: [{ productoId: producto.id, cantidad: '1' }],
    metodoPago: 'efectivo'
  })
  return producto
}

/** Open the till once, so `ventas.create` has somewhere to put the money. */
const abrirLaCaja = (t) =>
  abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, saldoInicialCentavos: 35000 })

/** `n` real archives, newest last. The sleep is not decoration — see below. */
async function variosRespaldos(t, paths, n, motivo = 'manual') {
  const hechos = []
  for (let i = 0; i < n; i++) {
    hechos.push(await crearRespaldo(t.conn, paths, { motivo }))
    // THE ARCHIVE ID IS A TIMESTAMP WITH MILLISECOND RESOLUTION, so two backups inside the same
    // millisecond would be the SAME FILE, the second silently overwriting the first. A prune test
    // built on that would be testing a fixture bug.
    await dormir(5)
  }
  return hechos
}

const ventasEn = (t) => t.conn.db.prepare('SELECT COUNT(*) AS n FROM ventas').get().n

/**
 * The recorded calls for ONE contract op, scoped by GROUP as well as by op.
 *
 * This exists because `create` is not a unique op name. The helpers above ring up sales through
 * `ventas.create`, and the screen takes a backup through `backup.create` — so a bare
 * `llamadas.find((c) => c.op === 'create')` returns the SALE, and every assertion about the backup
 * silently becomes an assertion about the sale's `{items, metodoPago}` payload. It fails confusingly,
 * and worse, a loose `toContain('create')` passes for the wrong reason. In a 89-operation contract,
 * the pair is the identity and the op alone is not.
 */
const de = (llamadas, group, op) => llamadas.filter((c) => c.group === group && c.op === op)
const una = (llamadas, group, op) => llamadas.find((c) => c.group === group && c.op === op)

/** The archive files really on disk, and the manifests really beside them. */
const enDisco = (paths) => {
  const nombres = readdirSync(paths.backupDir)
  return {
    archivos: nombres.filter((f) => f.endsWith('.db')),
    manifiestos: nombres.filter((f) => f.endsWith('.db.json'))
  }
}

const manifiestoDe = (paths, id) => JSON.parse(readFileSync(path.join(paths.backupDir, `${id}.db.json`), 'utf8'))

/**
 * The archive id as the SCREEN prints it — THE SCREEN'S OWN FUNCTION, imported, not transcribed.
 *
 * This used to be a MIRROR of `Respaldos.jsx`'s `fechaDeId`, justified as "asserting on the screen
 * means asserting on that rewrite". That justification was wrong, and worth spelling out, because
 * the failure it creates is invisible: a mirror is a SECOND implementation, so when the screen's
 * format changed the copy did not, and every date assertion in this file stayed green while the
 * thing the operator reads had changed underneath it. The suite reported on the copy, not on the
 * screen.
 *
 * Importing the real one removes the second implementation, and the rendered-output assertions
 * below keep their value: they still prove the screen derives its label from THIS archive's id
 * rather than from a stale row, a hardcoded string or the raw filename.
 *
 * What importing cannot do on its own is pin the FORMAT, because expected and actual would then be
 * the same call. That gap is closed by `pins the archive-id format the screen prints` further down,
 * which asserts the shape against literal strings. Between the two, the format is pinned AND the
 * screen is compared against one implementation.
 *
 * The load-bearing claims of this file are elsewhere and are unaffected: the row counts, the byte
 * counts and the restore's effect on the FILE are read from disk and from SQLite.
 */

describe('el rótulo de un respaldo', () => {
  it('pins the archive-id format the screen prints', () => {
    // THE OTHER HALF OF REMOVING THE MIRROR. The assertions below compare the screen's rendered text
    // against the screen's own function, which proves the label came from the right archive but
    // says nothing about what that label LOOKS LIKE — if both sides changed together, every one of
    // them would still pass. So the format is pinned here against literal strings, which is the
    // only place in this file where an expected value is written out by hand.
    //
    // The operators of this screen are looking for an archive by the date they took it, so
    // `2026-10-02 14:31:07` is a deliberate, readable shape and not an accident: it matches what
    // `nombreNuevo` writes as a filename, with the `T` and the dashes put back the way a person
    // reads a time.
    expect(fechaDeId('minimarck-2026-10-02T14-31-07-123Z')).toBe('2026-10-02 14:31:07')
    expect(fechaDeId('minimarck-2020-01-02T00-00-00-000Z')).toBe('2020-01-02 00:00:00')
    // Midnits and noon are where an off-by-one in the capture groups would show up, so they are
    // spelled out rather than left to whatever the first example happens to cover.
    expect(fechaDeId('minimarck-2026-12-31T23-59-59-999Z')).toBe('2026-12-31 23:59:59')

    // An id this function does not recognise is returned UNCHANGED rather than turned into
    // `undefined undefined:undefined:undefined`. That matters beyond tidiness: a file somebody
    // copied into the folder by hand is listed by `listarRespaldos` with no manifest, and the row
    // has to show the operator the name they can actually act on.
    expect(fechaDeId('minimarck-2019-01-01T00-00-00-000Z')).toBe('2019-01-01 00:00:00')
    expect(fechaDeId('algo-que-no-es-un-respaldo')).toBe('algo-que-no-es-un-respaldo')
    expect(fechaDeId('')).toBe('')
  })
})

describe('tomar un respaldo', () => {
  let user
  beforeEach(() => {
    user = userEvent.setup()
  })

  it('CREA el archivo, el manifiesto y la fila de la tabla, y los tres son lo mismo', async () => {
    const { t, paths, llamadas } = escenario()
    stores.push(t)
    await abrirLaCaja(t)
    await vender(t, { nombre: 'Queso artesanal' })
    montar()

    await waitFor(() => expect(screen.getByText(/Todavía no hay respaldos/)).toBeTruthy(), REAL_IO)
    await user.click(screen.getByTestId('crear-respaldo'))

    expect(await screen.findByText(/Respaldo creado \(/, {}, REAL_IO)).toBeTruthy()

    // THE THREE THINGS THE CLAIM IS MADE OF, and they are checked against the FILESYSTEM rather than
    // against whatever the handler returned. A screen that listed a row the engine never wrote would
    // pass a test that trusted the return value, and the operator would discover it during a
    // restore, which is the worst moment to discover it.
    const { archivos, manifiestos } = enDisco(paths)
    expect(archivos).toHaveLength(1)
    expect(manifiestos).toHaveLength(1)
    const id = archivos[0].replace(/\.db$/, '')
    const manifiesto = manifiestoDe(paths, id)
    expect(manifiesto.bytes).toBe(statSync(path.join(paths.backupDir, archivos[0])).size)
    expect(manifiesto.checksum).toMatch(/^[0-9a-f]{64}$/)
    // A real migrated shop file, not a plausible-looking blob: 20 business tables plus the ledger.
    expect(manifiesto.tablas).toBeGreaterThanOrEqual(20)
    expect(manifiesto.ventas).toBe(1)

    // And the row on screen is THAT archive, read off its own date and its own origin.
    const fila = await screen.findByTestId(`respaldo-${id}`)
    expect(fila.textContent).toContain(fechaDeId(id))
    expect(fila.textContent).toContain(`v${manifiesto.userVersion}`)
    expect(fila.textContent).toContain('Manual')

    // The operation asked for was the one the screen names. `manual` is what a person pressing
    // this button means, and it is what a later reader of the folder will act on — so the lookup is
    // `backup.create`, not the first `create` in the log, which is a sale.
    expect(de(llamadas, 'backup', 'create')).toHaveLength(1)
    expect(una(llamadas, 'backup', 'create').payload).toEqual({ motivo: 'manual', nota: null })
  })

  it('REFUSA un segundo respaldo mientras el primero corre, y el botón lo dice', async () => {
    const { t, paths, llamadas, eventos, bloquear } = escenario()
    stores.push(t)
    await abrirLaCaja(t)
    const hechos = await variosRespaldos(t, paths, 1)
    montar()

    await waitFor(() => expect(screen.getByTestId(`respaldo-${hechos[0].id}`)).toBeTruthy(), REAL_IO)
    const antes = enDisco(paths).archivos.length

    const puerta = bloquear('create')
    await user.click(screen.getByTestId('crear-respaldo'))

    // THE LOCK, while the copy is genuinely in flight. Without it, pressing the button twice starts
    // a second SQLite copy — the exact reflex the progress line exists to defeat — and the screen
    // would be defending nothing.
    await waitFor(() => expect(screen.getByTestId('crear-respaldo').disabled).toBe(true))
    expect(screen.getByTestId('crear-respaldo').textContent).toContain('Respaldando')
    expect(screen.getByTestId('podar-respaldos').disabled).toBe(true)
    expect(screen.getByTestId(`restaurar-${hechos[0].id}`).disabled).toBe(true)
    expect(screen.getByTestId(`verificar-${hechos[0].id}`).disabled).toBe(true)

    puerta.abrir()

    // And the copy really was made — the gate held the CALL, it did not fake the operation. This wait
    // covers a real backup AND the list reload that follows it, so it is the one in this file with the
    // longest chain of disk work behind it.
    await waitFor(() => expect(screen.getByTestId('crear-respaldo').disabled).toBe(false), REAL_IO)
    expect(enDisco(paths).archivos).toHaveLength(antes + 1)
    expect(de(llamadas, 'backup', 'create')).toHaveLength(1)

    // THE EVENT, sent by MAIN and not by the screen. `backup:progress` is the first event this app
    // emits, so a harness that only stubbed the call path could never prove it.
    const fases = eventos.filter((e) => e.topic === 'backup:progress').map((e) => e.payload.fase)
    expect(fases).toContain('iniciando')
    expect(fases).toContain('listo')
  })

  it('MUESTRA la línea de progreso que manda el evento, y la borra cuando la fase termina', async () => {
    const { t, enviar, suscriptores } = escenario()
    stores.push(t)
    montar()

    // Subscribed on mount, on the real topic. `backupAPI.alProgresar` returns a no-op when there is
    // no bridge, so "there is a line on screen" proves nothing unless the subscription is real.
    await waitFor(() => expect((suscriptores.get('backup:progress') ?? []).length).toBe(1))

    act(() => enviar('backup:progress', { fase: 'iniciando' }))
    const linea = await screen.findByTestId('progreso-respaldo')
    expect(linea.textContent).toContain('Preparando el respaldo')

    // A phase the screen does not know is shown VERBATIM rather than swallowed, because a new phase
    // added in main must not render as an empty card.
    act(() => enviar('backup:progress', { fase: 'algo-nuevo' }))
    expect(screen.getByTestId('progreso-respaldo').textContent).toContain('algo-nuevo')

    act(() => enviar('backup:progress', { fase: 'listo' }))
    expect(screen.getByTestId('progreso-respaldo').textContent).toContain('Respaldo terminado')

    // AND IT CLEARS ITSELF. A line that still says "Respaldo terminado" three seconds later reads
    // as "still working", and the operator presses the button again.
    await waitFor(() => expect(screen.queryByTestId('progreso-respaldo')).toBeNull(), { timeout: 6000 })
  })

  it('NO deja el oyente colgado cuando la pantalla se desmonta', async () => {
    const { t, suscriptores } = escenario()
    stores.push(t)
    const { unmount } = montar()

    await waitFor(() => expect((suscriptores.get('backup:progress') ?? []).length).toBe(1))
    unmount()

    // `main` outlives every window in the app. A listener left behind on `backup:progress` would
    // keep calling `setState` on an unmounted tree for the rest of the process's life.
    expect(suscriptores.get('backup:progress') ?? []).toHaveLength(0)
  })
})

describe('verificar un respaldo', () => {
  let user
  beforeEach(() => {
    user = userEvent.setup()
  })

  it('VERIFICA un archivo sano y dice qué encontró adentro', async () => {
    const { t, paths, llamadas } = escenario()
    stores.push(t)
    await abrirLaCaja(t)
    await vender(t, { nombre: 'Queso artesanal' })
    const [fila] = await variosRespaldos(t, paths, 1)
    montar()

    await waitFor(() => expect(screen.getByTestId(`respaldo-${fila.id}`)).toBeTruthy(), REAL_IO)
    await user.click(screen.getByTestId(`verificar-${fila.id}`))

    // THE NUMBER IS THE ARCHIVE'S, NOT THE SCREEN'S. It is read back out of the copied file, so a
    // report that echoed the live database — which also has one sale here, and would go on saying so
    // after the shop kept selling — would have to be wrong in the other direction to pass.
    expect(
      await screen.findByText(
        `"${fechaDeId(fila.id)}" está sano: 1 venta(s), esquema v${t.conn.userVersion()}`,
        {},
        REAL_IO
      )
    ).toBeTruthy()
    expect(de(llamadas, 'backup', 'verify')).toHaveLength(1)
    expect(una(llamadas, 'backup', 'verify').payload.id).toBe(fila.id)
  })

  it('lista un archivo traído a mano como "sin manifiesto", y lo deja restaurar igual', async () => {
    const { t, paths } = escenario()
    stores.push(t)
    await abrirLaCaja(t)
    await vender(t, { nombre: 'Queso artesanal' })
    const [fila] = await variosRespaldos(t, paths, 1)

    // THE SCENARIO THE ROW WAS WRITTEN FOR. Somebody restoring a machine copies a `.db` into the
    // folder by hand. There is no manifest beside it, so nothing is known about it — and the row has
    // to SAY that instead of inventing a date or a checksum.
    const prestado = 'minimarck-2026-01-02T09-00-00-000Z'
    copyFileSync(path.join(paths.backupDir, fila.archivo), path.join(paths.backupDir, `${prestado}.db`))
    montar()

    const row = await screen.findByTestId(`respaldo-${prestado}`, {}, REAL_IO)
    expect(within(row).getByText('sin manifiesto')).toBeTruthy()
    expect(within(row).getByText('Sin verificar')).toBeTruthy()
    // The columns nobody recorded are DASHES, not zeros and not blanks. A blank in those columns
    // reads as "zero sales"; a dash reads as "we do not know", which is the truth.
    expect(row.textContent).toContain('—')

    // And it is not merely listed: `Verificar` re-derives everything from the file, so the question
    // the row poses gets an answer instead of staying a question forever.
    await user.click(screen.getByTestId(`verificar-${prestado}`))
    expect(
      await screen.findByText(
        `"${fechaDeId(prestado)}" está sano: 1 venta(s), esquema v${t.conn.userVersion()}`,
        {},
        REAL_IO
      )
    ).toBeTruthy()
  })

  it('DETECTA un archivo alterado, y lo dice en la misma frase que dice que NO sirve', async () => {
    const { t, paths } = escenario()
    stores.push(t)
    const [fila] = await variosRespaldos(t, paths, 1)

    // Appended bytes: the archive keeps its size recorded in the manifest and loses the match. This
    // is what a truncated copy off a pendrive looks like, and it is caught by the checksum alone,
    // without SQLite ever being opened.
    appendFileSync(path.join(paths.backupDir, fila.archivo), 'basura')
    montar()

    const row = await screen.findByTestId(`respaldo-${fila.id}`)
    // The LIST already knows, from re-reading the size on disk: a manifest that says 400 KB over a
    // file that is now 2 KB is exactly the corruption this screen exists to make visible. So the
    // state is "Alterado", not a red mark invented on a file that may restore perfectly.
    expect(within(row).getByText('Alterado')).toBeTruthy()

    await user.click(screen.getByTestId(`verificar-${fila.id}`))

    const error = await screen.findByText(/NO sirve para restaurar/, {}, REAL_IO)
    expect(error.textContent).toMatch(/cambió desde que se creó/)
    // The refusal carries a REASON. "No sirve" on its own tells an operator nothing they can act on,
    // and the action here is not guessable: the archive is damaged, not the app.
    expect(screen.queryByText(/está sano/)).toBeNull()
  })
})

describe('restaurar un respaldo', () => {
  let user
  beforeEach(() => {
    user = userEvent.setup()
  })

  it('RESTAURA de punta a punta, y el panel dice en números lo que volvió', async () => {
    const { t, paths, llamadas } = escenario()
    stores.push(t)
    await abrirLaCaja(t)

    // 1 SALE, then the archive. 2 SALES, then the restore. The number the panel reports is 1, and
    // the live file says 2 right up until the restore lands — so `1`, `2` and `0` are all different
    // answers, and a panel echoing any source other than the archive fails.
    await vender(t, { nombre: 'Queso artesanal' })
    const [fila] = await variosRespaldos(t, paths, 1)
    await vender(t, { nombre: 'Gaseosa 2L', precio: 5000 })
    expect(ventasEn(t)).toBe(2)
    const antesDeRestaurar = ventasEn(t)

    montar()
    await waitFor(() => expect(screen.getByTestId(`respaldo-${fila.id}`)).toBeTruthy(), REAL_IO)
    await user.click(screen.getByTestId(`restaurar-${fila.id}`))
    await user.click(await screen.findByTestId('confirmar-restaurar'))

    // ── WHAT CAME BACK, read off the FILE and off the REOPENED CONNECTION ────────────────────────
    expect(ventasEn(t)).toBe(1)
    expect(antesDeRestaurar).toBe(2)
    expect(una(llamadas, 'backup', 'restore').payload.id).toBe(fila.id)

    // ── AND WHAT THE OPERATOR IS TOLD, which is the claim that reaches a human ────────────────────
    const resumen = await screen.findByText(/La base volvió al estado del/, { selector: 'p' }, { timeout: 6000 })
    expect(resumen.textContent).toContain('1 venta(s)')
    expect(resumen.textContent).toContain(`esquema v${t.conn.userVersion()}`)
    expect(resumen.textContent).toContain(fechaDeId(fila.id))

    // ── THE SAFETY BACKUP, and it is not just a sentence on screen ───────────────────────────────
    // `restaurado.seguridad` is the id of the automatic copy of the state that was replaced, and
    // restoring THAT is the undo. It is located on DISK by its own manifest note, not read back out
    // of the value the screen was handed.
    const { archivos, manifiestos } = enDisco(paths)
    const seguridad = archivos
      .map((f) => f.replace(/\.db$/, ''))
      .map((id) => manifiestoDe(paths, id))
      .find((m) => m.motivo === 'antes-de-restaurar')
    expect(seguridad).toBeTruthy()
    expect(seguridad.nota).toContain(fila.id)
    expect(archivos).toHaveLength(2)
    expect(manifiestos).toHaveLength(2)

    const aviso = screen.getByText(/Antes de tocar nada se guardó el estado anterior como/, { selector: 'p' })
    expect(aviso.textContent).toContain(fechaDeId(seguridad.id))
  })

  it('DICE "Recargá la ventana", y avisa que puede haber que entrar de nuevo', async () => {
    const { t, paths } = escenario()
    stores.push(t)
    await abrirLaCaja(t)
    await vender(t, { nombre: 'Queso artesanal' })
    const [fila] = await variosRespaldos(t, paths, 1)
    montar()

    await waitFor(() => expect(screen.getByTestId(`respaldo-${fila.id}`)).toBeTruthy(), REAL_IO)
    await user.click(screen.getByTestId(`restaurar-${fila.id}`))
    await user.click(await screen.findByTestId('confirmar-restaurar'))

    // THIS PARAGRAPH IS THE WHOLE POINT OF NOT CALLING IT A TOAST. The database under every other
    // screen was just replaced, so the window is still drawing rows it read before the file changed;
    // it must be told to reload DELIBERATELY, when the operator has read the number.
    //
    // The emphasis is on the IMPERATIVE, so the matcher is scoped to the `<strong>` and then the
    // PARAGRAPH is taken as a whole. Read as `p` directly, the text never matches: `getNodeText`
    // joins only the node's own text children, and here they are "Recargá la ventana" inside the
    // strong, "(Ctrl+R) o cerrá…" beside it, and the rest in two more fragments.
    const recarga = (await screen.findByText('Recargá la ventana', { selector: 'strong' }, { timeout: 6000 })).closest('p')
    expect(recarga.textContent).toMatch(/Ctrl\+R/)
    // And the part that would be easy to omit, and is the one that is true: the session is an
    // in-memory `activo` in MAIN that a restore does not touch, so a reload can land the operator
    // back at the sign-in panel when the archive predates their user. See DIVERGENCES entry 23.
    expect(recarga.textContent).toMatch(/entrar de nuevo/)

    // "Entendido" dismisses the panel WITHOUT reloading, which is the operator choosing to keep
    // reading. Reloading is their call, so the screen offers it and does not perform it.
    await user.click(screen.getByText('Entendido'))
    expect(screen.queryByTestId('confirmar-restaurar')).toBeNull()
    expect(screen.queryByText(/La base volvió al estado del/)).toBeNull()
  })

  it('LA CONFIRMACIÓN no es un sí/no: dice qué se pierde, cuál respaldo, y cómo volver atrás', async () => {
    const { t, paths, llamadas } = escenario()
    stores.push(t)
    await abrirLaCaja(t)
    await vender(t, { nombre: 'Queso artesanal' })
    const [fila] = await variosRespaldos(t, paths, 1)
    montar()

    await waitFor(() => expect(screen.getByTestId(`respaldo-${fila.id}`)).toBeTruthy(), REAL_IO)
    await user.click(screen.getByTestId(`restaurar-${fila.id}`))
    await screen.findByTestId('confirmar-restaurar')

    // Restoring the wrong archive is the only operation in the app with NO undo, so the dialog is
    // not a yes/no. Each of these four sentences is one thing a person needs before clicking:
    expect(screen.getByText('Se va a reemplazar la base actual entera')).toBeTruthy()
    // It NAMES the archive, so nobody confirms a filename they did not read. `selector: 'strong'`
    // because the same date is also in the table's first column, and a loose matcher would pass on
    // the row instead of the dialog.
    expect(screen.getByText(fechaDeId(fila.id), { selector: 'strong' })).toBeTruthy()
    expect(screen.getByText(/Todo lo que se cargó/).textContent).toMatch(/después/)
    expect(screen.getByText('copia automática del estado actual')).toBeTruthy()

    // Nothing ran yet. A dialog that restored as a side effect of opening would make every one of
    // those sentences theatre.
    expect(de(llamadas, 'backup', 'restore')).toHaveLength(0)
  })

  it('CANCELAR no restaura nada, y la base sigue como estaba', async () => {
    const { t, paths, llamadas } = escenario()
    stores.push(t)
    await abrirLaCaja(t)
    await vender(t, { nombre: 'Queso artesanal' })
    const [fila] = await variosRespaldos(t, paths, 1)
    await vender(t, { nombre: 'Gaseosa 2L', precio: 5000 })
    montar()

    await waitFor(() => expect(screen.getByTestId(`respaldo-${fila.id}`)).toBeTruthy(), REAL_IO)
    await user.click(screen.getByTestId(`restaurar-${fila.id}`))
    // The dialog opened on the archive that was asked for, so the Cancel below is a decision ABOUT
    // that archive rather than a click on some other modal that happened to be up.
    await screen.findByTestId('confirmar-restaurar')
    expect(screen.getByText(fechaDeId(fila.id), { selector: 'strong' })).toBeTruthy()
    await user.click(screen.getByText('Cancelar'))

    expect(screen.queryByTestId('confirmar-restaurar')).toBeNull()
    expect(de(llamadas, 'backup', 'restore')).toHaveLength(0)
    expect(ventasEn(t)).toBe(2)
    // And no safety copy was taken, because the operation never started. A "cancel" that leaves an
    // archive behind is a restore that happened halfway.
    expect(enDisco(paths).archivos).toHaveLength(1)
  })

  it('AVISA que un respaldo sin verificar se verifica antes de restaurar', async () => {
    const { t, paths } = escenario()
    stores.push(t)
    await abrirLaCaja(t)
    await vender(t, { nombre: 'Queso artesanal' })
    const [fila] = await variosRespaldos(t, paths, 1)
    const prestado = 'minimarck-2026-01-02T09-00-00-000Z'
    copyFileSync(path.join(paths.backupDir, fila.archivo), path.join(paths.backupDir, `${prestado}.db`))
    montar()

    await waitFor(() => expect(screen.getByTestId(`respaldo-${prestado}`)).toBeTruthy())
    await user.click(screen.getByTestId(`restaurar-${fila.id}`))

    // The verified archive carries NO warning, and that absence is as much a claim as its presence:
    // a warning on every restore would train the operator to stop reading it.
    expect(screen.queryByText(/no está verificado todavía/)).toBeNull()

    await user.click(screen.getByText('Cancelar'))
    await user.click(screen.getByTestId(`restaurar-${prestado}`))
    const aviso = await screen.findByText(/Este respaldo no está verificado todavía/, { selector: 'p' })
    // It says what will happen AND what happens if the check fails: nothing is touched.
    expect(aviso.textContent).toMatch(/si no sirve no se toca nada/)
  })

  it('REFUSA un respaldo que no es una base válida, y no toca la que está abierta', async () => {
    const { t, paths, llamadas } = escenario()
    stores.push(t)
    await abrirLaCaja(t)
    await vender(t, { nombre: 'Queso artesanal' })
    const [fila] = await variosRespaldos(t, paths, 1)
    await vender(t, { nombre: 'Gaseosa 2L', precio: 5000 })
    appendFileSync(path.join(paths.backupDir, fila.archivo), 'basura')
    montar()

    await waitFor(() => expect(screen.getByTestId(`respaldo-${fila.id}`)).toBeTruthy(), REAL_IO)
    await user.click(screen.getByTestId(`restaurar-${fila.id}`))
    await user.click(await screen.findByTestId('confirmar-restaurar'))

    // THE ATTEMPT WAS MADE AND REFUSED. Asserting only "no panel appeared" would be satisfied by a
    // screen that silently swallowed the click, which is the failure this whole file exists to rule
    // out.
    const intento = una(llamadas, 'backup', 'restore')
    expect(intento).toBeTruthy()
    expect(intento.fallo).toBeTruthy()
    expect(await screen.findByText(/no es una base válida para esta versión/, {}, REAL_IO)).toBeTruthy()

    // Nothing was replaced: the sales are still the two that were rung up, the open file is intact,
    // and no safety copy was taken, because the refusal happens BEFORE the copy.
    expect(ventasEn(t)).toBe(2)
    expect(screen.queryByText(/La base volvió al estado del/)).toBeNull()
    expect(screen.queryByTestId('confirmar-restaurar')).toBeNull()
    expect(enDisco(paths).archivos).toHaveLength(1)
  })
})

describe('limpiar respaldos viejos', () => {
  let user
  beforeEach(() => {
    user = userEvent.setup()
  })

  it('PODA conservando los más nuevos, y el directorio queda de acuerdo', async () => {
    const { t, paths, llamadas } = escenario()
    stores.push(t)
    const hechos = await variosRespaldos(t, paths, 4)
    montar()

    await waitFor(() => expect(screen.getByTestId(`respaldo-${hechos[3].id}`)).toBeTruthy(), REAL_IO)
    expect(screen.getAllByTestId(/^respaldo-/)).toHaveLength(4)

    await user.click(screen.getByTestId('podar-respaldos'))
    const campo = await screen.findByLabelText('Cuántos conservar')
    await user.clear(campo)
    await user.type(campo, '2')

    // The count is shown BEFORE the click, and it is arithmetic, not a promise.
    expect(screen.getByText(/Se van a borrar 2\./).textContent).toContain('Hay 4 respaldo(s)')

    await user.click(screen.getByTestId('confirmar-podar'))

    expect(await screen.findByText(/Se eliminaron 2 respaldo\(s\)/, {}, REAL_IO)).toBeTruthy()
    expect(una(llamadas, 'backup', 'prune').payload.conservar).toBe('2')

    // THE DIRECTORY, NOT THE TOAST. "Keep the newest N" is only true if the right files went, and
    // the newest two are identified by their ids rather than by "two files remain".
    const { archivos, manifiestos } = enDisco(paths)
    const ids = archivos.map((f) => f.replace(/\.db$/, '')).sort()
    expect(ids).toHaveLength(2)
    expect(ids).toContain(hechos[3].id)
    expect(ids).toContain(hechos[2].id)
    // The manifest goes WITH the archive, never alone: a manifest with no archive is a catalog
    // entry for a file that does not exist, which is worse than neither.
    expect(manifiestos).toHaveLength(2)
  })

  it('REFUSA el botón de limpiar cuando no hay nada que limpiar', async () => {
    const { t, llamadas } = escenario()
    stores.push(t)
    montar()

    await waitFor(() => expect(screen.getByText(/Todavía no hay respaldos/)).toBeTruthy(), REAL_IO)
    expect(screen.getByTestId('podar-respaldos').disabled).toBe(true)
    // Creating one is still offered, because an empty folder is the state where a backup matters most.
    expect(screen.getByTestId('crear-respaldo').disabled).toBe(false)
    expect(de(llamadas, 'backup', 'prune')).toHaveLength(0)
  })

  it('REFUSA confirmar una poda que no borraría nada', async () => {
    const { t, paths, llamadas } = escenario()
    stores.push(t)
    await variosRespaldos(t, paths, 2)
    montar()

    await waitFor(() => expect(screen.getAllByTestId(/^respaldo-/)).toHaveLength(2), REAL_IO)
    await user.click(screen.getByTestId('podar-respaldos'))

    // The default is 10, so with two archives on disk the honest answer is "nothing to delete".
    // Offering a live "Sí, limpiar" there would invite an operator to press it for no reason.
    const confirmar = await screen.findByTestId('confirmar-podar')
    expect(confirmar.disabled).toBe(true)
    expect(screen.getByText(/Se van a borrar 0\./)).toBeTruthy()

    await user.clear(screen.getByLabelText('Cuántos conservar'))
    await user.type(screen.getByLabelText('Cuántos conservar'), '1')
    expect(confirmar.disabled).toBe(false)

    await user.click(confirmar)
    expect(await screen.findByText(/Se eliminaron 1 respaldo\(s\)/, {}, REAL_IO)).toBeTruthy()
    expect(de(llamadas, 'backup', 'prune')).toHaveLength(1)
    expect(enDisco(paths).archivos).toHaveLength(1)
  })
})