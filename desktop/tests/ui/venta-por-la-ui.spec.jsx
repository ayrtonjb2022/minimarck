// @vitest-environment jsdom
/**
 * THE SALE, MADE THE WAY AN OPERATOR MAKES IT — clicked, not called.
 *
 * Every other sale test in this suite calls `ventas.crear()` and asserts the rows. That is the
 * right level for the repository and the wrong level for the question that actually matters: can
 * a person ring up a ticket and have it land in the shop file? Those are different failures. A
 * repository can be perfect and the POS can still be unable to open a till, show a product, take
 * a weight or submit a payment — and this file is the only thing in the repo that would catch it.
 *
 * WHAT IS REAL HERE, and it is nearly everything:
 *
 *   - The React POS: `PuntoDeVenta`, the real 1130-line vendored component, mounted in jsdom and
 *     driven with clicks, typing and Enter.
 *   - The dispatch: `createRegistry()` with the real `register*Handlers` modules, resolved
 *     through the same `resolve(group, op)` path `installIpc` uses. The component is not handed a
 *     hand-written product list; it asks the registry, and gets the row the real query returns.
 *   - The database: a real migrated, seeded, WAL-mode SQLite file, per test, with real INSERTs
 *     and a real UPDATE of `stock_milli`.
 *
 * The one seam replaced is the Electron TRANSPORT: `window.minimarck.call` is served by the
 * registry in-process instead of by `ipcRenderer.invoke`. That is narrow and deliberate.
 * `scripts/probe-launch.mjs` covers the other half — real preload, real channel, real `app://`
 * origin — and it refuses to pass if the bridge is not the four-member one. Serialization is
 * the probe's job; the operator is this file's job.
 *
 * MONEY IN THE DOM is Argentine: `formatCents(100000)` renders `$1.000,00`, dot thousands and
 * comma decimals. A test that asserted `$1000.00` would fail for a reason that has nothing to do
 * with the code under test, which is why the expectations below spell the commas out.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

import { createRegistry } from '../../src/main/bridge/registry.js'
import { registerVentasHandlers } from '../../src/main/ipc/ventas.js'
import { registerCajasHandlers } from '../../src/main/ipc/cajas.js'
import { registerAuthHandlers } from '../../src/main/ipc/auth.js'
import { registerNegocioHandlers } from '../../src/main/ipc/negocio.js'
import { registerProductosHandlers } from '../../src/main/ipc/productos.js'
import { registerCategoriasHandlers } from '../../src/main/ipc/categorias.js'
import { registerDeudoresHandlers } from '../../src/main/ipc/deudores.js'

import { tienda, ctxDe, insertarProducto } from '../db/fixtures/tienda.js'

import { AuthProvider } from '../../src/renderer/app/context/AuthContext.jsx'
import { CajaProvider } from '../../src/renderer/app/context/CajaContext.jsx'
import { ThemeProvider } from '../../src/renderer/app/context/ThemeContext.jsx'
import { NotificacionProvider } from '../../src/renderer/app/context/NotificacionContext.jsx'
import PuntoDeVenta from '../../src/renderer/app/pages/puntoDeVenta.jsx'

const QTY_SCALE = 1000

/**
 * A real shop, the real registry, and a bridge that dispatches through it.
 *
 * `tienda()` returns a migrated, seeded, per-test copy of the shop file. The `register*` calls
 * are the SAME calls `src/main/index.js` makes with the SAME `{ conn }` shape, so these handlers
 * are not doubles: they are the handlers. Only the Electron channel is standing in.
 */
function escenario({ productos = [] } = {}) {
  const t = tienda()
  const ctx = ctxDe(t, t.negocioId, t.usuarioId)

  const registry = createRegistry()
  registerVentasHandlers(registry, { conn: t.conn })
  registerCajasHandlers(registry, { conn: t.conn })
  registerAuthHandlers(registry, { conn: t.conn })
  registerNegocioHandlers(registry, { conn: t.conn })
  registerProductosHandlers(registry, { conn: t.conn })
  registerCategoriasHandlers(registry, { conn: t.conn })
  registerDeudoresHandlers(registry, { conn: t.conn })

  // No `es_pesable` here on purpose. That column is GENERATED STORED from
  // `unidad_medida IN ('kg','l')` (001_init.sql:354), so SQLite refuses to write it — the error
  // is `cannot UPDATE generated column`, which is the database telling the truth about where
  // "is this weighed?" comes from. `insertarProducto` already stores `kg`, so these products are
  // weighed and the POS reads that flag from the row it was given, never from a guess.
  for (const p of productos) insertarProducto(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, overrides: p })

  globalThis.minimarck = {
    call: async (group, op, payload) => {
      const handler = registry.resolve(group, op)
      return handler(payload ?? {}, ctx)
    }
  }
  return { t }
}

const stores = []
afterEach(() => {
  cleanup()
  delete globalThis.minimarck
  while (stores.length > 0) stores.pop().cerrar()
})

/**
 * Open the till before the sale. This is SETUP, not the claim: it goes through the same
 * `cajas.open` handler the opening modal calls, with the same pesos-valued payload, so the POS
 * under test finds a till the app itself could have produced.
 */
async function abrirLaCaja() {
  await globalThis.minimarck.call('cajas', 'open', {
    saldoInicial: 500,
    observaciones: 'turno de prueba'
  })
}

/**
 * Mount the real POS inside the SAME provider stack `src/renderer/app/main.jsx` mounts, in the
 * same order. The order is not a style choice: `CajaContext` calls `useAuth()`, so a `CajaProvider`
 * without an `AuthProvider` above it throws `useAuth must be used within an AuthProvider` —
 * which is exactly what happened the first time, and is why this function mirrors main.jsx
 * instead of composing what the test happens to need.
 */
function montarPos() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter>
          <AuthProvider>
            <CajaProvider>
              <NotificacionProvider>
                <PuntoDeVenta />
              </NotificacionProvider>
            </CajaProvider>
          </AuthProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

/** The grid card naming a product. The card is the click target, exactly as in the app. */
async function tarjeta(nombre) {
  return waitFor(() => screen.getByText(nombre).closest('.pos-product-card'))
}

function stockDe(t, id) {
  return t.conn.db.prepare('SELECT stock_milli FROM productos WHERE id = ?').get(id).stock_milli
}

function ventaUnica(t) {
  return t.conn.db.prepare('SELECT * FROM ventas WHERE negocio_id = ?').get(t.negocioId)
}

function detallesDe(t, ventaId) {
  return t.conn.db.prepare('SELECT * FROM ventas_detalles WHERE venta_id = ? ORDER BY id').all(ventaId)
}

describe('POS: a ticket clicked by a person lands in the shop file', () => {
  let user
  beforeEach(() => {
    user = userEvent.setup()
  })

  it('sells one unit, decrements stock by one, and writes the sale the cashier confirmed', async () => {
    const { t } = escenario({ productos: [{ nombre: 'Queso artesanal', stock_milli: 3000 }] })
    stores.push(t)
    await abrirLaCaja()

    montarPos()

    // On screen because the real `productos.list` handler answered, and 3000 milli of a kg
    // product is displayed as `3 kg` rather than as `3000`.
    const card = await tarjeta('Queso artesanal')
    expect(within(card).getByText('3 kg')).toBeTruthy()
    expect(within(card).getByText('$200,00')).toBeTruthy()

    await user.click(card)

    const cobrar = await screen.findByRole('button', { name: /Cobrar/ })
    await waitFor(() => expect(cobrar.textContent).toContain('$200,00'))
    expect(screen.getByText('1 artículo')).toBeTruthy()

    // Take the money: $500 tendered against a $200 sale.
    await user.click(cobrar)
    const entregado = await screen.findByPlaceholderText(/Mínimo/)
    await user.type(entregado, '500')

    // The change on screen is the change the repository will store: $300,00.
    await waitFor(() => expect(screen.getByText('Cambio a entregar')).toBeTruthy())
    expect(screen.getByText('$300,00')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /Confirmar Venta/ }))

    // THE CLAIM: a sale row exists in the file, with the money the operator saw on screen.
    const venta = await waitFor(() => {
      const row = ventaUnica(t)
      expect(row).toBeTruthy()
      return row
    })
    expect(venta.total_centavos).toBe(20000)
    expect(venta.monto_recibido_centavos).toBe(50000)
    expect(venta.monto_cambio_centavos).toBe(30000)
    expect(venta.metodo_pago).toBe('efectivo')

    // A header alone is not a sale. The line is there, at the price of the card that was clicked.
    const [linea] = detallesDe(t, venta.id)
    expect(linea).toBeTruthy()
    expect(linea.producto_id).toBe(1)
    expect(linea.cantidad_milli).toBe(QTY_SCALE)
    expect(linea.precio_unitario_centavos).toBe(20000)

    // And the shelf lost exactly one unit: 3 kg became 2 kg.
    expect(stockDe(t, 1)).toBe(2000)

    // The ticket empties itself, which is how the operator knows it went through.
    await waitFor(() => expect(screen.getByText('0 artículos')).toBeTruthy())
  })

  it('sells HALF A KILO by weight: 500 milli in, 500 milli out, half the money', async () => {
    // $2.000,00 per kilo. Half of it is $1.000,00, and that is the whole point of the test.
    const { t } = escenario({
      productos: [{ nombre: 'Queso artesanal', stock_milli: 3000, precio_centavos: 200000 }]
    })
    stores.push(t)
    await abrirLaCaja()

    montarPos()

    // Open the real scale for the real weighed product.
    const card = await tarjeta('Queso artesanal')
    await user.click(within(card).getByTitle('Calcular por peso'))

    // Weigh 500 g. A scale reports grams; the product is priced per kilo.
    const peso = await screen.findByPlaceholderText('Ej: 250')
    await user.type(peso, '500')
    await user.click(screen.getByRole('button', { name: /Agregar al ticket/ }))

    // The ticket says `500 g`, and the total is $1.000,00 — not $2.000,00 for a whole kilo.
    await waitFor(() => expect(screen.getByText('500 g')).toBeTruthy())
    const cobrar = await screen.findByRole('button', { name: /Cobrar/ })
    await waitFor(() => expect(cobrar.textContent).toContain('$1.000,00'))

    await user.click(cobrar)
    await user.type(await screen.findByPlaceholderText(/Mínimo/), '1000')
    await user.click(screen.getByRole('button', { name: /Confirmar Venta/ }))

    const venta = await waitFor(() => {
      const row = ventaUnica(t)
      expect(row).toBeTruthy()
      return row
    })

    // THE CLAIM. Grams survive the whole trip: scale → renderer integer math → the row.
    expect(venta.total_centavos).toBe(100000)
    const [linea] = detallesDe(t, venta.id)
    expect(linea.cantidad_milli).toBe(500)

    // Half a kilo left the shelf. Not a kilo. Not nothing. 500.
    expect(stockDe(t, 1)).toBe(2500)
  })

  it('adds a product when a barcode arrives as keyboard text terminated with Enter', async () => {
    const { t } = escenario({ productos: [{ nombre: 'Gaseosa 500ml', stock_milli: 24000 }] })
    stores.push(t)
    t.conn.db.prepare('UPDATE productos SET codigo = ? WHERE id = ?').run('7790123456789', 1)
    await abrirLaCaja()

    montarPos()

    // A USB barcode scanner IS a keyboard: it types the code and sends Enter. Nothing else.
    const busca = await screen.findByPlaceholderText(/Buscar o escanear/)
    await user.type(busca, '7790123456789{Enter}')

    // The product is on the ticket, not merely still in the grid. Both name the product, so the
    // assertion is scoped to the cart: "found two elements" would have passed a broken sale.
    const carrito = document.querySelector('.cart-scroll')
    await waitFor(() => expect(within(carrito).getByText('Gaseosa 500ml')).toBeTruthy())

    const cobrar = await screen.findByRole('button', { name: /Cobrar/ })
    await waitFor(() => expect(cobrar.textContent).toContain('$200,00'))
  })

  it('refuses to sell with no till open, and says why', async () => {
    const { t } = escenario({ productos: [{ nombre: 'Queso artesanal' }] })
    stores.push(t)
    // No `abrirLaCaja()`: this is the shop before anyone opened the register.

    montarPos()

    // The guard replaces the grid, so the product cannot even be clicked — and an operator is
    // told what to do about it instead of being left with a dead screen.
    await waitFor(() => expect(screen.getByText('No hay caja abierta')).toBeTruthy())
    expect(screen.queryByText('Queso artesanal')).toBeNull()
    expect(screen.getByRole('button', { name: /Abrir caja/i })).toBeTruthy()
  })
})
