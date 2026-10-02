// @vitest-environment jsdom
/**
 * THE REPORT SCREENS AND THE PANEL, driven the way an owner reads them.
 *
 * THE POINT OF THIS FILE IS THE RENDERED STRING. Every assertion below asks what the person
 * standing at the till actually SEES, not whether a table exists and not whether a field is
 * present. That distinction is the whole reason this file exists, and it was learned twice in this
 * codebase: `Number(null) === 0` made a first-day margin report claim a 40-point improvement, and
 * `ventas_detalles.negocio_id` does not exist, so five of the ten reports were one `no such column`
 * away from never running. A test that checked "a table exists" would have been green through
 * both. So: `expect(...).toBe('$700,00')` and `expect(...).toBe('3,5 kg')`, literally.
 *
 * THE HARNESS is the one `tests/ui/deudores.spec.jsx` established: the real React screen, the real
 * handler registry, a real migrated SQLite file with real sales posted through `ventas.create`. The
 * ONLY seam is the Electron transport, and `escenario` RECORDS every call rather than merely
 * forwarding it, so a claim about what the renderer may ask for is a claim about a payload nobody
 * looked at otherwise.
 *
 * AND EVERY FIGURE BELOW IS COUNTED BY HAND from the seeded data, not copied from a previous run.
 * `_shop` posts, through the real operations:
 *
 *   queso   $200,00/kg  cost $120,00/kg   stock 9 kg   (es_pesable: `unidad_medida` is `kg`)
 *   gaseosa  $50,00/u   cost  $30,00/u    stock 24 kg  (the fixture always writes `kg`)
 *   till    opened with $350,00 of float
 *
 *   1. CASH     1 kg queso    shelf 20.000   IVA extraído 3.471   (customer pays 20.000)
 *   2. WEIGHED  1,5 kg queso  shelf 30.000   IVA extraído 5.207   (customer pays 30.000)
 *   3. CREDIT   1 kg queso    shelf 20.000   IVA extraído 3.471   (owed by Ana Gómez)
 *   4. MANUAL EXPENSE $35,00 ("Bolsa de hielo") -> `5.4.01 Otros Gastos`, drawer − 3.500
 *
 * IVA IS EXTRACTED, NEVER ADDED (MATH-6). The shelf price is what the customer pays and what the
 * sale records as its total, so `total_centavos` equals `subtotal_centavos` and `iva_centavos` is
 * the tax INSIDE that price, `round(subtotal × 21/121)`. The sale total is 70.000 — not the 84.700
 * you get by adding tax on top of the shelf price, which is the bug MATH-6 exists to prevent.
 *
 * from which, in centavos:
 *
 *   ventas   count 3   subtotal 70.000   IVA 12.149   total 70.000   ticket 23.333
 *   costo    3,5 kg x 12.000                                          = 42.000
 *   bruta    70.000 − 42.000                                          = 28.000   margen 40,00%
 *   gastos   3.500   neta 28.000 − 3.500                              = 24.500   margen 35,00%
 *   caja     float 35.000 + 50.000 in − 3.500 out                     = 81.500
 *   deuda    the credit sale's shelf price                            = 20.000
 *   stock    queso 5,5 kg x 12.000 = 66.000 + gaseosa 24 kg x 3.000 = 72.000 -> 138.000
 *   ledger   ingresos 70.000 (4.1.01 carries the whole ticket)
 *            gastos  42.000 (CMV) + 3.500 (5.4.01)                   = 45.500
 *            resultado                                                  = 24.500
 *
 * Note what the ledger figures are NOT: the statement's `gastos` includes the cost of merchandise
 * (`5.1.1`), because a sale debits it, while the managerial report's `gananciaNeta` subtracts only
 * the owner's own outgoings from a gross profit that already had the cost removed. Two screens, two
 * honest readings, and `DIVERGENCES.md` says so out loud.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

import {
  tienda,
  ctxDe,
  insertarProducto,
  insertarDeudor,
  iniciarSesion,
  abrirCaja
} from '../db/fixtures/tienda.js'

import { AuthProvider } from '../../src/renderer/app/context/AuthContext.jsx'
import { CajaProvider } from '../../src/renderer/app/context/CajaContext.jsx'
import { NotificacionProvider } from '../../src/renderer/app/context/NotificacionContext.jsx'
import { ThemeProvider } from '../../src/renderer/app/context/ThemeContext.jsx'
import Reportes from '../../src/renderer/app/pages/Reportes.jsx'
import Panel from '../../src/renderer/app/pages/Panel.jsx'

function escenario() {
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
      // SHALLOW COPY, because a call that mutates its own argument would otherwise be mutating the
      // caller's object and the recorded `llamadas` entry would show the MUTATED version — the
      // spy would report what the code ended up with, not what it was given.
      const entrada = { ...(payload ?? {}) }
      const res = await handler(entrada, ctx)
      llamadas.push({ group, op, payload: entrada })
      return res
    }
  }
  return { t, llamadas, ctx, registry, sesion }
}

const stores = []
afterEach(() => {
  cleanup()
  delete globalThis.minimarck
  while (stores.length > 0) stores.pop().cerrar()
})

/**
 * Mount a route, the way `main.jsx` mounts the app.
 *
 * `<Routes>` with the path the operator is actually going to, and the screen inside — so a deep
 * link is a real test of the deep link and not a component render with the wrong params. The
 * providers are the app's own, and `ToastContainer` is here for the reason `deudores.spec.jsx`
 * states at length: a `toast` call with no container renders NOTHING, so a harness without one
 * cannot tell "the report said so" from "the screen threw before it could say so".
 */
/**
 * The app's own provider tree, in the order `main.jsx` mounts it.
 *
 * Every one of them is here because some screen or context in this app reads it, and a test that
 * omitted one would be mounting a shell the operator never gets. `ToastContainer` is the one
 * `deudores.spec.jsx` argues for at length: a `toast` with no container renders NOTHING, so its
 * absence cannot be told apart from a screen that threw before it could speak.
 */
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

function montarEn(ruta, elemento, { inicial = ruta } = {}) {
  return render(
    conProviders(
      <Routes>
        <Route path={ruta} element={elemento} />
      </Routes>,
      inicial
    )
  )
}

/**
 * The WHOLE SHELL, at a deep link. This is the only way to test the security gate, because the gate
 * is one level above the screen: `App` decides whether `<Routes>` exists at all.
 */
async function montarApp(ruta) {
  const { default: App } = await import('../../src/renderer/app/App.jsx')
  return render(conProviders(<App />, ruta))
}

const montarReporte = (clave) => montarEn('/reportes/:reporte', <Reportes />, { inicial: `/reportes/${clave}` })
const montarPanel = () => montarEn('/dashboard', <Panel />)

/**
 * The throwable a call produced, or a failure that says it did not throw at all.
 *
 * Copied from the convention `tests/db/auth-local.spec.js` established, and for the same reason:
 * `IpcError` carries its contract in `.code`, so an assertion written against the MESSAGE is an
 * assertion about prose. The last line is the important one — without it, a call that silently
 * succeeded would return `undefined` and the next `expect(...).code` would read as a failure of
 * the wrong thing, four lines away from the cause.
 */
function falla(fn) {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error('se esperaba un error y la llamada NO lanzó')
}

/** The till, a customer, two products, three sales and the owner's own expense. */
async function _shop(t) {
  const caja = abrirCaja(t, {
    negocioId: t.negocioId,
    usuarioId: t.usuarioId,
    saldoInicialCentavos: 35000
  })

  const queso = insertarProducto(t, {
    negocioId: t.negocioId,
    usuarioId: t.usuarioId,
    overrides: { nombre: 'Queso artesanal', precio_centavos: 20000, precio_compra_centavos: 12000, stock_milli: 9000 }
  })
  const gaseosa = insertarProducto(t, {
    negocioId: t.negocioId,
    usuarioId: t.usuarioId,
    overrides: { nombre: 'Gaseosa 2L', precio_centavos: 5000, precio_compra_centavos: 3000, stock_milli: 24000 }
  })
  const deudor = insertarDeudor(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, nombre: 'Ana Gómez' })

  await globalThis.minimarck.call('ventas', 'create', {
    items: [{ productoId: queso.id, cantidad: '1' }],
    metodoPago: 'efectivo'
  })
  await globalThis.minimarck.call('ventas', 'create', {
    items: [{ productoId: queso.id, cantidad: '1.5' }],
    metodoPago: 'efectivo'
  })
  const credito = await globalThis.minimarck.call('ventas', 'create', {
    items: [{ productoId: queso.id, cantidad: '1' }],
    metodoPago: 'credito',
    clienteDeudorId: deudor.id
  })

  await globalThis.minimarck.call('cajaMovimientos', 'create', {
    cajaId: caja.id,
    tipo: 'egreso',
    concepto: 'Bolsa de hielo',
    monto: '35.00'
  })

  return { queso, gaseosa, deudor, credito, caja }
}

/** The range every report is asked for, in the arguments' own vocabulary. */
const RANGO = { fechaInicio: '2026-01-01', fechaFin: '2030-12-31' }

/** Set both date fields and press Consultar, the way an operator does. */
async function consultarRango(user, desde = RANGO.fechaInicio, hasta = RANGO.fechaFin) {
  const d = screen.getByTestId('fecha-desde')
  const h = screen.getByTestId('fecha-hasta')
  await user.clear(d)
  await user.type(d, desde)
  await user.clear(h)
  await user.type(h, hasta)
  await user.click(screen.getByTestId('consultar'))
}

/** Consult a report that takes no dates: the till, the shelf. */
async function consultar(user) {
  await user.click(screen.getByTestId('consultar'))
}

/** Wait until the screen has finished and rendered the report. */
const listo = () => waitFor(() => expect(document.body.textContent).not.toContain('Consultando'))

/**
 * THE TWO THINGS THAT MUST NEVER BE PRINTED, as one helper so every screen is held to the same
 * standard instead of the ones an author remembered.
 */
function sinBasura() {
  const texto = document.body.textContent
  for (const marca of ['NaN', 'undefined', 'Infinity', '[object']) {
    const idx = texto.indexOf(marca)
    // The 120 characters around the offending word, so a failure names the figure instead of
    // making the next reader grep the whole DOM for it.
    expect(marca, `"${marca}" en: …${texto.slice(Math.max(0, idx - 100), idx + 40)}…`).not.toBe('')
    if (idx >= 0) {
      throw new Error(`"${marca}" impreso en: …${texto.slice(Math.max(0, idx - 100), idx + 40)}…`)
    }
  }
  // A bare four-or-more digit integer in a money cell, a quantity cell or a count cell is the
  // stored thousandth wearing no unit: the cell should read `1,5 kg`, `$1.380,00` or `3`. Dates
  // are excluded by construction, because a date is not in a cell.
  const crudos = Array.from(document.querySelectorAll('.td, .stat-card .value'))
    .map((n) => n.textContent.trim())
    .filter((t) => /^\d{4,}$/.test(t))
  expect(crudos).toEqual([])
}

describe('los reportes, leídos como los lee el dueño', () => {
  let user
  beforeEach(() => {
    user = userEvent.setup()
  })

  it('VENTAS: el total lleva coma decimal, el IVA sale por venta y el ticket se lee', async () => {
    const { t } = escenario()
    stores.push(t)
    await _shop(t)
    montarReporte('ventas')
    await consultarRango(user)

    // The shelf price is the total: 20.000 + 30.000 + 20.000 = 70.000 centavos. IVA is EXTRACTED
    // from it, never added on top (MATH-6), so the total is the subtotal — 70000, not 84700. The
    // assertion is the exact string, because a matcher loosened to "contains 700" would also pass
    // against `$700.000,00`.
    await waitFor(() => expect(screen.getByTestId('total-ingresos').textContent).toBe('$700,00'))
    expect(screen.getByTestId('cantidad-ventas').textContent).toBe('3')
    // 70.000 of shelf price − 42.000 of stock at cost (3,5 kg × $120).
    expect(screen.getByTestId('ganancia-bruta').textContent).toBe('$280,00')

    const tabla = await screen.findByTestId('tabla-ventas')
    const filas = within(tabla).getAllByRole('row').slice(1)
    expect(filas).toHaveLength(3)

    // EVERY ROW'S WHOLE MONEY TAIL, ASSERTED POSITIONALLY. Counted matches were the wrong tool
    // here and would have been wrong in a way that hid the real finding: under MATH-6 the shelf
    // price IS the total, so `Subtotal` and `Total` read the SAME number on every line, and
    // `getByText('$300,00')` matches two cells rather than one. A count like `getAllByText($200,00)
    // .length === 2` passes while the columns are in the wrong order.
    //
    // Columns: 0 folio · 1 fecha · 2 método · 3 cliente · 4 vendedor · 5 subtotal · 6 IVA · 7 total.
    const filasDatos = filas.map((f) => within(f).getAllByRole('cell').map((c) => c.textContent))
    for (const f of filasDatos) expect(f).toHaveLength(8)

    // The 1,5 kg weighed line, keyed by the IVA that only IT can have: round(30.000 × 21/121)
    // = 5.207, extracted from the price rather than added on top.
    const pesada = filasDatos.find((f) => f[6] === '$52,07')
    expect(pesada, 'la línea de 1,5 kg, con su IVA extraído').toBeTruthy()
    expect(pesada.slice(5)).toEqual(['$300,00', '$52,07', '$300,00'])
    expect(pesada[2]).toBe('Efectivo')
    expect(pesada[3]).toBe('Mostrador')

    // The two 1 kg lines: subtotal 20.000 and round(20.000 × 21/121) = 3.471 each.
    const deUnKilo = filasDatos.filter((f) => f[6] === '$34,71')
    expect(deUnKilo).toHaveLength(2)
    for (const f of deUnKilo) expect(f.slice(5)).toEqual(['$200,00', '$34,71', '$200,00'])

    // "Efectivo", not "efectivo" and not "Cash": the method is a word the customer said. And the
    // credit sale is the third line, and it is still a sale — it is only the DRAWER it never
    // touches.
    expect(filasDatos.map((f) => f[2])).toEqual(expect.arrayContaining(['Efectivo', 'Efectivo', 'Crédito']))
    expect(filasDatos.filter((f) => f[2] === 'Efectivo')).toHaveLength(2)
    const credito = filasDatos.find((f) => f[2] === 'Crédito')
    expect(credito[3]).toBe('Ana Gómez')
    sinBasura()
  })

  it('PRODUCTOS: 3500/1000 de kilo se lee "3,5 kg", nunca 3500', async () => {
    const { t } = escenario()
    stores.push(t)
    await _shop(t)
    montarReporte('productos')
    await consultarRango(user)

    await waitFor(() => expect(screen.getByTestId('cantidad-productos').textContent).toBe('1'))
    // The column is the LINE subtotals, net of tax: 20.000 + 30.000 + 20.000.
    expect(screen.getByTestId('ingresos-productos').textContent).toBe('$700,00')

    const tabla = await screen.findByTestId('tabla-productos')
    // 3,5 kg. The stored integer is 3500 and the receipt form would be "3 500 g"; the report says
    // `3,5 kg` because that is the form the owner reads everywhere else, and because it is the one
    // that can be typed back into a sale.
    expect(within(tabla).getByText('3,5 kg')).toBeTruthy()
    expect(within(tabla).queryByText('3500')).toBeNull()
    expect(within(tabla).queryByText('3 500 g')).toBeNull()
    sinBasura()
  })

  it('PRODUCTOS: un kilo entero se lee "1 kg", no "1.000 g" y no "1000"', async () => {
    const { t } = escenario()
    stores.push(t)
    abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, saldoInicialCentavos: 35000 })
    const queso = insertarProducto(t, {
      negocioId: t.negocioId,
      usuarioId: t.usuarioId,
      overrides: { nombre: 'Queso de campo', precio_centavos: 20000, stock_milli: 5000 }
    })
    await globalThis.minimarck.call('ventas', 'create', {
      items: [{ productoId: queso.id, cantidad: '1' }],
      metodoPago: 'efectivo'
    })
    montarReporte('productos')
    await consultarRango(user)

    const tabla = await screen.findByTestId('tabla-productos')
    expect(within(tabla).getByText('1 kg')).toBeTruthy()
    expect(within(tabla).queryByText('1.000')).toBeNull()
    expect(within(tabla).queryByText('1000')).toBeNull()
    sinBasura()
  })

  it('CAJA: el cajón y la cuenta 1.1.01 dicen lo mismo, y lo dicen con el mismo número', async () => {
    const { t } = escenario()
    stores.push(t)
    await _shop(t)
    montarReporte('caja')

    // No date inputs at all: a till is a session, not a period.
    expect(screen.queryByTestId('fecha-desde')).toBeNull()
    await consultar(user)

    await waitFor(() => expect(screen.getByTestId('caja-coincide').textContent).toBe('Coinciden'))
    // $350,00 de fondo + $200,00 + $300,00 en efectivo − $35,00 de gasto propio = $815,00. The two
    // cash sales that reach the drawer are the shelf price, because IVA is inside it (MATH-6).
    expect(screen.getByTestId('saldo-cajon').textContent).toBe('$815,00')
    expect(screen.getByTestId('saldo-cuenta').textContent).toBe('$815,00')
    expect(screen.getByTestId('saldo-cajon').textContent).toBe(screen.getByTestId('saldo-cuenta').textContent)
    // "Saldo final" is the SUM OF THE MOVEMENTS, and it includes the float — because opening the
    // till writes an `ingreso` movement for the change, exactly as the web does in `abrirCaja`
    // ("APERTURA DE CAJA") and as the web's `reporteCaja` then sums it. This was a real
    // disagreement I had to settle against the web rather than pick the number that looked
    // tidier: 35.000 + 50.000 − 3.500 = $815,00, the same figure as the drawer and 1.1.01. They
    // AGREE, and that agreement is the claim worth making: the movements listed in the table add
    // up to the money in the drawer.
    expect(screen.getByTestId('saldo-final').textContent).toBe('$815,00')

    const tabla = await screen.findByTestId('tabla-caja')
    expect(within(tabla).getByText('Bolsa de hielo')).toBeTruthy()
    expect(within(tabla).getByText('−$35,00')).toBeTruthy()
    sinBasura()
  })

  it('CAJA: con la caja cerrada el saldo es $0,00 y no se inventa un saldo de negocio', async () => {
    const { t } = escenario()
    stores.push(t)
    const { caja } = await _shop(t)
    // Closing needs the till's id. `cajas.close` validates it and throws `CAJA_ID_INVALIDO` on
    // `undefined` — which is the right behaviour for a handler that closes a named till, and the
    // reason this line names the till instead of closing "whatever is open".
    await globalThis.minimarck.call('cajas', 'close', { id: caja.id })
    montarReporte('caja')
    await consultar(user)

    // `saldoGeneral` is the whole business's cash, so the drawer and `1.1.01` still agree after
    // the till is closed; and the report says the till is closed instead of pretending the shop
    // has no money.
    await waitFor(() => expect(screen.getByTestId('caja-coincide').textContent).toBe('Coinciden'))
    expect(screen.getByTestId('saldo-cajon').textContent).toBe('$0,00')
    // The words are a SIBLING of the figure, in the card's note, not the figure itself. Asserting
    // them on `saldo-cajon` would be an assertion about a different string that happens to live in
    // the same card, which is the check that stays green while the sentence goes missing.
    expect(screen.getByTestId('saldo-cajon-nota').textContent).toBe('Sin caja abierta')
    sinBasura()
  })

  it('DEUDORES: la deuda se imprime positiva y con el nombre del cliente', async () => {
    const { t } = escenario()
    stores.push(t)
    await _shop(t)
    montarReporte('deudores')
    await consultarRango(user)

    await waitFor(() => expect(screen.getByTestId('cantidad-deudores').textContent).toBe('1'))
    // The credit sale's full ticket, POSITIVE. The web's dashboard printed -$80,00 for money the
    // shop is owed; a liability that reads negative is a liability the owner cannot act on.
    expect(screen.getByTestId('total-pendiente').textContent).toBe('$200,00')
    expect(screen.getByTestId('total-pendiente').textContent).not.toContain('-')

    const tabla = await screen.findByTestId('tabla-deudores')
    expect(within(tabla).getByText('Ana Gómez')).toBeTruthy()
    expect(within(tabla).getAllByText('$200,00').length).toBeGreaterThan(0)
    sinBasura()
  })

  it('DEUDORES: un límite sin configurar dice "sin límite", no $0,00', async () => {
    const { t } = escenario()
    stores.push(t)
    abrirCaja(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, saldoInicialCentavos: 35000 })
    const queso = insertarProducto(t, {
      negocioId: t.negocioId,
      usuarioId: t.usuarioId,
      overrides: { nombre: 'Queso', precio_centavos: 20000, stock_milli: 5000 }
    })
    // `limiteCreditoCentavos: null` is the real NULL, not a zero.
    const deudor = insertarDeudor(t, {
      negocioId: t.negocioId,
      usuarioId: t.usuarioId,
      nombre: 'Bruno Sin Límite',
      limiteCreditoCentavos: null
    })
    await globalThis.minimarck.call('ventas', 'create', {
      items: [{ productoId: queso.id, cantidad: '1' }],
      metodoPago: 'credito',
      clienteDeudorId: deudor.id
    })
    montarReporte('deudores')
    await consultarRango(user)

    const tabla = await screen.findByTestId('tabla-deudores')
    // A limit of $0,00 would read as "this customer may not buy anything", which is a rule nobody
    // set. The words are the whole point of the NULL.
    expect(within(tabla).getByText('sin límite')).toBeTruthy()
    expect(within(tabla).queryByText('$0,00')).toBeNull()
    sinBasura()
  })

  it('GASTOS: el gasto del dueño aparece y las ventas NO', async () => {
    const { t } = escenario()
    stores.push(t)
    await _shop(t)
    montarReporte('gastos')
    await consultarRango(user)

    await waitFor(() => expect(screen.getByTestId('total-gastos').textContent).toBe('$35,00'))
    expect(screen.getByTestId('cantidad-gastos').textContent).toBe('1')
    const tabla = await screen.findByTestId('tabla-gastos')
    expect(within(tabla).getByText('Bolsa de hielo')).toBeTruthy()
    // Two cash sales are in the drawer and neither is an expense. Counting them here is the bug
    // the repository's `origen = 'manual'` rule exists to prevent.
    expect(within(tabla).queryByText(/Venta/)).toBeNull()
    sinBasura()
  })

  it('COMPRAS: una compra a crédito queda pendiente y NO cuenta en el reporte', async () => {
    const { t } = escenario()
    stores.push(t)
    await _shop(t)

    const prov = await globalThis.minimarck.call('proveedores', 'create', {
      nombre: 'Distribuidora del Sur',
      ruc: '30-11111111-7'
    })
    await globalThis.minimarck.call('compras', 'create', {
      proveedorId: prov.id,
      metodoPago: 'credito',
      items: [{ productoId: 1, cantidad: '2', precioUnitario: '10.00' }]
    })

    montarReporte('compras')
    await consultarRango(user)

    // Zero. A purchase on account is created `pendiente`, and `reportes.purchases` counts only
    // `completada` — the same filter the web applies. The payable is on the ledger either way;
    // this report is about what was BOUGHT, not about what was paid.
    await waitFor(() => expect(screen.getByTestId('total-compras').textContent).toBe('$0,00'))
    expect(screen.getByTestId('cantidad-compras').textContent).toBe('0')
    expect(await screen.findByTestId('tabla-compras-vacio')).toBeTruthy()
    expect(await screen.findByTestId('tabla-compras-proveedor-vacio')).toBeTruthy()
    sinBasura()
  })

  it('STOCK: el stock que quedó sale en su unidad y el inventario se valuing en dinero', async () => {
    const { t } = escenario()
    stores.push(t)
    await _shop(t)
    montarReporte('stock')

    // No dates: a stock report about a range of days is a different thing.
    expect(screen.queryByTestId('fecha-desde')).toBeNull()
    await consultar(user)

    await waitFor(() => expect(screen.getByTestId('total-productos-stock').textContent).toBe('2'))
    const tabla = await screen.findByTestId('tabla-stock')
    // 9 kg − 3,5 kg = 5,5 kg, and 24 kg of the other one untouched.
    expect(within(tabla).getByText('5,5 kg')).toBeTruthy()
    expect(within(tabla).getByText('24 kg')).toBeTruthy()
    // 5,5 kg x $120,00 = $660,00 and 24 kg x $30,00 = $720,00. THE THOUSANDS SEPARATOR, asserted
    // literally, because `formatCents` grouping is the one thing money formatting can get wrong in a
    // way that still looks like a number.
    expect(screen.getByTestId('valor-inventario').textContent).toBe('$1.380,00')
    // The fixture's minimum is 5000 milli for both, and neither is at or below it.
    expect(screen.getByTestId('stock-bajo').textContent).toBe('0')
    expect(screen.getByTestId('sin-stock').textContent).toBe('0')
    sinBasura()
  })

  it('GERENCIAL: margen, neto y ticket salen bien, y el período vacío es un guion', async () => {
    const { t } = escenario()
    stores.push(t)
    await _shop(t)
    montarReporte('gerencial')
    await consultarRango(user)

    // `totalVentasCentavos` sums the tickets, and under MATH-6 the ticket IS the shelf price, so
    // it reads 70.000 — the same number the sales report shows. IVA lives inside it, extracted,
    // never added on top.
    await waitFor(() => expect(screen.getByTestId('ger-ventas').textContent).toBe('$700,00'))
    // 70.000 / 3 tickets = 23.333,33 centavos, rounded half away from zero to 23.333.
    expect(screen.getByTestId('ger-ticket').textContent).toBe('$233,33')
    expect(screen.getByTestId('ger-ganancia-bruta').textContent).toBe('$280,00')
    expect(screen.getByTestId('ger-margen').textContent).toBe('40,00%')
    expect(screen.getByTestId('ger-gastos').textContent).toBe('$35,00')
    expect(screen.getByTestId('ger-ganancia-neta').textContent).toBe('$245,00')

    // The previous window of a five-year range is empty, so EVERY variation has no base to divide
    // by. Twelve rows, twelve dashes — not +0,0% and not +40 pp. This is the `Number(null)` bug,
    // and asserting it twelve times over is cheaper than explaining it once more.
    const filas = document.querySelectorAll('[data-testid^="comparativo-"]')
    expect(filas.length).toBe(12)
    for (const fila of filas) {
      const celdas = within(fila).getAllByRole('cell')
      expect(celdas[celdas.length - 1].textContent.trim(), fila.dataset.testid).toBe('—')
    }
    // A row that DOES have a number prints that number, with its own format.
    const ventas = within(document.querySelector('[data-testid="comparativo-Ventas"]')).getAllByRole('cell')
    expect(ventas[1].textContent).toBe('$700,00')
    expect(ventas[2].textContent).toBe('$0,00')
    sinBasura()
  })

  it('ANÁLISIS: sin costo cargado no es margen cero, y el semáforo tiene las ocho filas', async () => {
    const { t } = escenario()
    stores.push(t)
    await _shop(t)
    // A product sold at a cost of 0 has no margin at all, and the report must not call that 0,00%.
    const sinCosto = insertarProducto(t, {
      negocioId: t.negocioId,
      usuarioId: t.usuarioId,
      overrides: { nombre: 'Producto sin costo', precio_centavos: 10000, precio_compra_centavos: 0, stock_milli: 5000 }
    })
    await globalThis.minimarck.call('ventas', 'create', {
      items: [{ productoId: sinCosto.id, cantidad: '1' }],
      metodoPago: 'efectivo'
    })
    montarReporte('analisis')
    await consultarRango(user)

    for (const fila of [
      'semaforo-margen',
      'semaforo-ventas',
      'semaforo-gastos',
      'semaforo-ticket',
      'semaforo-stock',
      'semaforo-deudores',
      'semaforo-margen-bajo',
      'semaforo-no-positivos'
    ]) {
      expect(document.querySelector(`[data-testid="${fila}"]`), fila).toBeTruthy()
    }

    const tabla = await screen.findByTestId('tabla-no-positivos')
    expect(within(tabla).getByText('Producto sin costo')).toBeTruthy()
    expect(within(tabla).getByText('sin costo cargado')).toBeTruthy()
    // And the gain of an unknown cost is a dash, not $0,00: nothing was measured.
    expect(within(tabla).getByText('—')).toBeTruthy()
    expect(within(tabla).queryByText('0,00%')).toBeNull()
    // A kilo product is sold in kilos here too, not in "unidades".
    expect(within(tabla).getByText('1 kg')).toBeTruthy()
    sinBasura()
  })

  it('ESTADO DE RESULTADOS: sale del libro, y el costo de mercadería es un gasto más', async () => {
    const { t } = escenario()
    stores.push(t)
    await _shop(t)
    montarReporte('resultados')
    await consultarRango(user)

    // Revenue is credited with the WHOLE ticket, which under MATH-6 is the shelf price: 70.000.
    // The `gastos` side is 45.500: the owner's 3.500 AND the 42.000 of merchandise the sales
    // debited to `5.1.1`. A statement that left the cost of goods out would report a shop that
    // sells 3,5 kg of cheese as profitable $665,00.
    await waitFor(() => expect(screen.getByTestId('res-ingresos').textContent).toBe('$700,00'))
    expect(screen.getByTestId('res-gastos').textContent).toBe('$455,00')
    expect(screen.getByTestId('res-resultado').textContent).toBe('$245,00')

    const cuentas = await screen.findByTestId('tabla-cuentas')
    // The account codes are printed, because a statement an owner cannot reconcile by code is a
    // statement they take on faith.
    expect(within(cuentas).getByText('1.1.01')).toBeTruthy()
    expect(within(cuentas).getByText('5.4.01')).toBeTruthy()
    sinBasura()
  })

  it('un período vacío lo dice en español, y no llena la pantalla de ceros', async () => {
    const { t } = escenario()
    stores.push(t)
    await _shop(t)
    montarReporte('ventas')
    await consultarRango(user, '2030-01-01', '2030-01-31')

    // The screen must SAY the period had nothing in it. `$0,00` for "ventas" is a defensible
    // truth; `$0,00` on every single line under an empty table is a broken report.
    const vacio = await screen.findByTestId('tabla-ventas-vacio')
    expect(vacio.textContent).toBe('No hubo ventas en el período consultado.')
    expect(screen.getByTestId('total-ingresos').textContent).toBe('$0,00')
    expect(screen.getByTestId('cantidad-ventas').textContent).toBe('0')
    sinBasura()
  })

  it('NADA DE LOS DIEZ PANTALLAS IMPRIME NaN, undefined, Infinity ni un entero crudo de miles', async () => {
    const { t } = escenario()
    stores.push(t)
    await _shop(t)

    const claves = [
      'ventas',
      'productos',
      'caja',
      'deudores',
      'compras',
      'stock',
      'gastos',
      'gerencial',
      'analisis',
      'resultados'
    ]
    for (const clave of claves) {
      cleanup()
      montarReporte(clave)
      if (screen.queryByTestId('fecha-desde')) await consultarRango(user)
      else await consultar(user)
      await listo()
      try {
        sinBasura()
      } catch (err) {
        err.message = `[${clave}] ${err.message}`
        throw err
      }
    }
  })
})

describe('las rutas, como llega un enlace profundo', () => {
  let user
  beforeEach(() => {
    user = userEvent.setup()
  })

  it('cada uno de los DIEZ reportes se abre por URL y queda marcado como activo', async () => {
    const { t } = escenario()
    stores.push(t)
    await _shop(t)

    for (const clave of ['ventas', 'productos', 'caja', 'deudores', 'compras', 'stock', 'gastos', 'gerencial', 'analisis', 'resultados']) {
      cleanup()
      montarReporte(clave)
      // The URL is the single source of truth: the tab marked active is the report on screen.
      expect(screen.getByTestId(`tab-${clave}`).getAttribute('aria-selected'), clave).toBe('true')
      if (screen.queryByTestId('fecha-desde')) await consultarRango(user)
      else await consultar(user)
      await listo()
      expect(screen.queryByTestId('sin-consultar'), clave).toBeNull()
    }
  })

  it('los DIEZ tabs están en la pantalla, cada uno con su operación del contrato', () => {
    const { t } = escenario()
    stores.push(t)
    montarReporte('ventas')
    for (const clave of ['ventas', 'productos', 'caja', 'deudores', 'compras', 'stock', 'gastos', 'gerencial', 'analisis', 'resultados']) {
      expect(screen.getByTestId(`tab-${clave}`), clave).toBeTruthy()
    }
  })

  it('cambiar de pestaña con un reporte YA consultado no mezcla datos ni borra la pantalla', async () => {
    const { t } = escenario()
    stores.push(t)
    await _shop(t)
    // The render result is kept on purpose: `container` is the node React mounted into, and an
    // unmounted tree is exactly an empty one. That is what the assertion below checks.
    const vista = montarReporte('ventas')
    await consultarRango(user)
    await listo()
    expect(screen.queryByTestId('sin-consultar')).toBeNull()
    expect(screen.getByTestId('total-ingresos').textContent).not.toBe('$0,00')

    // THE RULE. The screen keeps the consulted answer in `datos` and which report it belongs to in
    // `datosTab`, and `datosDeEsta` only hands the answer to a body when those two agree. Without
    // that pairing the NEW report's component is rendered with the PREVIOUS report's payload — and
    // those payloads are not interchangeable: `ventas` carries `movimientos` while `gastos` reads
    // `detalle`, so a crossed answer is not "wrong numbers", it is a body reading a field that
    // isn't there.
    //
    // WHAT THIS TEST DOES AND DOES NOT PROVE, because it is worth being exact. In a real window
    // the crossed render is fatal: the body threw, and the till's screen went blank. That is what
    // `npm run drive:reportes` saw, and it is the gate that covers it — it drives the actual
    // Electron window and clicks real tabs.
    //
    // This test cannot reproduce the crash, and claiming otherwise would be a lie in a comment:
    // under `act()`, React coalesces the router update and the clearing effect, so the crossed
    // frame never commits here — a probe on `Tabla` confirms it is never even called with an
    // undefined `filas`. So this asserts the INVARIANT the guard exists to keep, which is what jsdom
    // can see honestly: each tab shows its own answer, no other report's figures leak onto it, and
    // the tree survives the switch in both directions.
    await user.click(screen.getByTestId('tab-gastos'))

    // The new tab says it has not been consulted yet — not "here are the sales figures".
    await waitFor(() => expect(screen.queryByTestId('sin-consultar')).toBeTruthy())
    expect(screen.queryByTestId('total-ingresos')).toBeNull()
    expect(screen.queryByTestId('tabla-ventas')).toBeNull()
    // The tab strip is still a whole screen, not a fragment of one.
    expect(vista.container.children.length).toBeGreaterThan(0)
    expect(screen.getByTestId('tab-gastos')).toBeTruthy()

    // Consult the SECOND report and go back: now both tabs hold an answer, which is the case where
    // a stale pairing would show one report's numbers under the other's name.
    await consultar(user)
    await listo()
    expect(screen.queryByTestId('sin-consultar')).toBeNull()
    expect(screen.getByTestId('total-gastos').textContent).not.toBe('$0,00')

    await user.click(screen.getByTestId('tab-ventas'))
    await waitFor(() => expect(screen.queryByTestId('sin-consultar')).toBeTruthy())
    expect(screen.queryByTestId('total-gastos')).toBeNull()
    expect(vista.container.children.length).toBeGreaterThan(0)

    // ...and going forward once more brings the FIRST answer back, intact and its own.
    await consultarRango(user)
    await listo()
    expect(screen.getByTestId('total-ingresos').textContent).not.toBe('$0,00')
    expect(screen.queryByTestId('total-gastos')).toBeNull()

    sinBasura()
  })

  it('una ruta que no es un reporte cae en Ventas en vez de mostrar una pantalla vacía', () => {
    const { t } = escenario()
    stores.push(t)
    montarEn('/reportes/:reporte', <Reportes />, { inicial: '/reportes/inventado' })
    expect(screen.getByTestId('tab-ventas').getAttribute('aria-selected')).toBe('true')
  })
})

describe('el negocio, y quién tiene derecho a preguntar por él', () => {
  let user
  beforeEach(() => {
    user = userEvent.setup()
  })

  it('NINGÚN payload de un reporte lleva negocioId: el negocio sale de la sesión', async () => {
    const { t, llamadas } = escenario()
    stores.push(t)
    await _shop(t)

    for (const clave of ['ventas', 'productos', 'deudores', 'compras', 'gastos', 'gerencial', 'analisis', 'resultados']) {
      cleanup()
      montarReporte(clave)
      await consultarRango(user)
      await listo()
    }
    for (const clave of ['caja', 'stock']) {
      cleanup()
      montarReporte(clave)
      await consultar(user)
      await listo()
    }
    cleanup()
    montarPanel()
    await waitFor(() => expect(screen.getByTestId('panel-ventas')).toBeTruthy())

    const lecturas = llamadas.filter((c) => (c.group === 'reportes' || c.group === 'dashboard') && c.op !== 'exportsCsv')
    expect(lecturas.length).toBeGreaterThanOrEqual(11)
    for (const llamada of lecturas) {
      // The renderer cannot express a tenant. If this ever fails, a screen could be pointed at
      // another business by a payload, which is the one thing this file must make impossible.
      expect(llamada.payload, `${llamada.group}.${llamada.op} envió negocioId`).not.toHaveProperty('negocioId')
      expect(llamada.payload.tenantId, `${llamada.group}.${llamada.op} envió tenantId`).toBeUndefined()
    }
  })

  it('un intento de forgear el negocio en el payload no cambia una sola cifra', async () => {
    const { t, llamadas } = escenario()
    stores.push(t)
    await _shop(t)
    montarReporte('ventas')
    await consultarRango(user)
    await listo()

    const honesto = screen.getByTestId('total-ingresos').textContent
    const antes = llamadas.length

    // A hand-crafted frame that tries to name somebody else's business. The transport does not
    // strip it — `ipc.js` removes `negocioId` from renderer payloads, but a compromised preload is
    // not the renderer — so what proves the isolation is that MAIN never reads it.
    await globalThis.minimarck.call('reportes', 'sales', {
      ...RANGO,
      negocioId: 999999,
      actorId: 'otro usuario'
    })

    expect(honesto).toBe('$700,00')
    expect(screen.getByTestId('total-ingresos').textContent).toBe('$700,00')
    expect(llamadas.length).toBe(antes + 1)
    expect(llamadas[llamadas.length - 1].payload.negocioId).toBe(999999)
  })

  it('main responde TENANT_REQUIRED si un renderer sin sesión pide un reporte o el panel', async () => {
    const { t } = escenario()
    stores.push(t)
    // No `negocioId`: exactly what an unauthenticated frame produces. The registry resolves the
    // SAME handler the screen uses, so this is the second of the two gates, and it is not the UI.
    const registry = createRegistry()
    registerReportesHandlers(registry, { conn: t.conn })
    const sales = registry.resolve('reportes', 'sales')

    // THE CODE, NOT THE MESSAGE. `IpcError` puts `TENANT_REQUIRED` in `.code` and a Spanish sentence
    // for the owner in `.message`, so a `toThrow(/TENANT_REQUIRED/)` matched a string the
    // renderer never sees and proved nothing about the contract. The code is the part that
    // crosses the IPC boundary and the part callers branch on.
    expect(falla(() => sales({ fechaInicio: '2026-01-01', fechaFin: '2026-01-31' }, { actorId: null })).code).toBe(
      'TENANT_REQUIRED'
    )
    expect(falla(() => sales({}, undefined)).code).toBe('TENANT_REQUIRED')

    // The panel is the same: `dashboard.stats` calls `requireTenant` too.
    const dash = createRegistry()
    registerDashboardHandlers(dash, { conn: t.conn })
    expect(falla(() => dash.resolve('dashboard', 'stats')({}, undefined)).code).toBe('TENANT_REQUIRED')
    // An `actorId` alone is still not a tenant. The two are different facts and the gate needs
    // the second one; a renderer that knew an operator's id would get nothing for it.
    expect(falla(() => dash.resolve('dashboard', 'stats')({ periodo: 'month' }, { actorId: 1 })).code).toBe(
      'TENANT_REQUIRED'
    )
  })

  it('un renderer sin sesión NO monta ningún reporte: ve el panel de acceso', async () => {
    const { t } = escenario()
    stores.push(t)
    // The session is closed, so `auth.me` answers null and `App` renders `<Acceso />` INSTEAD OF
    // `<Routes>`. This test drives the real shell, not the screen, because the screen alone cannot
    // prove the gate — the gate is one level above it.
    await globalThis.minimarck.call('auth', 'logout', {})
    await montarApp('/reportes/ventas')

    // The sign-in form, and NOT one peso of the report.
    await waitFor(() => expect(document.querySelector('input[type="password"]')).toBeTruthy())
    expect(document.querySelector('[data-testid="total-ingresos"]')).toBeNull()
    expect(document.querySelector('[data-testid="tab-ventas"]')).toBeNull()
    expect(document.body.textContent).not.toContain('$700,00')
  })

  it('con sesión, el mismo shell monta el reporte que la URL pidió', async () => {
    const { t } = escenario()
    stores.push(t)
    await _shop(t)
    await montarApp('/reportes/ventas')

    // The same deep link, the same session, one difference: here the screen exists. Together with
    // the test above this is the security claim, and it is a claim about the SHELL.
    await waitFor(() => expect(document.querySelector('[data-testid="tab-ventas"]')).toBeTruthy())
    expect(document.querySelector('input[type="password"]')).toBeNull()
  })

  it('el panel de un negocio no muestra los productos de otro', async () => {
    const { t, registry } = escenario()
    stores.push(t)
    await _shop(t)

    // A second shop in the same file, with a product the session's business has never heard of.
    //
    // `negocios` HAS NO `user_id`: the schema's tenant table is nombre/ruc/tipo_comercio/
    // configuracion/activo/timestamps, and the operator-to-business link does not live on it.
    // Writing `user_id` here — which reads like every other table in this file and is the obvious
    // thing to type — is `table negocios has no column named user_id`, and the isolation test that
    // exists to prove one business cannot see another's money never gets to ask the question. It
    // is the same class of mistake as the `ventas_detalles.negocio_id` one, in the other
    // direction: a column that does not exist on the table you are thinking of.
    const otro = t.conn.db
      .prepare(
        `INSERT INTO negocios (nombre, created_at, updated_at)
         VALUES ('Otro negocio', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    const otroId = Number(otro.lastInsertRowid)
    t.conn.db
      .prepare(
        `INSERT INTO productos (nombre, precio_centavos, precio_compra_centavos, stock_milli,
           stock_minimo_milli, unidad_medida, tiene_iva, iva_porcentaje, margen, activo, user_id,
           negocio_id, created_at, updated_at)
         VALUES ('Producto ajeno', 999900, 0, 10000, 5000, 'kg', 1, 21, 30, 1, ?, ?, ?, ?)`
      )
      .run(t.usuarioId, otroId, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')

    const handler = registry.resolve('dashboard', 'stats')
    const mio = await handler({ periodo: 'month' }, { negocioId: t.negocioId, actorId: t.usuarioId })
    const texto = JSON.stringify(mio)

    expect(texto).not.toContain('Producto ajeno')
    expect(mio.productos.total).toBe(2)
    expect(otroId).toBeGreaterThan(0)
  })
})

describe('el panel', () => {
  let user
  beforeEach(() => {
    user = userEvent.setup()
  })

  it('imprime las ventas del mes con la coma decimal y el stock en su unidad', async () => {
    const { t } = escenario()
    stores.push(t)
    await _shop(t)
    montarPanel()

    await waitFor(() => expect(screen.getByTestId('panel-ventas').textContent).toBe('$700,00'))
    // "3 ventas" is the card's NOTE, a sibling of the figure — not the figure with a suffix.
    expect(screen.getByTestId('panel-ventas-nota').textContent).toBe('3 ventas')
    expect(screen.getByTestId('panel-deudores').textContent).toBe('$200,00')
    expect(screen.getByTestId('panel-productos').textContent).toBe('2')

    const top = await screen.findByTestId('tabla-top')
    expect(within(top).getByText('3,5 kg')).toBeTruthy()
    expect(within(top).getByText('5,5 kg')).toBeTruthy()
    expect(within(top).getByText('$700,00')).toBeTruthy()

    // The last seven local days, gaps included, are listed rather than charted: this build has no
    // chart library and a number the operator can read beats a shape they have to decode.
    const siete = await screen.findByTestId('tabla-siete-dias')
    expect(within(siete).getAllByRole('row')).toHaveLength(8)
    sinBasura()
  })

  it('los CUATRO períodos cambian la consulta y ninguno lleva fechas elegidas por el renderer', async () => {
    const { t, llamadas } = escenario()
    stores.push(t)
    await _shop(t)
    montarPanel()
    await waitFor(() => expect(screen.getByTestId('panel-ventas')).toBeTruthy())

    for (const clave of ['day', 'week', 'year', 'month']) {
      await user.click(screen.getByTestId(`periodo-${clave}`))
      await waitFor(() =>
        expect(
          llamadas.filter((c) => c.group === 'dashboard' && c.op === 'stats').some((c) => c.payload.periodo === clave)
        ).toBe(true)
      )
    }
    for (const llamada of llamadas.filter((c) => c.group === 'dashboard')) {
      // A preset, and nothing else. `fechaInicio` here would let the frame choose the window — and
      // the window is what a dashboard's whole story is about.
      expect(Object.keys(llamada.payload).sort()).toEqual(['periodo'])
    }
  })

  it('un panel sin ventas lo admite, y no imprime una tabla de ventas que no existen', async () => {
    const { t } = escenario()
    stores.push(t)
    const caja = abrirCaja(t, {
      negocioId: t.negocioId,
      usuarioId: t.usuarioId,
      saldoInicialCentavos: 35000
    })
    await globalThis.minimarck.call('cajaMovimientos', 'create', {
      cajaId: caja.id,
      tipo: 'egreso',
      concepto: 'Bolsa de hielo',
      monto: '1.00'
    })
    montarPanel()

    await waitFor(() => expect(screen.getByTestId('panel-ventas').textContent).toBe('$0,00'))
    // The number IS zero and saying so is correct. What must not happen is a table of phantom
    // sales, and the screen has to admit the shop has not sold anything yet.
    expect(screen.getByTestId('panel-sin-top').textContent).toBe('Todavía no se vendió nada en este período.')
    expect(screen.getByTestId('panel-sin-ventas').textContent).toBe('Todavía no hay ventas registradas.')
    sinBasura()
  })
})
