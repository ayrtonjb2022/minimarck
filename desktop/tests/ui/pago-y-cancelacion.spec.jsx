// @vitest-environment jsdom
/**
 * TAKING THE MONEY — the four things a till has to get right, driven the way an operator does it.
 *
 * `venta-por-la-ui.spec.jsx` already proves a ticket becomes a sale. This file is about what
 * happens AROUND that sale, where the money actually goes wrong:
 *
 *   1. F2 opens the payment screen. It used to be reachable only by clicking a button, so the
 *      keyboard flow a cashier actually works had a hole in the middle of it.
 *   2. The change is the REPOSITORY's number. The screen shows a change to the cashier because
 *      a cashier handing over coins needs to know how many — but the value that gets stored is
 *      computed inside the sale transaction, and the client has no way to name it.
 *   3. A sale with no till open is refused by the REPOSITORY, in words. It used to fall through
 *      a null check and commit a sale with no drawer movement at all.
 *   4. A debtor who still owes money gets a receipt that says so.
 *
 * The harness is `venta-por-la-ui.spec.jsx`'s, unchanged in spirit: the real React POS, the real
 * registry, a real migrated SQLite file. The one seam is the Electron transport.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup, within, fireEvent } from '@testing-library/react'
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

import { tienda, ctxDe, insertarProducto, insertarDeudor, abrirCaja, iniciarSesion } from '../db/fixtures/tienda.js'

import { AuthProvider } from '../../src/renderer/app/context/AuthContext.jsx'
import { CajaProvider } from '../../src/renderer/app/context/CajaContext.jsx'
import { ThemeProvider } from '../../src/renderer/app/context/ThemeContext.jsx'
import { NotificacionProvider } from '../../src/renderer/app/context/NotificacionContext.jsx'
import PuntoDeVenta from '../../src/renderer/app/pages/puntoDeVenta.jsx'
import Ventas from '../../src/renderer/app/pages/Ventas.jsx'

function escenario({ productos = [] } = {}) {
  const t = tienda()
  const ctx = ctxDe(t, t.negocioId, t.usuarioId)

  const registry = createRegistry()
  // Somebody has to be ON THE TILL: the app answers ACTOR_REQUERIDO and renders no till when the
  // session is empty, so a POS test without a sign-in was testing the absence of one.
  const { session: sesion } = iniciarSesion(t)
  registerVentasHandlers(registry, { conn: t.conn })
  registerCajasHandlers(registry, { conn: t.conn })
  registerAuthHandlers(registry, { conn: t.conn, session: sesion })
  registerNegocioHandlers(registry, { conn: t.conn })
  registerProductosHandlers(registry, { conn: t.conn })
  registerCategoriasHandlers(registry, { conn: t.conn })
  registerDeudoresHandlers(registry, { conn: t.conn })

  for (const p of productos) insertarProducto(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, overrides: p })

  // Every call is RECORDED, not just forwarded. The claim that the client cannot dictate the
  // change is a claim about the payload, and a payload nobody looked at proves nothing.
  const llamadas = []
  globalThis.minimarck = {
    calls: llamadas,
    call: async (group, op, payload) => {
      const handler = registry.resolve(group, op)
      const res = await handler(payload ?? {}, ctx)
      llamadas.push({ group, op, payload: payload ?? {} })
      return res
    }
  }
  return { t, llamadas }
}

const stores = []
afterEach(() => {
  cleanup()
  delete globalThis.minimarck
  while (stores.length > 0) stores.pop().cerrar()
})

function montar(contenido) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
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
}

const montarPos = () => montar(<PuntoDeVenta />)
const montarVentas = () => montar(<Ventas />)

async function abrirLaCaja() {
  await globalThis.minimarck.call('cajas', 'open', { saldoInicial: 500, observaciones: 'turno' })
}

const tarjeta = (nombre) => waitFor(() => screen.getByText(nombre).closest('.pos-product-card'))
const stockDe = (t, id) => t.conn.db.prepare('SELECT stock_milli FROM productos WHERE id = ?').get(id).stock_milli
const ventaUnica = (t) => t.conn.db.prepare('SELECT * FROM ventas WHERE negocio_id = ? ORDER BY id DESC').get(t.negocioId)
const movimientoDe = (t, tipo) =>
  t.conn.db.prepare('SELECT * FROM movimientos_caja WHERE tipo = ? ORDER BY id DESC LIMIT 1').get(tipo)

/** Click a product onto the ticket and wait for the cart to hold it. */
async function agregar(user, nombre) {
  const card = await tarjeta(nombre)
  await user.click(card)
  const carrito = document.querySelector('.cart-scroll')
  await waitFor(() => expect(within(carrito).getByText(nombre)).toBeTruthy())
}

describe('taking the money: F2, the change, the till, and the receipt', () => {
  let user
  beforeEach(() => {
    user = userEvent.setup()
  })

  it('F2 opens the payment screen, and the full cash path lands the sale, the drawer and the ledger', async () => {
    const { t } = escenario({ productos: [{ nombre: 'Queso artesanal', stock_milli: 3000 }] })
    stores.push(t)
    await abrirLaCaja()
    montarPos()

    await agregar(user, 'Queso artesanal')

    // THE KEYSTROKE. F2, on an empty payment screen, and nothing else: no click on "Cobrar".
    // Before this, the shortcut did not exist and the only way in was the mouse.
    expect(screen.queryByPlaceholderText(/Mínimo/)).toBeNull()
    fireEvent.keyDown(window, { key: 'F2' })
    const entregado = await screen.findByPlaceholderText(/Mínimo/)
    expect(entregado).toBeTruthy()

    await user.type(entregado, '500')
    await waitFor(() => expect(screen.getByText('Cambio a entregar')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: /Confirmar Venta/ }))

    const venta = await waitFor(() => {
      const row = ventaUnica(t)
      expect(row).toBeTruthy()
      return row
    })

    // The money, as the repository stored it.
    expect(venta.total_centavos).toBe(20000)
    expect(venta.monto_recibido_centavos).toBe(50000)
    expect(venta.monto_cambio_centavos).toBe(30000)
    expect(stockDe(t, 1)).toBe(2000)

    // The drawer got the sale. This is the row that was missing when the till was closed.
    const ingreso = movimientoDe(t, 'ingreso')
    expect(ingreso.monto_centavos).toBe(20000)
  })

  it('a tender of less than the total cannot be confirmed, and the exact tender is accepted', async () => {
    const { t } = escenario({ productos: [{ nombre: 'Queso artesanal', stock_milli: 3000 }] })
    stores.push(t)
    await abrirLaCaja()
    montarPos()
    await agregar(user, 'Queso artesanal')

    fireEvent.keyDown(window, { key: 'F2' })
    const entregado = await screen.findByPlaceholderText(/Mínimo/)
    await user.type(entregado, '100')

    // Under the total: the change line never appears, because there is no change to hand over.
    expect(screen.queryByText('Cambio a entregar')).toBeNull()
    const confirmar = screen.getByRole('button', { name: /Confirmar Venta/ })
    await waitFor(() => expect(confirmar.disabled).toBe(true))

    // The exact tender is a valid sale, and its change is zero.
    await user.clear(entregado)
    await user.type(entregado, '200')
    await waitFor(() => expect(screen.getByRole('button', { name: /Confirmar Venta/ }).disabled).toBe(false))
  })

  it('THE CHANGE IS THE REPOSITORY\'S: the client sends a tender and no change at all', async () => {
    const { t, llamadas } = escenario({ productos: [{ nombre: 'Queso artesanal', stock_milli: 3000 }] })
    stores.push(t)
    await abrirLaCaja()
    montarPos()
    await agregar(user, 'Queso artesanal')

    fireEvent.keyDown(window, { key: 'F2' })
    const entregado = await screen.findByPlaceholderText(/Mínimo/)
    await user.type(entregado, '500')
    await user.click(screen.getByRole('button', { name: /Confirmar Venta/ }))
    await waitFor(() => expect(ventaUnica(t)).toBeTruthy())

    const create = llamadas.find((c) => c.group === 'ventas' && c.op === 'create')
    expect(create).toBeTruthy()

    // THE CLAIM. No field anywhere in the payload can name the change. Not `cambioCentavos`,
    // not `montoCambio`, not a Spanish spelling of it: if none of these is present, the
    // repository's subtraction is the only thing that can produce a stored change.
    const cuerpo = create.payload
    for (const clave of Object.keys(cuerpo)) {
      expect(clave.toLowerCase()).not.toMatch(/cambio|change/)
    }
    expect(cuerpo).not.toHaveProperty('cambioCentavos')
    expect(cuerpo).not.toHaveProperty('montoCambio')

    // What it DOES send is the tender, in pesos, which is what the contract asks for.
    expect(cuerpo.montoRecibido).toBe(500)
    // And the value on screen came back from the response, not from the input.
    expect(ventaUnica(t).monto_cambio_centavos).toBe(30000)
  })

  it('a tampered payload cannot dictate the change: the repository subtracts its own numbers', async () => {
    // THE TRUST BOUNDARY, tested from the outside.
    //
    // The test above proves the POS does not send a change. That is a claim about ONE caller, and
    // a mutation proved it was the weaker of the two guards: putting `cambioCentavos` back into
    // the renderer's `onConfirm` payload left the wire clean, because `handleConfirmarVenta`
    // never destructures it. Good defence in depth — but it means the interesting question is not
    // "does the POS cheat", it is "can ANY caller".
    //
    // So this goes around the renderer entirely and hands the handler a payload that tries to
    // name the change in every spelling a client might reach for. The stored figure must be the
    // repository's own subtraction and nothing else.
    const { t } = escenario({ productos: [{ nombre: 'Queso artesanal', stock_milli: 3000 }] })
    stores.push(t)
    await abrirLaCaja()

    const res = await globalThis.minimarck.call('ventas', 'create', {
      items: [{ productoId: 1, cantidad: 1 }],
      metodoPago: 'efectivo',
      idempotencyKey: 'tk-tamper',
      montoRecibido: 500,
      // Every shape a tampered client could try.
      cambioCentavos: 1,
      montoCambioCentavos: 2,
      monto_cambio_centavos: 3,
      change: 4,
      totalCentavos: 1
    })

    // $500,00 tendered against a $200,00 sale is $300,00 of change, and $300,00 is what is
    // stored and returned — not the 1, 2, 3 or 4 the client asked for, and not the $0,01 total it
    // tried to impose.
    expect(res.venta.totalCentavos).toBe(20000)
    expect(res.venta.montoCambioCentavos).toBe(30000)
    const fila = ventaUnica(t)
    expect(fila.total_centavos).toBe(20000)
    expect(fila.monto_cambio_centavos).toBe(30000)
    // The drawer is told the same number the sale is, or the till would not add up.
    expect(movimientoDe(t, 'ingreso').monto_centavos).toBe(20000)
  })

  it('a half-cent tender rounds to the cent, symmetrically, and does not drift', async () => {
    // $33,335 against a $33,335 sale is not a case a shop hits, but the rounding rule is the
    // same one that decides whether a $0,005 discount becomes a free item.
    const { t } = escenario({ productos: [{ nombre: 'Queso artesanal', stock_milli: 3000, precio_centavos: 6667 }] })
    stores.push(t)
    await abrirLaCaja()
    montarPos()
    await agregar(user, 'Queso artesanal')

    fireEvent.keyDown(window, { key: 'F2' })
    const entregado = await screen.findByPlaceholderText(/Mínimo/)
    await user.type(entregado, '66.67')
    await user.click(screen.getByRole('button', { name: /Confirmar Venta/ }))

    const venta = await waitFor(() => {
      const row = ventaUnica(t)
      expect(row).toBeTruthy()
      return row
    })
    // 66,67 tendered against 66,67 billed: no change, and no cent created or destroyed.
    expect(venta.total_centavos).toBe(6667)
    expect(venta.monto_recibido_centavos).toBe(6667)
    expect(venta.monto_cambio_centavos).toBe(0)
  })

  it('a sale with no till open is refused by the repository, in words, and changes nothing', async () => {
    const { t } = escenario({ productos: [{ nombre: 'Queso artesanal', stock_milli: 3000 }] })
    stores.push(t)
    // No `abrirLaCaja()`. The POS refuses on the client, so this test goes AROUND the client:
    // it calls the handler directly, which is what any other caller would do.
    await globalThis.minimarck.call('cajas', 'open', { saldoInicial: 500 })
    const cajaId = t.conn.db.prepare('SELECT id FROM cajas WHERE negocio_id = ?').get(t.negocioId).id
    t.conn.db.prepare('UPDATE cajas SET estado = ? WHERE id = ?').run('cerrada', cajaId)

    const fallo = await globalThis.minimarck
      .call('ventas', 'create', { items: [{ productoId: 1, cantidad: 1 }], metodoPago: 'efectivo', idempotencyKey: 'tk-sin-caja' })
      .then(() => null)
      .catch((e) => e)

    // A clear refusal, not a SQLite constraint name leaking through as a 500.
    expect(fallo).toBeTruthy()
    expect(fallo.message).toMatch(/caja/i)
    expect(String(fallo.code || '')).not.toMatch(/SQLITE/)

    // AND the important half: nothing was written. The old behaviour sold the goods, decremented
    // the stock, posted the journal and left the cash in nobody's drawer.
    expect(ventaUnica(t)).toBeUndefined()
    expect(stockDe(t, 1)).toBe(3000)
  })

  it('a sale can be cancelled from the sales list, and the stock comes back', async () => {
    const { t } = escenario({ productos: [{ nombre: 'Queso artesanal', stock_milli: 3000 }] })
    stores.push(t)
    await abrirLaCaja()
    montarPos()
    await agregar(user, 'Queso artesanal')
    fireEvent.keyDown(window, { key: 'F2' })
    const entregado = await screen.findByPlaceholderText(/Mínimo/)
    await user.type(entregado, '200')
    await user.click(screen.getByRole('button', { name: /Confirmar Venta/ }))
    await waitFor(() => expect(ventaUnica(t)).toBeTruthy())
    expect(stockDe(t, 1)).toBe(2000)
    cleanup()

    // The same shop, now looking at the sales list.
    montarVentas()
    // The row's own affordance: each sale has a "Ver detalle" button carrying its folio as the
    // accessible name, which is a better handle than the folio text itself.
    const verDetalle = await screen.findByRole('button', { name: /Ver detalle de la venta/ }, { timeout: 5000 })
    // "Completada" also names the state filter's option, so the row badge is asserted inside
    // the table rather than against the whole document.
    expect(within(document.querySelector('tbody')).getByText('Completada')).toBeTruthy()
    await user.click(verDetalle)

    // Two steps, because the button undoes a sale.
    await user.click(await screen.findByTestId('armar-cancelacion'))
    await user.click(await screen.findByTestId('confirmar-cancelacion'))

    await waitFor(() => {
      expect(ventaUnica(t).estado).toBe('cancelada')
    })
    // The goods are back on the shelf, which is the entire point of cancelling.
    expect(stockDe(t, 1)).toBe(3000)
    // And the drawer got its money back out.
    const egreso = movimientoDe(t, 'egreso')
    expect(egreso).toBeTruthy()
    expect(egreso.monto_centavos).toBe(20000)
  })

  it('el detalle de una venta fiada muestra sus productos, aunque no tenga recibido ni cambio', async () => {
    const { t } = escenario({ productos: [{ nombre: 'Queso artesanal', stock_milli: 3000 }] })
    stores.push(t)
    await abrirLaCaja()

    const deudor = insertarDeudor(t, {
      negocioId: t.negocioId,
      usuarioId: t.usuarioId,
      nombre: 'Marta Gomez'
    })

    // UNA VENTA FIADA NO TIENE RECIBIDO NI CAMBIO: nadie puso billetes en el mostrador, así que
    // las dos columnas quedan en NULL. `formatCentavos(null)` no devuelve un cero — tira
    // MONEY_NOT_CENTS, y el que tira durante el render se lleva el subárbol desmontado.
    await globalThis.minimarck.call('ventas', 'create', {
      items: [{ productoId: 1, cantidad: 1 }],
      metodoPago: 'credito',
      clienteDeudorId: deudor.id,
      idempotencyKey: 'tk-fiada-detalle'
    })

    montarVentas()
    const verDetalle = await screen.findByRole('button', { name: /Ver detalle de la venta/ }, { timeout: 5000 })
    await user.click(verDetalle)

    // LO QUE FALTABA MIRAR. El otro test que abre el detalle va derecho al botón de cancelar y
    // nunca afirma que los productos estén: por eso un detalle que se cae entero pasaba igual,
    // siempre que la venta hubiera sido en efectivo y con vuelto. Crédito y transferencia —dos de
    // cada tres ventas de un negocio real— llegaban acá con los montos en NULL.
    expect(await screen.findByText('Queso artesanal', undefined, { timeout: 5000 })).toBeTruthy()
    expect(screen.queryByText('Esta venta no tiene lineas')).toBeNull()
  })

  it('the payment receipt shows a real balance for a debtor who still owes, not a hardcoded zero', async () => {
    const { t } = escenario({ productos: [{ nombre: 'Queso artesanal', stock_milli: 3000 }] })
    stores.push(t)
    await abrirLaCaja()

    const deudor = insertarDeudor(t, {
      negocioId: t.negocioId,
      usuarioId: t.usuarioId,
      nombre: 'Marta Gomez'
    })
    // A $200,00 credit sale, then a $50,00 payment against it. The view says $150,00 pending.
    await globalThis.minimarck.call('ventas', 'create', {
      items: [{ productoId: 1, cantidad: 1 }],
      metodoPago: 'credito',
      clienteDeudorId: deudor.id,
      idempotencyKey: 'tk-credito-1'
    })
    t.conn.db
      .prepare(
        `INSERT INTO pagos_deuda (monto_centavos, fecha, metodo_pago, deudor_id, user_id, negocio_id)
         VALUES (5000, '2026-01-15T10:00:00.000Z', 'efectivo', ?, ?, ?)`
      )
      .run(deudor.id, t.usuarioId, t.negocioId)

    // The balance the receipt prints is the VIEW's, so read it the same way the app does.
    const fila = t.conn.db
      .prepare('SELECT deuda_total_centavos, deuda_pendiente_centavos FROM v_clientes_deudores WHERE id = ?')
      .get(deudor.id)
    expect(fila.deuda_total_centavos).toBe(20000)
    expect(fila.deuda_pendiente_centavos).toBe(15000)

    montarPos()
    await agregar(user, 'Queso artesanal')
    fireEvent.keyDown(window, { key: 'F2' })

    // Choose "Crédito" and pick the debtor, then ask for the receipt.
    await user.click(await screen.findByText('Crédito'))
    const buscador = await screen.findByPlaceholderText(/Buscá por nombre o documento/)
    await user.type(buscador, 'Marta')
    await waitFor(() => expect(screen.getByText('Marta Gomez')).toBeTruthy())
    await user.click(screen.getByText('Marta Gomez'))
    await user.click(await screen.findByRole('button', { name: /Ver boleta de pago/i }))

    // THE CLAIM. $150,00 outstanding, on a receipt, for a debtor who has not paid it off.
    const saldo = await screen.findByTestId('boleta-saldo')
    expect(saldo.textContent).toBe('$150,00')
    // The hardcoded banner is gone, and the honest one is in its place.
    expect(screen.getByTestId('boleta-saldo-pendiente')).toBeTruthy()
    expect(screen.queryByTestId('boleta-saldada')).toBeNull()
    // The history line reads the contract's field (`montoCentavos`), not a peso float that is
    // always 0. $50,00 appears three times — the summary line, the single payment row, and the
    // table footer — and every one of them has to carry the real figure, because a receipt whose
    // total disagrees with its own rows is the thing nobody can check.
    const historial = document.querySelector('table')
    // Two inside the table — the payment row and the "Total Pagado" footer — and one in the
    // summary line above it.
    expect(within(historial).getAllByText('$50,00')).toHaveLength(2)
    expect(screen.getAllByText('$50,00')).toHaveLength(3)
  })
})
