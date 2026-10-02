import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  exposed,
  registerMainHandler,
  resetMainHandlers,
  setSenderFrameUrl
} from '../stubs/electron.js'
import { createRegistry } from '../../src/main/bridge/registry.js'
import { toIpcError } from '../../src/main/bridge/errors.js'
import { assertTrustedSender } from '../../src/main/security.js'
import { CHANNEL, ENVELOPE_VERSION } from '../../src/shared/ipc-contract.js'
import { bootstrapDatabase } from '../../src/main/db/bootstrap.js'
import { resolveLocalIdentity } from '../../src/main/db/identity.js'
import { registerDbHandlers } from '../../src/main/ipc/db.js'
import { registerVentasHandlers } from '../../src/main/ipc/ventas.js'
import { registerCajasHandlers } from '../../src/main/ipc/cajas.js'
import { registerAuthHandlers } from '../../src/main/ipc/auth.js'
import { registerNegocioHandlers } from '../../src/main/ipc/negocio.js'
import { registerProductosHandlers } from '../../src/main/ipc/productos.js'
import { registerCategoriasHandlers } from '../../src/main/ipc/categorias.js'
import { registerDeudoresHandlers } from '../../src/main/ipc/deudores.js'
import { CATALOGO_DEMO, demoToProductoInput } from '../../src/shared/demo-catalogo.js'

/**
 * The demo button's path, driven end to end. Renderer -> preload -> main -> SQLite.
 *
 * WHY THIS FILE EXISTS. `src/renderer/app/pages/puntoDeVenta.jsx#sembrarCatalogoDemo` is the
 * only way a shop owner with an empty till can get started, and it was the one piece of this
 * slice with NO test at all — the repo has no renderer tests. Meanwhile `verify:installed` seeds
 * through `npm run db:demo`, which calls `productos.crear(ctx, ...)` DIRECTLY in the main
 * process. So the installed E2E proved the repository works and the button was unproven: two
 * different paths, and only the convenient one was ever exercised. A `productos.create` that
 * 501'd, or a preload channel that drifted from main's, or a mapper that sent the wrong units,
 * would all have passed every gate in this slice and left the button dead on a real first run.
 *
 * That is the same trap `tests/ipc/registry.spec.js` records about its own S0 version ("passed
 * for two slices while never exercising the composition that actually runs at startup"), one
 * layer out. This file is the composition.
 *
 * WHAT IS REAL HERE, and what is not, stated plainly because the distinction is the whole value:
 *
 *   REAL: the renderer's `api/*.js` modules, the real preload and its envelope, the real
 *   registry and its allowlist, all eight real handler groups, the real local-identity
 *   resolution, the real `assertTrustedSender`, the real `toIpcError`, a real migrated SQLite
 *   file, and the real `productos` repository. The only thing replaced is Electron's
 *   `ipcMain.handle`/`ipcRenderer.invoke` pair, which the stub routes by channel.
 *
 *   NOT REAL: that the registration actually happens at app boot, and the Electron-specific
 *   `envelope.v`/sender plumbing is wired to the same `CHANNEL` string (asserted below, since a
 *   channel rename on either side is the classic silent total failure).
 *
 * The dispatcher below is `installIpc`'s body transcribed from `src/main/index.js:61-92`, with
 * its real imports. It is transcribed rather than imported because `installIpc` lives in
 * `index.js`, which imports `electron` at line 1 and boots the app on import — so the production
 * wiring cannot be reached from a test at all. That is a real limitation, not a footnote: if
 * someone later moves `installIpc` into a module, this transcription should be deleted in favour
 * of importing it.
 */

let base
let db
let bridge

/** The real composition, assembled in the same order as `src/main/index.js:280-320`. */
function buildRealComposition() {
  const registry = createRegistry()
  registerDbHandlers(registry, db)
  registerVentasHandlers(registry, { conn: db.conn })
  registerCajasHandlers(registry, { conn: db.conn })
  const identity = resolveLocalIdentity(db.conn)
  registerAuthHandlers(registry, { conn: db.conn })
  registerNegocioHandlers(registry, { conn: db.conn })
  registerProductosHandlers(registry, { conn: db.conn })
  registerCategoriasHandlers(registry, { conn: db.conn })
  registerDeudoresHandlers(registry, { conn: db.conn })
  return { registry, identity }
}

/** `installIpc`'s body. Transcribed from `src/main/index.js:61-92`; see the header. */
function installIpcBody(registry, identity, isPackaged) {
  return async (event, envelope) => {
    try {
      if (!envelope || envelope.v !== ENVELOPE_VERSION) {
        const e = new Error('bad envelope version')
        e.code = 'BAD_VERSION'
        e.status = 400
        throw e
      }
      assertTrustedSender(event.senderFrame?.url, isPackaged)
      const handler = registry.resolve(envelope.group, envelope.op)
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
  }
}

beforeEach(async () => {
  exposed.length = 0
  resetMainHandlers()
  // A PACKAGED build: `app://bundle` is the only trusted origin, which is the configuration the
  // shipped installer runs in and therefore the one worth testing.
  setSenderFrameUrl('app://bundle/index.html')
  base = mkdtempSync(join(tmpdir(), 'mm-integration-'))
  db = bootstrapDatabase({ userDataPath: base, env: {}, tables: [] })
  const mod = await import('../../src/preload/index.js?fresh=' + Math.random())
  expect(mod).toBeDefined()
  bridge = exposed[exposed.length - 1].value
  const { registry, identity } = buildRealComposition()
  registerMainHandler(CHANNEL, installIpcBody(registry, identity, true))
})

afterEach(() => {
  db.conn.checkpointAndClose()
  rmSync(base, { recursive: true, force: true })
  resetMainHandlers()
})

/** The renderer's transport, imported for real, with the real bridge behind it. */
async function rendererApi() {
  globalThis.minimarck = bridge
  return import('../../src/renderer/app/api/productos.js')
}

/** The rows, read from SQLite with no repository in between. */
function rows(sql, ...params) {
  return db.conn.db.prepare(sql).all(...params)
}

describe('preload and main agree on one channel', () => {
  it('the renderer cannot reach a handler on any other channel', async () => {
    // A channel rename on EITHER side breaks every call in the app with no compile error and no
    // test failure, because both sides are strings that agree only at runtime. Asserted here
    // because the stub routes by channel: if these two constants ever diverged, this whole file
    // would fail to find a handler, loudly.
    const { ipcRenderer } = await import('../stubs/electron.js')
    expect(CHANNEL).toBe('minimarck:v1')
    await expect(ipcRenderer.invoke('minimarck:v2', {})).rejects.toThrow(/No handler registered/)
  })
})

describe('the demo catalogue, as the button creates it', () => {
  it('puts all six products in a real database through the real handler', async () => {
    const { productosAPI } = await rendererApi()

    // Exactly the loop in `sembrarCatalogoDemo`.
    for (const p of CATALOGO_DEMO) {
      await productosAPI.crear(demoToProductoInput(p))
    }

    const creados = rows('SELECT * FROM productos ORDER BY id')
    expect(creados).toHaveLength(CATALOGO_DEMO.length)
    for (const esperado of CATALOGO_DEMO) {
      const fila = creados.find((f) => f.nombre === esperado.nombre)
      expect(fila, esperado.nombre).toBeDefined()
      expect(fila.activo).toBe(1)
    }
  })

  it('the prices the UI shows are the cents the database stores', async () => {
    // The renderer's api doc says prices go out in PESOS and the repository parses them. This is
    // the assertion that the demo's `precio` (a decimal) survives that parse exactly — the one
    // place in this path where a float could quietly become a wrong centavo.
    const { productosAPI } = await rendererApi()
    for (const p of CATALOGO_DEMO) await productosAPI.crear(demoToProductoInput(p))

    const aceite = rows('SELECT precio_centavos, precio_compra_centavos FROM productos WHERE nombre = ?', 'Aceite 900 ml')[0]
    expect(aceite.precio_centavos).toBe(240000)
    expect(aceite.precio_compra_centavos).toBe(190000)

    // And the weighed product: thousandths, not a float. 12 kg of queso.
    const queso = rows('SELECT stock_milli, stock_minimo_milli, es_pesable FROM productos WHERE nombre = ?', 'Queso artesanal')[0]
    expect(queso.stock_milli).toBe(12000)
    expect(queso.stock_minimo_milli).toBe(1000)
    expect(queso.es_pesable).toBe(1)
  })

  it('the POS grid query returns what the button just created', async () => {
    // The read side of the same screen. A create that succeeds while `listar` cannot see the row
    // is the failure mode a shop owner sees as "I clicked it and nothing happened".
    const { productosAPI } = await rendererApi()
    for (const p of CATALOGO_DEMO) await productosAPI.crear(demoToProductoInput(p))

    // `listar` returns `{filas, total}` — the grid reads both.
    const grid = await productosAPI.listar()
    expect(grid.total).toBe(CATALOGO_DEMO.length)
    expect(grid.filas).toHaveLength(CATALOGO_DEMO.length)
    expect(grid.filas.map((p) => p.nombre).sort()).toEqual(CATALOGO_DEMO.map((p) => p.nombre).sort())
  })

  it('running the button twice refuses the second run instead of duplicating the shelf', async () => {
    const { productosAPI } = await rendererApi()
    for (const p of CATALOGO_DEMO) await productosAPI.crear(demoToProductoInput(p))
    expect(rows('SELECT * FROM productos')).toHaveLength(6)

    // Same barcode, same shop: refused by name. This is the validation running for real through
    // the bridge, not a hand-built stub of it — the message is the repository's own.
    await expect(productosAPI.crear(demoToProductoInput(CATALOGO_DEMO[0]))).rejects.toThrow(/ya existe/)
    expect(rows('SELECT * FROM productos')).toHaveLength(6)
  })
})

describe('the renderer cannot choose its own tenant (SEC-6)', () => {
  it('ignores a negocioId in the payload and uses the local identity', async () => {
    const { productosAPI } = await rendererApi()
    const { negocio_id: realTenant } = rows('SELECT id AS negocio_id FROM negocios LIMIT 1')[0]

    await productosAPI.crear({
      ...demoToProductoInput(CATALOGO_DEMO[0]),
      negocioId: 999999,
      userId: 999999
    })

    const fila = rows('SELECT negocio_id, user_id FROM productos LIMIT 1')[0]
    // The frame asked for shop 999999. It got the shop this file belongs to.
    expect(fila.negocio_id).toBe(realTenant)
    expect(fila.user_id).not.toBe(999999)
  })
})

describe('the gates in front of business code still hold over this path', () => {
  it('refuses a frame that is not the bundle (SEC-4)', async () => {
    const { productosAPI } = await rendererApi()
    setSenderFrameUrl('https://evil.example/app')
    await expect(productosAPI.listar()).rejects.toThrow(/Untrusted IPC sender/i)
  })

  it('answers 501 for a contract member with no handler, rather than crashing', async () => {
    // `backup.create` is in the frozen contract with no handler in this build — the `backup.*`
    // group is the last one still 501, and this test is the canary for that group's wiring. It
    // used to name `productos.update`, which was true until the CRUD batch gave that member a
    // handler and made this assertion fail with a 404 instead; the lesson is that a "still 501"
    // test must point at a member the build ACTUALLY leaves unimplemented, or it becomes a lie
    // the moment someone does the work. `scripts/check-contract.mjs` prints the live list.
    //
    // `code` is asserted, `status` is NOT, and the reason is worth writing down rather than
    // leaving as a puzzle: `llamar` recovers the code and message from Electron's wrapped
    // message, but it recovers the STATUS with a second regex (`/status:\s*(\d+)/`) that an
    // Electron-wrapped IpcError never satisfies, so `IpcCallError.status` is `undefined` for
    // every real IPC refusal. Nothing in the renderer branches on it — the vendored UI branches
    // on `code` — so it is harmless, and the doc comment on the class overstates it. Asserting
    // 501 here would encode a promise the transport does not keep.
    const { llamar } = await import('../../src/renderer/app/api/ipc.js')
    await expect(llamar('backup', 'create', {})).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED'
    })
  })
})
