// @vitest-environment jsdom
/**
 * THE TILL CLOSE, driven the way the cashier ends a day.
 *
 * THE POINT OF THIS FILE IS THE THREE FIGURES ON SCREEN. A cash count is a decision, and a decision
 * is only made while the operator can still see what they are deciding about — so the assertions
 * below are about the rendered TEXT ("Esperado", "$600,00", "Sin diferencia", "-$5,00"), not about
 * whether a `<div>` exists. The DB tests already prove the arithmetic; what is left to prove here
 * is that a person is SHOWN the arithmetic before it becomes a fact.
 *
 * WHY THE ACKNOWLEDGEMENT IS TESTED AND NOT JUST RENDERED: a difference that closes silently is the
 * whole defect this feature fixes, and a checkbox nobody has to tick is a checkbox that will not be
 * ticked. So one test drives the exact sequence — type, blocked, tick, editable, change the number,
 * blocked again — because the interesting failure is the LAST step, not the first.
 *
 * NO `jest-dom`. This package does not install it and never has, so `toBeInTheDocument` is not a
 * matcher here but an `Invalid Chai property` that reads like a broken assertion. Everything below
 * asserts on real DOM properties instead: `.textContent`, `.disabled`, `.checked`, `queryByTestId`.
 *
 * THE HARNESS is `reportes.spec.jsx`'s: the real screen, the real handler registry, a real migrated
 * SQLite file, and the Electron transport as the ONLY seam. `escenario` RECORDS every call, so a
 * claim about what the renderer asks main is a claim about a payload nobody would otherwise read.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ToastContainer } from 'react-toastify'

import { createRegistry } from '../../src/main/bridge/registry.js'
import { registerVentasHandlers } from '../../src/main/ipc/ventas.js'
import { registerCajasHandlers } from '../../src/main/ipc/cajas.js'
import { registerAuthHandlers } from '../../src/main/ipc/auth.js'
import { registerNegocioHandlers } from '../../src/main/ipc/negocio.js'
import { registerProductosHandlers } from '../../src/main/ipc/productos.js'
import { registerCategoriasHandlers } from '../../src/main/ipc/categorias.js'
import { registerDeudoresHandlers } from '../../src/main/ipc/deudores.js'
import { registerComprasHandlers } from '../../src/main/ipc/compras.js'
import { registerProveedoresHandlers } from '../../src/main/ipc/proveedores.js'
import { registerReportesHandlers, registerDashboardHandlers } from '../../src/main/ipc/reportes.js'

import { tienda, ctxDe, insertarProducto, iniciarSesion, abrirCaja } from '../db/fixtures/tienda.js'

import { AuthProvider } from '../../src/renderer/app/context/AuthContext.jsx'
import { CajaProvider } from '../../src/renderer/app/context/CajaContext.jsx'
import { NotificacionProvider } from '../../src/renderer/app/context/NotificacionContext.jsx'
import { ThemeProvider } from '../../src/renderer/app/context/ThemeContext.jsx'
import CierreDeCaja from '../../src/renderer/app/pages/CierreDeCaja.jsx'

/**
 * A shop with a 500,00 float and one 100,00 cash sale, so the drawer holds 600,00 and the screen
 * has a real number to be wrong about. The sale goes through the REAL `ventas.create` handler, so
 * the movement the close reconciles against was written by the same code the POS uses.
 */
function escenario({ conCaja = true } = {}) {
  const t = tienda()
  const ctx = ctxDe(t, t.negocioId, t.usuarioId)

  const registry = createRegistry()
  registerVentasHandlers(registry, { conn: t.conn })
  registerCajasHandlers(registry, { conn: t.conn })
  const { session: sesion } = iniciarSesion(t)
  registerAuthHandlers(registry, { conn: t.conn, session: sesion })
  registerNegocioHandlers(registry, { conn: t.conn })
  registerProductosHandlers(registry, { conn: t.conn })
  registerCategoriasHandlers(registry, { conn: t.conn })
  // The rest exist only so the WHOLE `App` can be mounted in the reachability test below: `App`
  // mounts `CajaGuard`, which reads the till through its own provider.
  registerDeudoresHandlers(registry, { conn: t.conn })
  registerComprasHandlers(registry, { conn: t.conn })
  registerProveedoresHandlers(registry, { conn: t.conn })
  registerReportesHandlers(registry, { conn: t.conn })
  registerDashboardHandlers(registry, { conn: t.conn })

  const llamadas = []
  globalThis.minimarck = {
    calls: llamadas,
    call: async (group, op, payload) => {
      const handler = registry.resolve(group, op)
      const entrada = { ...(payload ?? {}) }
      const res = await handler(entrada, ctx)
      llamadas.push({ group, op, payload: entrada })
      return res
    }
  }

  if (conCaja) {
    abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, saldoInicialCentavos: 50000 })
    const producto = insertarProducto(t, {
      negocioId: t.negocioId,
      usuarioId: t.usuarioId,
      overrides: {
        nombre: 'Queso',
        precio_centavos: 20000,
        precio_compra_centavos: 12000,
        stock_milli: 9000
      }
    })
    registry.resolve('ventas', 'create')(
      { items: [{ productoId: producto.id, cantidad: '0.5' }], metodoPago: 'efectivo', montoRecibido: 200 },
      ctx
    )
  }

  return { t, llamadas, ctx, registry }
}

const stores = []
afterEach(() => {
  cleanup()
  delete globalThis.minimarck
  while (stores.length > 0) stores.pop().cerrar()
})

function conProviders(contenido, inicial) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[inicial]}>
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

function montar() {
  return render(
    conProviders(
      <Routes>
        <Route path="/cierre-caja" element={<CierreDeCaja />} />
      </Routes>,
      '/cierre-caja'
    )
  )
}

const esperarPantalla = () => waitFor(() => expect(screen.queryByTestId('cierre-confirmar')).toBeTruthy())
const conteo = () => screen.queryByTestId('cierre-conteo')
const diferencia = () => screen.queryByTestId('cierre-diferencia')
const confirmar = () => screen.queryByTestId('cierre-confirmar')
const reconocer = () => screen.queryByTestId('cierre-reconocer')
const esperaTexto = (texto) => waitFor(() => expect(diferencia()?.textContent).toContain(texto))

describe('Cierre de caja — counting the drawer at the end of the day', () => {
  it('shows what the system says BEFORE it shows what the operator counted', async () => {
    const e = escenario()
    stores.push(e.t)

    montar()
    await esperarPantalla()

    // 500,00 float + 100,00 cash sale
    expect(screen.getByText('$600,00')).toBeTruthy()
    expect(screen.getByText(/Esperado \(sistema\)/)).toBeTruthy()

    // a count that matches says so, and does NOT invent a difference
    fireEvent.change(conteo(), { target: { value: '600' } })
    await esperaTexto('Sin diferencia')

    // ...and one that does not, with the sign that says which way it is off
    fireEvent.change(conteo(), { target: { value: '595' } })
    await esperaTexto('-$5,00')
    expect(screen.getByText('Faltante')).toBeTruthy()

    fireEvent.change(conteo(), { target: { value: '605' } })
    await esperaTexto('$5,00')
    expect(screen.getByText('Sobrante')).toBeTruthy()
  })

  it('cannot close without a count at all', async () => {
    const e = escenario()
    stores.push(e.t)

    montar()
    await esperarPantalla()

    // The whole purpose of this screen is to count. An empty field is not "a count of zero", it is
    // the task not being done yet, so the button stays shut.
    expect(confirmar().disabled).toBe(true)
  })

  it('a difference has to be acknowledged, and changing the count un-acknowledges it', async () => {
    const e = escenario()
    stores.push(e.t)

    montar()
    await esperarPantalla()

    fireEvent.change(conteo(), { target: { value: '595' } })
    await esperaTexto('-$5,00')

    // the acknowledgement is offered...
    await waitFor(() => expect(reconocer()).toBeTruthy())
    // ...and the close is BLOCKED until it is given
    expect(confirmar().disabled).toBe(true)

    fireEvent.click(reconocer())
    await waitFor(() => expect(confirmar().disabled).toBe(false))

    // The load-bearing half: a different number is a DIFFERENT claim. An acknowledgement is a
    // statement about "this drawer is short by 5,00", so changing the amount to 4,00 has to retract
    // it — otherwise the operator ticks a box once and then closes whatever they like.
    fireEvent.change(conteo(), { target: { value: '596' } })
    await esperaTexto('-$4,00')
    expect(reconocer().checked).toBe(false)
    expect(confirmar().disabled).toBe(true)
  })

  it('a drawer that matches does not ask for an acknowledgement', async () => {
    const e = escenario()
    stores.push(e.t)

    montar()
    await esperarPantalla()

    fireEvent.change(conteo(), { target: { value: '600' } })
    await esperaTexto('Sin diferencia')

    // There is nothing to recognise when the drawer is square, and a box an operator learns to
    // tick without reading is worse than no box at all.
    await waitFor(() => expect(confirmar().disabled).toBe(false))
    expect(reconocer()).toBeNull()
  })

  it('closes with the count as typed, and shows all three figures afterwards', async () => {
    const e = escenario()
    stores.push(e.t)

    montar()
    await esperarPantalla()

    fireEvent.change(conteo(), { target: { value: '595' } })
    fireEvent.change(screen.getByTestId('cierre-observaciones'), { target: { value: 'turno tarde' } })
    await esperaTexto('-$5,00')
    fireEvent.click(reconocer())
    await waitFor(() => expect(confirmar().disabled).toBe(false))
    fireEvent.click(confirmar())

    // the heading, not the toast: both say "Caja cerrada", and `getByText` would find two
await waitFor(() => expect(screen.getByRole('heading', { name: 'Caja cerrada' })).toBeTruthy())

    // The payload is the PESOS STRING the operator typed, not centavos the screen converted: the
    // repository is the only thing that turns text into an integer, and a screen that pre-rounded
    // would hide the parser's errors.
    const cierre = e.llamadas.find((c) => c.op === 'close')
    expect(cierre?.group).toBe('cajas')
    expect(cierre?.payload.conteo).toBe('595')
    expect(cierre?.payload.observaciones).toBe('turno tarde')
    expect(cierre?.payload.id).toBeGreaterThan(0)

    // all three figures, and the difference is NAMED, not just signed
    expect(screen.getByText('$600,00')).toBeTruthy()
    expect(screen.getByText('$595,00')).toBeTruthy()
    expect(screen.getByText('-$5,00')).toBeTruthy()
    expect(screen.getByText(/Registrado como faltante en 5\.4\.02/)).toBeTruthy()
    expect(screen.getByText('turno tarde')).toBeTruthy()
  })

  it('says there is nothing to count when no till is open, instead of bouncing to the POS', async () => {
    const e = escenario({ conCaja: false })
    stores.push(e.t)

    montar()

    await waitFor(() => expect(screen.getByText('No hay caja abierta')).toBeTruthy())
    expect(screen.getByText(/Abrí una caja/)).toBeTruthy()
    // no close button, because there is nothing to close
    expect(confirmar()).toBeNull()
  })

  it('is reachable from the menu, through the real router', async () => {
    // A screen nothing links to is a screen nobody finds. Mounting the whole `App` and CLICKING the
    // sidebar entry is the only version of this claim that is worth making: mounting the page alone
    // would pass with the route deleted, and asserting on `SECCIONES` would pass with the route
    // pointing at nothing.
    const e = escenario()
    stores.push(e.t)

    const { default: App } = await import('../../src/renderer/app/App.jsx')
    render(conProviders(<App />, '/pos'))

    const enlace = await screen.findByRole('link', { name: /Cierre de caja/ })
    expect(enlace.getAttribute('href')).toBe('/cierre-caja')

    fireEvent.click(enlace)
    await esperarPantalla()
    expect(screen.getByText(/Esperado \(sistema\)/)).toBeTruthy()
  })
})