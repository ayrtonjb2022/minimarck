// @vitest-environment jsdom
/**
 * THE CATALOGUE HAS TO TELL THE TILL.
 *
 * The point of sale caches the product list for five minutes (`["productos","all-for-pos"]`, with
 * `staleTime: 5 * 60 * 1000`). The catalogue had its own fetching — raw `productosAPI` calls and a
 * local `cargar()` — and never wrote to that cache. So a product created in the catalogue showed up
 * in the catalogue and stayed missing at the till until the five minutes ran out. The operator reads
 * that as "it has not saved yet", which is what they said.
 *
 * The bug lives in the CACHE, and in the GAP BETWEEN TWO SCREENS, so the test has to cross both:
 *
 *   1. The till, already opened against a shop with one product. That is the cache.
 *   2. The catalogue, where a second product is created through the real form.
 *   3. The till again, with no five minutes elapsed, where the second product has to be there.
 *
 * The seam is one `QueryClient`, shared across every mount, exactly like the running app. A client
 * per render — or `gcTime: 0`, which the other UI specs use — would refetch from scratch on the
 * second mount and this test would pass with the bug still in the code. The cache surviving the
 * unmounts is the point.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
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

import { tienda, ctxDe, insertarProducto, iniciarSesion, abrirCaja } from '../db/fixtures/tienda.js'

import { AuthProvider } from '../../src/renderer/app/context/AuthContext.jsx'
import { CajaProvider } from '../../src/renderer/app/context/CajaContext.jsx'
import { ThemeProvider } from '../../src/renderer/app/context/ThemeContext.jsx'
import { NotificacionProvider } from '../../src/renderer/app/context/NotificacionContext.jsx'
import PuntoDeVenta from '../../src/renderer/app/pages/puntoDeVenta.jsx'
import Productos from '../../src/renderer/app/pages/Productos.jsx'

const stores = []
afterEach(() => {
  cleanup()
  delete globalThis.minimarck
  while (stores.length > 0) stores.pop().cerrar()
})

/** A shop with somebody on the till and the handlers both screens call. */
function unEscenario() {
  const t = tienda()
  stores.push(t)
  const ctx = ctxDe(t, t.negocioId, t.usuarioId)

  const registry = createRegistry()
  const { session } = iniciarSesion(t)
  registerVentasHandlers(registry, { conn: t.conn })
  registerCajasHandlers(registry, { conn: t.conn })
  registerAuthHandlers(registry, { conn: t.conn, session })
  registerNegocioHandlers(registry, { conn: t.conn })
  registerProductosHandlers(registry, { conn: t.conn })
  registerCategoriasHandlers(registry, { conn: t.conn })

  globalThis.minimarck = {
    call: async (group, op, payload) => registry.resolve(group, op)(payload ?? {}, ctx)
  }

  // The till was opened BEFORE anybody looked: the screen as the operator left it.
  abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId })
  insertarProducto(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, overrides: { nombre: 'Queso artesanal' } })
  return t
}

const montar = (client, contenido) =>
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter>
          <AuthProvider>
            <CajaProvider>
              <NotificacionProvider>{contenido}</NotificacionProvider>
            </CajaProvider>
          </AuthProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  )

describe('el catálogo y el punto de venta: un solo caché, una sola verdad', () => {
  it('un producto creado en el catálogo aparece en el punto de venta sin esperar los cinco minutos', async () => {
    const t = unEscenario()
    const user = userEvent.setup()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    // ── 1. The till, as the operator left it. This mount is what warms the cache.
    const pos = montar(client, <PuntoDeVenta />)
    await waitFor(() => expect(screen.getByText('Queso artesanal')).toBeTruthy())
    expect(screen.queryByText('Caramelo')).toBeNull()
    pos.unmount()

    // ── 2. The catalogue, and a new product through the real form.
    const cat = montar(client, <Productos />)
    await user.click(await screen.findByTestId('nuevo-producto', {}, { timeout: 5000 }))
    await user.type(await screen.findByLabelText('Nombre *'), 'Caramelo')
    await user.type(screen.getByLabelText('Precio de venta *'), '1.50')
    await user.click(screen.getByTestId('guardar-producto'))

    // The row is in the shop. This is not the assertion that was missing — it never failed.
    await waitFor(() => {
      expect(t.conn.db.prepare('SELECT nombre FROM productos WHERE nombre = ?').get('Caramelo')).toBeTruthy()
    })
    cat.unmount()

    // ── 3. Back at the till, five minutes having NOT passed. Before the fix the POS served its
    // five-minute-old cache and "Caramelo" was simply not on the screen.
    montar(client, <PuntoDeVenta />)
    await waitFor(() => expect(screen.getByText('Caramelo')).toBeTruthy(), { timeout: 5000 })
  })
})
