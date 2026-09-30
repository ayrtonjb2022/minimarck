// @vitest-environment jsdom
/**
 * THE DEBTOR SCREEN, driven the way the person taking the money does it.
 *
 * `pago-y-cancelacion.spec.jsx` proves a ticket becomes a sale and that a customer who still owes
 * gets a receipt. This file is about the OTHER half of that story: the screen a cashier opens when
 * the customer puts cash on the counter. The repository specs in `tests/db/deudores.spec.js` prove
 * the money lands correctly. Neither of those touches this file, and this is the layer where the
 * claims that reach the operator get tested.
 *
 * The harness is identical in spirit: the real React screen, the real handler registry, a real
 * migrated SQLite file. The one seam is the Electron transport, which `escenario` records rather
 * than merely forwards — a claim about what the client may dictate is a claim about a payload, and
 * a payload nobody looked at proves nothing.
 *
 * THE FIRST TEST IN THIS FILE EXISTS BECAUSE OF A REAL DEFECT. The success toast read
 * `formatCentavos(cents)` for a variable that does not exist. That is a ReferenceError thrown at the
 * precise moment the payment has already been committed: the money is in the drawer, the drawer
 * reconciles, and the cashier sees a blank screen with no confirmation. They will press the button
 * again. A database test cannot see it, because the database was perfectly happy. Only a test that
 * clicks the button and reads what comes back can.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup, within, fireEvent } from '@testing-library/react'
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
import { registerDeudoresHandlers } from '../../src/main/ipc/deudores.js'

import { tienda, ctxDe, insertarProducto, insertarDeudor } from '../db/fixtures/tienda.js'

import { AuthProvider } from '../../src/renderer/app/context/AuthContext.jsx'
import { CajaProvider } from '../../src/renderer/app/context/CajaContext.jsx'
import { ThemeProvider } from '../../src/renderer/app/context/ThemeContext.jsx'
import { NotificacionProvider } from '../../src/renderer/app/context/NotificacionContext.jsx'
import Deudores from '../../src/renderer/app/pages/Deudores.jsx'

function escenario({ productos = [], deudores = [] } = {}) {
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

  for (const p of productos) insertarProducto(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, overrides: p })
  for (const d of deudores) insertarDeudor(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, ...d })

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

/**
 * THE TOAST CONTAINER IS PART OF THE HARNESS, and leaving it out would have quietly gutted the
 * first test in this file.
 *
 * `Deudores.jsx` confirms a payment with `toast.success(...)` from `react-toastify`, and a
 * `toast` call with no container mounted renders NOTHING — no error, no text, just silence. So a
 * harness without `<ToastContainer />` cannot distinguish "the payment succeeded and told the
 * cashier" from "the payment succeeded and the screen threw before it could say so", which is
 * precisely the failure the `formatCentavos(cents)` ReferenceError caused. `main.jsx` mounts the
 * container for the real app; a test that omits it is testing a screen the operator never sees.
 */
function montar(contenido) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
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

const montarDeudores = () => montar(<Deudores />)

const pagosDe = (t) => t.conn.db.prepare('SELECT * FROM pagos_deuda WHERE negocio_id = ? ORDER BY id').all(t.negocioId)
const movimientosDe = (t) =>
  t.conn.db.prepare('SELECT * FROM movimientos_caja WHERE negocio_id = ? ORDER BY id').all(t.negocioId)
const saldoCaja = (t) => {
  const c = t.conn.db.prepare("SELECT * FROM cajas WHERE negocio_id = ? AND estado = 'abierta'").get(t.negocioId)
  return c ? c.saldo_inicial_centavos + c.total_ingresos_centavos - c.total_egresos_centavos : 0
}

/**
 * A till with $5.00 in it. The fixture's own default is $500, which is fine for a repository test
 * and misleading here: the assertions below add this float to a payment to get a round total, and
 * $500 would make every expected number five digits longer for no reason.
 */
async function abrirLaCaja(t) {
  await globalThis.minimarck.call('cajas', 'open', { saldoInicial: 5, observaciones: 'turno' })
}

/** A debtor with a real credit sale behind them: $300.00 on the shelf, owed. */
function deudorConDeuda(t, nombre = 'Ana Beatriz Gómez') {
  const producto = insertarProducto(t, {
    negocioId: t.negocioId,
    usuarioId: t.usuarioId,
    overrides: { nombre: 'Queso artesanal', precio_centavos: 20000, stock_milli: 10000 }
  })
  const deudor = insertarDeudor(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, nombre, limiteCreditoCentavos: 1000000 })
  const r = globalThis.minimarck.call('ventas', 'create', {
    items: [{ productoId: producto.id, cantidad: '1.5' }],
    metodoPago: 'credito',
    clienteDeudorId: deudor.id
  })
  return { producto, deudor, venta: r.venta ?? r }
}

async function cobrar(user, deudorId, monto) {
  await user.click(await screen.findByTestId(`cobrar-${deudorId}`))
  const input = await screen.findByTestId('monto-pago')
  await user.clear(input)
  if (monto != null) await user.type(input, String(monto))
  await user.click(screen.getByTestId('confirmar-pago'))
}

describe('taking a payment, from the screen the cashier is looking at', () => {
  let user
  beforeEach(() => {
    user = userEvent.setup()
  })

  it('CONFIRMS the payment, and the confirmation names the amount that was collected', async () => {
    const { t } = escenario()
    stores.push(t)
    await abrirLaCaja(t)
    const { deudor } = deudorConDeuda(t)
    montarDeudores()

    await cobrar(user, deudor.id, 100)

    // THE ASSERTION THAT EARNS THIS FILE. A toast naming the amount proves three things at once:
    // the payment went through, the screen said so, and the screen did not fall over on the way
    // to saying it. When this read `formatCentavos(cents)` instead of `centavos`, React threw a
    // ReferenceError here — after the money was committed — and this element never appeared. The
    // database was correct throughout. A green database suite would have shipped that bug.
    // MONEY IS RENDERED IN THE es-CL LOCALE, so the decimal separator is a COMMA. Asserting
    // `$100.00` here would be asserting a format the app never produces, and the test would be
    // "fixed" by loosening the matcher until it passed anything.
    const mensaje = await screen.findByText(/Pago de \$100,00 registrado/, {}, { timeout: 4000 })

    // And the number is the NUMBER, not a coincidence: $100 off $300 leaves $200, and the history
    // and the drawer agree independently.
    expect(mensaje).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('cobro-pendiente').textContent).toBe('$200,00'))
    expect(pagosDe(t)).toHaveLength(1)
    expect(pagosDe(t)[0].monto_centavos).toBe(10000)
    // The drawer's own arithmetic, read from the database and not from the screen: $5.00 of float
    // (500 centavos) plus $100.00 collected (10000 centavos). If the payment had moved the journal
    // but not the drawer, this is the number that would not add up.
    expect(saldoCaja(t)).toBe(10500)
  })

  it('sends the payment as CENTAVOS and lets the repository decide the new balance', async () => {
    const { t, llamadas } = escenario()
    stores.push(t)
    await abrirLaCaja(t)
    const { deudor } = deudorConDeuda(t)
    montarDeudores()

    await cobrar(user, deudor.id, 100)

    const llamada = llamadas.find((c) => c.op === 'addPayment')
    expect(llamada).toBeTruthy()
    // A peso string, not centavos. The renderer converts once, at the edge, and the amount that
    // reaches the ledger is an integer. If this ever arrives as 100 the payment is $1.00, which
    // is a factor of a hundred and a completely silent error.
    expect(llamada.payload.monto).toBe('100')
    expect(llamada.payload.metodoPago).toBe('efectivo')
    // The client is not trusted with the outcome: it sends no balance, and the balance it then
    // displays is the one that came back.
    expect(llamada.payload.deudaPendienteCentavos).toBeUndefined()
  })

  it('offers no MIXTO, because a mixed payment has no truthful account to land in', async () => {
    const { t } = escenario()
    stores.push(t)
    await abrirLaCaja(t)
    const { deudor } = deudorConDeuda(t)
    montarDeudores()

    await user.click(await screen.findByTestId(`cobrar-${deudor.id}`))
    await screen.findByTestId('monto-pago')

    // The POS offers `mixto`, and the debts screen must not. There is no field to say how much of
    // the payment was cash, and guessing splits the money between a drawer and a bank account on
    // the strength of a coin flip. It is not offered, so it cannot be chosen by accident.
    expect(screen.queryByTestId('metodo-mixto')).toBeNull()
    expect(screen.getByTestId('metodo-efectivo')).toBeTruthy()
    expect(screen.getByTestId('metodo-tarjeta')).toBeTruthy()
    expect(screen.getByTestId('metodo-transferencia')).toBeTruthy()
  })

  it('tells the cashier that a card payment does NOT go into the drawer', async () => {
    const { t } = escenario()
    stores.push(t)
    await abrirLaCaja(t)
    const { deudor } = deudorConDeuda(t)
    montarDeudores()

    await user.click(await screen.findByTestId(`cobrar-${deudor.id}`))
    await screen.findByTestId('monto-pago')
    await user.click(screen.getByTestId('metodo-tarjeta'))

    // A cashier who assumes the card went into the till counts money that is not there, and the
    // shortage is discovered at close. The screen says which account it lands in.
    expect(screen.getByTestId('nota-metodo').textContent).toMatch(/caja no se mueve/i)

    // And the drawer does not move: same movements as before the click, plus none.
    const antes = movimientosDe(t).length
    await cobrar(user, deudor.id, 50)
    await waitFor(() => expect(pagosDe(t)).toHaveLength(1))
    expect(movimientosDe(t)).toHaveLength(antes)
  })

  it('refuses to register a payment larger than the debt, BEFORE it is sent', async () => {
    const { t, llamadas } = escenario()
    stores.push(t)
    await abrirLaCaja(t)
    const { deudor } = deudorConDeuda(t) // $300 owed
    montarDeudores()

    await user.click(await screen.findByTestId(`cobrar-${deudor.id}`))
    const input = await screen.findByTestId('monto-pago')
    await user.clear(input)
    await user.type(input, '300.01')

    // The warning appears as the amount is typed, and the repository refuses it too. Two layers,
    // because the client-side one is a courtesy and only the repository is a guarantee.
    expect(await screen.findByTestId('pago-excede')).toBeTruthy()
    expect(llamadas.filter((c) => c.op === 'addPayment')).toHaveLength(0)

    // Prove the repository would have refused as well, by sending it directly. If only the client
    // had been checking, this would succeed and the debt would silently absorb an overpayment.
    await expect(
      globalThis.minimarck.call('deudores', 'addPayment', { deudorId: deudor.id, monto: '300.01', metodoPago: 'efectivo' })
    ).rejects.toThrow(/excede la deuda/i)
    expect(pagosDe(t)).toHaveLength(0)
  })

  it('a cash payment with no till open is refused in words, and nothing is recorded', async () => {
    const { t } = escenario()
    stores.push(t)
    // NO `abrirCaja`. A debtor may owe money at 8am with the register closed, and the screen has
    // to say so rather than collect into a drawer that does not exist.
    const { deudor } = deudorConDeuda(t)
    montarDeudores()

    await cobrar(user, deudor.id, 100)

    // The refusal is the screen's OWN error element, not a loose `/caja/i` sweep: the word "caja"
    // also appears in the method note that explains where a payment lands, so a loose matcher
    // would pass on a screen that never refused anything.
    const error = await screen.findByTestId('error-pago')
    expect(error.textContent).toMatch(/caja/i)
    expect(pagosDe(t)).toHaveLength(0)
  })

  it('"Todo" fills the box with exactly what is owed, and settles the account', async () => {
    const { t } = escenario()
    stores.push(t)
    await abrirLaCaja(t)
    const { deudor } = deudorConDeuda(t)
    montarDeudores()

    await user.click(await screen.findByTestId(`cobrar-${deudor.id}`))
    await screen.findByTestId('monto-pago')
    await user.click(screen.getByTestId('cobrar-todo'))

    // $300 owed becomes "300", not "299.99" from a float round-trip. The field holds pesos as text
    // and the balance is centavos, so the division is exact at this magnitude — the test is here to
    // notice if someone reaches for a rounding helper instead.
    expect(screen.getByTestId('monto-pago').value).toBe('300')

    await user.click(screen.getByTestId('confirmar-pago'))
    await waitFor(() => expect(pagosDe(t)).toHaveLength(1))
    // A settled debt says so IN THE WORDS OF THE SCREEN, not just as a zero. The panel swaps the
    // whole form out for "no debe nada" — which is the only signal that this account is closed and
    // should not be offered for collection again.
    expect(await screen.findByTestId('deuda-saldada')).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('cobro-pendiente').textContent).toBe('$0,00'))
  })

  it('shows the payment history with the installment on top, newest first', async () => {
    const { t } = escenario()
    stores.push(t)
    await abrirLaCaja(t)
    const { deudor } = deudorConDeuda(t)
    montarDeudores()

    await cobrar(user, deudor.id, 50)
    await waitFor(() => expect(pagosDe(t)).toHaveLength(1))
    await cobrar(user, deudor.id, 25)
    await waitFor(() => expect(pagosDe(t)).toHaveLength(2))

    // "Total pagado" is the SUM of the history. If the screen kept its own running total instead,
    // a refresh would reset it and the operator would read a paid-off account that is not.
    await waitFor(() => expect(screen.getByTestId('cobro-total-pagado').textContent).toBe('$75,00'))
  })
})

describe('the debtor list is a list of real debts, not a list of names', () => {
  let user
  beforeEach(() => {
    user = userEvent.setup()
  })

  it('lists who owes, with the number, and who does not owe anything', async () => {
    const { t } = escenario()
    stores.push(t)
    const { deudor } = deudorConDeuda(t, 'Ana Beatriz Gómez')
    insertarDeudor(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, nombre: 'Carlos Ruiz' })
    montarDeudores()

    await waitFor(() => expect(screen.getByTestId(`debe-${deudor.id}`).textContent).toBe('$300,00'))
    // The person who owes nothing is still listed — they are a customer — but at zero, and with
    // "Ver" instead of "Cobrar", because offering to collect from someone who owes nothing is
    // how a cashier types a number that then becomes a debt.
    expect(screen.getByText('Carlos Ruiz')).toBeTruthy()
    expect(screen.getByTestId(`cobrar-${deudor.id}`).textContent).toMatch(/Cobrar/)
  })

  it('"Solo con deuda" hides the people who have already paid', async () => {
    const { t, llamadas } = escenario()
    stores.push(t)
    const { deudor } = deudorConDeuda(t, 'Ana Beatriz Gómez')
    const alDia = insertarDeudor(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, nombre: 'Carlos Ruiz' })
    montarDeudores()

    await waitFor(() => expect(screen.getByText('Carlos Ruiz')).toBeTruthy())
    await user.click(screen.getByTestId('filtro-solo-con-deuda'))

    // The filter is the SERVER's job, not a client-side one. Filtering in the client would be
    // right for twenty customers and wrong for two thousand, because the screen would have been
    // sent one page and would be quietly hiding people it never received.
    await waitFor(() => expect(screen.queryByText('Carlos Ruiz')).toBeNull())
    const lista = llamadas.filter((c) => c.op === 'list')
    expect(lista.at(-1).payload.conDeuda).toBe(true)
    // The one who owes is still on screen, and the one who does not is not in the payload.
    expect(screen.getByText('Ana Beatriz Gómez')).toBeTruthy()
    expect(alDia).toBeTruthy()
  })

  it('a search finds by name and by document, and a search finding nothing says so', async () => {
    const { t } = escenario()
    stores.push(t)
    deudorConDeuda(t, 'Ana Beatriz Gómez')
    t.conn.db.prepare("UPDATE clientes_deudores SET documento = '30111222' WHERE nombre = ?").run('Ana Beatriz Gómez')
    montarDeudores()

    await waitFor(() => expect(screen.getByText('Ana Beatriz Gómez')).toBeTruthy())

    const busqueda = screen.getByLabelText('Buscar deudor')
    await user.type(busqueda, '30111222')
    await waitFor(() => expect(screen.queryByText('Carlos Ruiz')).toBeNull())

    await user.clear(busqueda)
    await user.type(busqueda, 'nadie con ese nombre')
    await user.click(screen.getByText('Buscar'))
    // "No results" is a real answer and has to be said. An empty table with no explanation is read
    // as a broken screen, and the operator reloads, and reloads again. The box only filters on
    // Enter or on the button — typing alone must not wipe the list, or every keystroke would look
    // like a failed search.
    expect(await screen.findByText(/Ningun cliente coincide/i)).toBeTruthy()
  })

  it('creates a customer from the same screen, and the new customer is in the table', async () => {
    const { t } = escenario()
    stores.push(t)
    montarDeudores()

    await waitFor(() => expect(screen.getByText(/Todavia no hay clientes cargados/i)).toBeTruthy())
    await user.click(screen.getByText('Nuevo cliente'))
    await user.type(await screen.findByTestId('cli-nombre'), 'María José Gutiérrez')
    await user.type(screen.getByTestId('cli-documento'), '44112233')
    await user.click(screen.getByTestId('guardar-cliente'))

    await waitFor(() => expect(screen.getByText('María José Gutiérrez')).toBeTruthy())
    const fila = t.conn.db.prepare('SELECT * FROM clientes_deudores WHERE nombre = ?').get('María José Gutiérrez')
    expect(fila).toBeTruthy()
    expect(fila.documento).toBe('44112233')
    // A brand new customer owes nothing, and the screen says $0.00 rather than leaving it blank —
    // a blank in a money column is read as "unknown", and "unknown" is not a balance.
    expect(screen.getByTestId(`debe-${fila.id}`).textContent).toBe('$0,00')
  })

  it('refuses a duplicate document with the reason, and keeps the customer already on file', async () => {
    const { t } = escenario()
    stores.push(t)
    insertarDeudor(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, nombre: 'Ana Beatriz Gómez' })
    t.conn.db.prepare("UPDATE clientes_deudores SET documento = '30111222' WHERE nombre = ?").run('Ana Beatriz Gómez')
    montarDeudores()

    await waitFor(() => expect(screen.getByText('Ana Beatriz Gómez')).toBeTruthy())
    await user.click(screen.getByText('Nuevo cliente'))
    await user.type(await screen.findByTestId('cli-nombre'), 'Otra persona')
    await user.type(screen.getByTestId('cli-documento'), '30111222')
    await user.click(screen.getByTestId('guardar-cliente'))

    // The refusal has to NAME the reason. "Error" tells a cashier nothing they can act on, and the
    // action — a different document — is not guessable.
    expect(await screen.findByText(/ya existe en esta tienda/i)).toBeTruthy()
    expect(t.conn.db.prepare('SELECT COUNT(*) AS n FROM clientes_deudores').get().n).toBe(1)
  })
})
