// @vitest-environment jsdom
/**
 * THE CATALOGUE SCANNER, DRIVEN THE WAY A RESTOCK IS ACTUALLY DONE.
 *
 * A barcode reader is a keyboard that types a code and presses Enter, and the products screen now
 * carries a scan box in its toolbar. Scanning resolves a code through `productos.findByCode` — a
 * read that already existed in the frozen contract, so no operation was added — and opens a small
 * panel that restores stock. This file is about that path from the operator's side:
 *
 *   1. an ACTIVE code opens the panel with the product it names;
 *   2. writing a new total updates `stock_milli` in the real database AND tells the cache;
 *   3. an INACTIVE product is told, not silently reactivated — the warning shows and Save is off;
 *   4. a blank code is not a request at all.
 *
 * The harness is the one `catalogo-y-pos.spec.jsx` and `deudores.spec.jsx` build: the real React
 * screen, the real handler registry, a real migrated SQLite file per test, and a `<ToastContainer />`
 * because a `toast` call with no container renders NOTHING — the screen would look like it worked
 * and said nothing.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { ToastContainer } from 'react-toastify'

import { createRegistry } from '../../src/main/bridge/registry.js'
import { registerVentasHandlers } from '../../src/main/ipc/ventas.js'
import { registerCajasHandlers } from '../../src/main/ipc/cajas.js'
import { registerAuthHandlers } from '../../src/main/ipc/auth.js'
import { registerNegocioHandlers } from '../../src/main/ipc/negocio.js'
import { registerProductosHandlers } from '../../src/main/ipc/productos.js'
import { registerCategoriasHandlers } from '../../src/main/ipc/categorias.js'

import { tienda, ctxDe, iniciarSesion } from '../db/fixtures/tienda.js'

import { AuthProvider } from '../../src/renderer/app/context/AuthContext.jsx'
import { CajaProvider } from '../../src/renderer/app/context/CajaContext.jsx'
import { ThemeProvider } from '../../src/renderer/app/context/ThemeContext.jsx'
import { NotificacionProvider } from '../../src/renderer/app/context/NotificacionContext.jsx'
import Productos from '../../src/renderer/app/pages/Productos.jsx'

/** A shop with somebody signed in and the handlers both screens call. */
function unEscenario() {
  const t = tienda()
  const ctx = ctxDe(t, t.negocioId, t.usuarioId)

  const registry = createRegistry()
  const { session } = iniciarSesion(t)
  registerVentasHandlers(registry, { conn: t.conn })
  registerCajasHandlers(registry, { conn: t.conn })
  registerAuthHandlers(registry, { conn: t.conn, session })
  registerNegocioHandlers(registry, { conn: t.conn })
  registerProductosHandlers(registry, { conn: t.conn })
  registerCategoriasHandlers(registry, { conn: t.conn })

  // Every call is recorded, because "a blank code makes no request" is a claim about the wire and
  // not about what happens to be on screen.
  const llamadas = []
  globalThis.minimarck = {
    call: async (group, op, payload) => {
      const handler = registry.resolve(group, op)
      const res = await handler(payload ?? {}, ctx)
      llamadas.push({ group, op, payload: payload ?? {} })
      return res
    }
  }
  return { t, ctx, llamadas }
}

const stores = []
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete globalThis.minimarck
  while (stores.length > 0) stores.pop().cerrar()
})

const nuevoCliente = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })

function montar(client, contenido) {
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter>
          <AuthProvider>
            <CajaProvider>
              <NotificacionProvider>
                {contenido}
                <ToastContainer />
              </NotificacionProvider>
            </CajaProvider>
          </AuthProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

/** Create a product through the real handler, so it has a barcode the scanner can find. */
const crearProducto = (datos) => globalThis.minimarck.call('productos', 'create', datos)

describe('el escáner del catálogo y el panel de stock', () => {
  let user
  beforeEach(() => {
    user = userEvent.setup()
  })

  it('escanear un código activo abre el panel con los datos del producto', async () => {
    const { t } = unEscenario()
    stores.push(t)
    await crearProducto({
      nombre: 'Yerba mate',
      codigo: '7791234567890',
      precio: '10.00',
      stock: '3',
      stockMinimo: '1',
      unidadMedida: 'unidad'
    })
    montar(nuevoCliente(), <Productos />)

    const scan = await screen.findByTestId('scan-codigo')
    await user.type(scan, '7791234567890{Enter}')

    const panel = await screen.findByTestId('stock-in-panel')
    // The panel, not the table behind it: the same name lives in both, and the assertion is that
    // the resolved product is the one the panel is about.
    expect(panel.textContent).toContain('Yerba mate')
    expect(panel.textContent).toContain('7791234567890')
    expect(within(panel).queryByTestId('stock-in-warning')).toBeNull()
    expect(within(panel).getByTestId('stock-in-submit').disabled).toBe(false)
  })

  it('guardar escribe stock_milli en la base, avisa al caché y el listado muestra el nuevo stock', async () => {
    const { t } = unEscenario()
    stores.push(t)
    const creado = await crearProducto({
      nombre: 'Queso artesanal',
      codigo: '7790000000001',
      precio: '200.00',
      stock: '3',
      // Not the 5000 default: the minimum column would then read "5 kg" too and the assertion below
      // about the new stock would match the wrong cell.
      stockMinimo: '1',
      unidadMedida: 'kg'
    })
    const client = nuevoCliente()
    const invalidar = vi.spyOn(client, 'invalidateQueries')
    montar(client, <Productos />)

    await screen.findByText('Queso artesanal')
    const scan = screen.getByTestId('scan-codigo')
    await user.type(scan, '7790000000001{Enter}')

    const panel = await screen.findByTestId('stock-in-panel')
    const input = within(panel).getByTestId('stock-in-input')
    await user.clear(input)
    await user.type(input, '5')
    await user.click(within(panel).getByTestId('stock-in-submit'))

    // The database's own verdict: the absolute stock was written as thousandths.
    await waitFor(() => {
      expect(
        t.conn.db.prepare('SELECT stock_milli FROM productos WHERE id = ?').get(creado.id).stock_milli
      ).toBe(5000)
    })
    // And the POS cache was told, with the same prefix the POS subscribes to.
    expect(invalidar).toHaveBeenCalledWith({ queryKey: ['productos'] })

    // The panel closed, the box was cleared and the list reloaded: "5 kg" is the shelf after the
    // write, and it is on screen without the operator touching the filters.
    await waitFor(() => expect(screen.queryByTestId('stock-in-panel')).toBeNull())
    await waitFor(() => expect(screen.getByText('5 kg')).toBeTruthy())
    expect(screen.getByTestId('scan-codigo').value).toBe('')
  })

  it('escanear un producto inactivo muestra el aviso y deja guardar deshabilitado', async () => {
    const { t } = unEscenario()
    stores.push(t)
    await crearProducto({
      nombre: 'Producto discontinuado',
      codigo: '7790000000002',
      precio: '5.00',
      stock: '2',
      stockMinimo: '1',
      unidadMedida: 'unidad',
      activo: false
    })
    montar(nuevoCliente(), <Productos />)

    const scan = await screen.findByTestId('scan-codigo')
    await user.type(scan, '7790000000002{Enter}')

    const panel = await screen.findByTestId('stock-in-panel')
    // The warning is the operator's only clue about WHY the button will not fire.
    expect(within(panel).getByTestId('stock-in-warning').textContent).toContain('inactivo')
    expect(within(panel).getByTestId('stock-in-submit').disabled).toBe(true)
  })

  it('un código en blanco no hace ninguna petición', async () => {
    const { t, llamadas } = unEscenario()
    stores.push(t)
    montar(nuevoCliente(), <Productos />)

    const scan = await screen.findByTestId('scan-codigo')
    // Whitespace and nothing: both are the stray Enter a reader fires. Neither is a lookup.
    await user.type(scan, '   {Enter}')
    await user.type(scan, '{Enter}')

    expect(screen.queryByTestId('stock-in-panel')).toBeNull()
    expect(llamadas.some((c) => c.op === 'findByCode')).toBe(false)
  })

  it('escanear un código desconocido abre el formulario de alta con el código cargado', async () => {
    const { t } = unEscenario()
    stores.push(t)
    montar(nuevoCliente(), <Productos />)

    const scan = await screen.findByTestId('scan-codigo')
    await user.type(scan, '7799999999999{Enter}')

    // The create form — NOT the stock panel. The code the reader typed is already in the field, so
    // the operator adds the product without retyping what the scanner just read.
    const codigo = await screen.findByLabelText('Código de barras')
    expect(codigo.value).toBe('7799999999999')
    expect(screen.queryByTestId('stock-in-panel')).toBeNull()
    // The scan box is emptied so the next read starts clean.
    expect(screen.getByTestId('scan-codigo').value).toBe('')
  })

  it('un código borrado (soft-delete) también abre el formulario de alta', async () => {
    const { t } = unEscenario()
    stores.push(t)
    const creado = await crearProducto({
      nombre: 'Producto discontinuado del catálogo',
      codigo: '7793333333333',
      precio: '5.00',
      stock: '1',
      unidadMedida: 'unidad'
    })
    // Soft-delete: `findByCode` stops seeing it (`deleted_at IS NULL`), which is the same `null`
    // path an unknown code takes — the two land on the same create form.
    await globalThis.minimarck.call('productos', 'remove', { id: creado.id })
    montar(nuevoCliente(), <Productos />)

    const scan = await screen.findByTestId('scan-codigo')
    await user.type(scan, '7793333333333{Enter}')

    const codigo = await screen.findByLabelText('Código de barras')
    expect(codigo.value).toBe('7793333333333')
    expect(screen.queryByTestId('stock-in-panel')).toBeNull()
  })

  it('dar de alta un código que ya existe avisa PRODUCTO_CODIGO_DUPLICADO', async () => {
    const { t } = unEscenario()
    stores.push(t)
    const creado = await crearProducto({
      nombre: 'Galletitas viejas',
      codigo: '7791111111111',
      precio: '10.00',
      stock: '1',
      unidadMedida: 'unidad'
    })
    // Soft-deleted, so the scan reaches the create form — but the code is still taken, and the
    // repository's duplicate check does not care about `deleted_at`.
    await globalThis.minimarck.call('productos', 'remove', { id: creado.id })
    montar(nuevoCliente(), <Productos />)

    const scan = await screen.findByTestId('scan-codigo')
    await user.type(scan, '7791111111111{Enter}')

    await user.type(await screen.findByLabelText('Nombre *'), 'Galletitas nuevas')
    await user.type(screen.getByLabelText('Precio de venta *'), '12.00')
    await user.click(screen.getByTestId('guardar-producto'))

    // The repository's own sentence, which names the collision instead of a generic failure.
    await screen.findByText(/ya existe en esta tienda/)
    // And nothing was written: still exactly one row carrying that barcode.
    expect(
      t.conn.db.prepare('SELECT COUNT(*) AS n FROM productos WHERE codigo = ?').get('7791111111111').n
    ).toBe(1)
  })

  it('crear el producto desde el formulario del escáner lo guarda y refresca el catálogo', async () => {
    const { t } = unEscenario()
    stores.push(t)
    const client = nuevoCliente()
    const invalidar = vi.spyOn(client, 'invalidateQueries')
    montar(client, <Productos />)

    const scan = await screen.findByTestId('scan-codigo')
    await user.type(scan, '7792222222222{Enter}')

    await user.type(await screen.findByLabelText('Nombre *'), 'Alfajor triple')
    await user.type(screen.getByLabelText('Precio de venta *'), '150.00')
    await user.click(screen.getByTestId('guardar-producto'))

    // The row exists in the shop, with the barcode the scanner read and no retyping.
    await waitFor(() => {
      const fila = t.conn.db
        .prepare('SELECT nombre, codigo FROM productos WHERE codigo = ?')
        .get('7792222222222')
      expect(fila?.nombre).toBe('Alfajor triple')
    })
    // The POS is told by PREFIX, exactly like the "Nuevo producto" button's create path.
    expect(invalidar).toHaveBeenCalledWith({ queryKey: ['productos'] })
    // The modal closed and the reloaded list shows the new row without touching the filters.
    await waitFor(() => expect(screen.getByText('Alfajor triple')).toBeTruthy())
    expect(screen.queryByLabelText('Código de barras')).toBeNull()
  })
})
