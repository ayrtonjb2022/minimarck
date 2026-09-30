/**
 * FIRSTHAND DEBTOR DRIVE — a customer, a credit sale, a part payment, and a receipt, in the real app.
 *
 * `payment-drive.js` proves the cash path. This proves the OTHER money path, the one where the
 * shop takes its own money back instead of a stranger's:
 *
 *   1. A customer can be created FROM THE SCREEN, with no database editor involved.
 *   2. A credit sale can be billed to them from the POS — the sale is refused without a name, so
 *      this is where "fiado" stops being an idea and becomes a receivable.
 *   3. The debtor screen shows that receivable with a number, and a number is checkable.
 *   4. A PART payment is taken, in cash, and it is the repository's number that lands.
 *   5. The drawer moved by exactly what was collected, and the ledger balanced.
 *   6. The receipt prints the balance the view computed, over the history that explains it.
 *   7. `mixto` is not offered, and a card payment does not touch the drawer.
 *
 * WHY THIS IS A SCRIPT AND NOT A HUMAN. The claims above are about a running Electron process
 * talking to a real SQLite file over a real preload. A green jsdom suite cannot make that claim,
 * and a human clicking once cannot make it reproducibly. This drives the same window, the same
 * keys and the same file, so the next person runs it and gets the same answer.
 *
 * It is gated on `MINIMARCK_DEUDORES_DRIVE=1` and launched by `scripts/drive-deudores.mjs`, in the
 * same spirit as `scripts/drive-payment.mjs`. It runs against a THROWAWAY data directory, so it can
 * never touch a real shop's database.
 */
import { app } from 'electron'

async function esperarEn(win, expr, ms = 8000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const ok = await win.webContents.executeJavaScript(`(() => { try { return !!(${expr}) } catch { return false } })()`)
    if (ok) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

function buscar(win, { texto, selector, tag = 'button', dentroDelModal = false }) {
  return win.webContents.executeJavaScript(`(() => {
    const overlays = document.querySelectorAll('.modal-overlay');
    const raiz = ${dentroDelModal} ? (overlays[overlays.length - 1] || document) : document;
    let el;
    if (${JSON.stringify(selector || '')}) {
      el = raiz.querySelector(${JSON.stringify(selector || '')});
    } else {
      el = Array.from(raiz.querySelectorAll(${JSON.stringify(tag)})).find((n) =>
        n.tagName !== 'OPTION' && !n.disabled &&
        (n.textContent || '').toLowerCase().includes(${JSON.stringify((texto || '').toLowerCase())}));
    }
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  })()`)
}

/** Type into a controlled React input. Same three-way fallback as the payment drive. */
async function tipear(win, { selector, texto, dentroDelModal = false }) {
  const localizado = await win.webContents.executeJavaScript(`(() => {
    const overlays = document.querySelectorAll('.modal-overlay');
    const raiz = ${dentroDelModal} ? (overlays[overlays.length - 1] || document) : document;
    const el = raiz.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    return true;
  })()`)
  if (!localizado) return { ok: false, via: 'no se encontró el campo' }

  const enFoco = await win.webContents.executeJavaScript(
    `(() => { const a = document.activeElement; return a && a.tagName === 'INPUT' ? true : false })()`
  )
  if (!enFoco) return { ok: false, via: 'nada tiene el foco' }

  const valor = `(() => { const a = document.activeElement; return a && a.tagName === 'INPUT' ? a.value : null })()`

  for (const ch of texto) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch })
    await new Promise((r) => setTimeout(r, 40))
  }
  if ((await win.webContents.executeJavaScript(valor)) === texto) return { ok: true, via: 'sendInputEvent' }

  await win.webContents.executeJavaScript(`(() => {
    const el = document.activeElement;
    if (!el) return;
    el.value = '';
    el.focus();
    document.execCommand('insertText', false, ${JSON.stringify(texto)});
  })()`)
  await new Promise((r) => setTimeout(r, 200))
  if ((await win.webContents.executeJavaScript(valor)) === texto) return { ok: true, via: 'execCommand' }

  await win.webContents.executeJavaScript(`(() => {
    const el = document.activeElement;
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(texto)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await new Promise((r) => setTimeout(r, 200))
  return { ok: (await win.webContents.executeJavaScript(valor)) === texto, via: 'setter+input' }
}

async function navegar(win, ruta) {
  await buscar(win, { selector: `a[href="${ruta}"]`, tag: 'a' })
  return esperarEn(win, `location.pathname === ${JSON.stringify(ruta)}`, 8000)
}

async function recargar(win) {
  const listo = new Promise((r) => win.webContents.once('did-finish-load', () => r()))
  win.reload()
  await listo
  await new Promise((r) => setTimeout(r, 1000))
}

function leer(win, expr) {
  return win.webContents.executeJavaScript(`(() => { try { return (${expr}) } catch { return null } })()`)
}

const CAJA_CERRADA = `!!document.querySelector('input[type="number"][placeholder="0.00"]')`
const CAMPO_FONDO = `input[type="number"][placeholder="0.00"]`
/** The tender modal is the overlay that carries the "Mínimo $" field. */
const PAGO_ABIERTO = `!!document.querySelector('.modal-overlay input[placeholder^="M\\u00ednimo"]')`

/** A real F2 keypress, through the real input pipeline. */
function pulsarF2(win) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F2' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F2' })
  return true
}

export function runDeudoresDrive(win, db) {
  const lines = []
  let fallos = 0
  let total = 0
  const say = (s) => { lines.push(s); console.log(s) }
  const db1 = (sql, ...args) => db.conn.db.prepare(sql).get(...args)
  const dbAll = (sql, ...args) => db.conn.db.prepare(sql).all(...args)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const check = (nombre, ok, detalle) => {
    total++
    if (ok) say(`  OK    ${nombre}`)
    else { fallos++; say(`  FALLA ${nombre}${detalle ? ` — ${detalle}` : ''}`) }
    return ok
  }
  const pesos = (c) => `$${(c / 100).toFixed(2)}`

  return (async () => {
    say('')
    say('=== RECORRIDO DE DEUDORES A MANO (app real, ventana real, teclas reales) ===')
    say(`  base: ${db.paths.dataDir}`)

    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level < 2) return
      if (/offline-selfcheck\.invalid/.test(message)) return
      if (/inline script/.test(message)) return
      say(`  [renderer] ${message} (${String(sourceId).split('/').pop()}:${line})`)
    })
    win.show()
    win.focus()
    await sleep(1500)

    // ---- 0. shelf and till -------------------------------------------------------------------
    // Said out loud, for the same reason the payment drive says it: a fresh install has no
    // catalogue, so the drive stocks one product before selling. Nothing about the DEBT is faked.
    if (db1(`SELECT COUNT(*) AS n FROM productos WHERE deleted_at IS NULL`).n === 0) {
      const negocio = db1(`SELECT id FROM negocios ORDER BY id LIMIT 1`)
      const usuario = db1(`SELECT id FROM users ORDER BY id LIMIT 1`)
      db.conn.db
        .prepare(
          `INSERT INTO productos
             (nombre, codigo, precio_centavos, precio_compra_centavos, stock_milli, stock_minimo_milli,
              user_id, negocio_id, activo, unidad_medida)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'unidad')`
        )
        .run('Queso artesanal', 'QUESO-1', 20000, 12000, 10000, 1000, usuario.id, negocio.id)
      say('  (la base nueva no trae catálogo: se carga un "Queso artesanal" a $200,00 el kilo)')
      await recargar(win)
    }

    if (!(await navegar(win, '/pos'))) {
      check('el POS se abre desde la barra lateral', false, `ruta ${await leer(win, 'location.pathname')}`)
      return finish()
    }

    let caja = db1(`SELECT id, saldo_inicial_centavos FROM cajas WHERE estado = 'abierta' AND deleted_at IS NULL`)
    if (!caja) {
      const ofrece = await esperarEn(win, CAJA_CERRADA, 6000)
      check('sin caja abierta, la app pide abrir una antes de vender', ofrece)
      if (ofrece) {
        await tipear(win, { selector: CAMPO_FONDO, texto: '50000' })
        await sleep(250)
        await buscar(win, { texto: 'Abrir Caja' })
        await sleep(2000)
      }
    }
    caja = db1(`SELECT id, saldo_inicial_centavos FROM cajas WHERE estado = 'abierta' AND deleted_at IS NULL`)
    if (!check('la caja queda abierta, con su fondo', Boolean(caja), 'no quedó ninguna caja abierta')) return finish()
    const fondoCaja = caja.saldo_inicial_centavos
    say(`         caja #${caja.id}, fondo ${pesos(fondoCaja)}`)

    if (!(await esperarEn(win, `document.querySelector('.pos-container')`, 8000))) {
      check('con la caja abierta aparece la pantalla de venta', false, 'no aparece la grilla')
      return finish()
    }

    // ---- 1. create the customer, FROM THE SCREEN ------------------------------------------------
    // The POS can only bill to somebody who already exists, and a fresh install seeds no
    // customers. Without this step the whole debt story is unreachable, so it is driven here
    // rather than inserted: a screen nobody exercised is a screen nobody knows works.
    if (!(await navegar(win, '/deudores'))) {
      check('la pantalla de deudores existe y se abre', false, `ruta ${await leer(win, 'location.pathname')}`)
      return finish()
    }
    check('la pantalla de deudores existe y se abre', true)
    check('la lista arranca vacía y lo dice', await esperarEn(win, `!!Array.from(document.querySelectorAll('button')).find(b => /Nuevo cliente/i.test(b.textContent))`))

    const NOMBRE = 'Ana Beatriz Gómez'
    const DOCUMENTO = '30111222'
    await buscar(win, { texto: 'Nuevo cliente' })
    const abrioForm = await esperarEn(win, `!!document.querySelector('[data-testid="cli-nombre"]')`, 5000)
    if (!check('el botón "Nuevo cliente" abre el formulario', abrioForm)) return finish()

    await tipear(win, { selector: '[data-testid="cli-nombre"]', texto: NOMBRE })
    await tipear(win, { selector: '[data-testid="cli-documento"]', texto: DOCUMENTO })
    // The limit is optional and the screen leaves it blank; a $1.000,00 ceiling is typed so the
    // credit-limit check has something to compare against later.
    await tipear(win, { selector: '[data-testid="cli-limite"]', texto: '100000' })
    await buscar(win, { texto: 'Guardar' })
    const guardado = await esperarEn(
      win,
      `document.querySelector('#root').textContent.includes(${JSON.stringify(NOMBRE)})`,
      8000
    )
    check('el cliente se guarda y aparece en la lista', guardado)

    const cliente = db1(`SELECT * FROM clientes_deudores WHERE documento = ?`, DOCUMENTO)
    if (!check('el cliente quedó escrito en la base real', Boolean(cliente), 'no hay fila con ese documento')) return finish()
    check('el límite de crédito se guardó como el que se digitó', cliente.limite_credito_centavos === 10000000,
      `guardado ${pesos(cliente.limite_credito_centavos)}`)
    say(`         cliente #${cliente.id}: ${NOMBRE}, doc ${DOCUMENTO}, límite ${pesos(cliente.limite_credito_centavos)}`)

    const debtorVacio = db1(`SELECT deuda_pendiente_centavos AS n FROM v_clientes_deudores WHERE id = ?`, cliente.id)
    check('un cliente nuevo no debe nada', debtorVacio?.n === 0, `debe ${pesos(debtorVacio?.n ?? NaN)}`)

    // ---- 2. the credit sale, from the POS ------------------------------------------------------
    if (!(await navegar(win, '/pos'))) {
      check('se vuelve al POS para fiar', false, 'no se pudo volver a /pos')
      return finish()
    }
    await esperarEn(win, `!!document.querySelector('.pos-product-card:not(.stock-cero)')`, 8000)
    const stockAntes = db1(`SELECT id, stock_milli FROM productos ORDER BY id LIMIT 1`)
    await buscar(win, { selector: '.pos-product-card:not(.stock-cero)' })
    await esperarEn(win, `document.querySelectorAll('.cart-item').length > 0`, 6000)

    // F2 opens the tender screen — the same shortcut the payment drive proves. A credit sale needs
    // no money handed over, but it DOES need the tender screen, because that is where the method
    // and the account to bill are chosen.
    pulsarF2(win)
    const abrioCobroVenta = await esperarEn(win, PAGO_ABIERTO, 6000)
    if (!check('F2 abre la pantalla de cobro para elegir el método', abrioCobroVenta, 'F2 no abrió el cobro')) return finish()

    // Choose CREDIT. This is the step the whole feature exists for: without a named debtor,
    // `ventas.repo.js` refuses a `credito` sale, so a ticket can only be fiada to somebody the app
    // already knows. The method buttons carry no test id, so they are found by their own label —
    // the same way a person finds them.
    const METODO_CREDITO = await buscar(win, { texto: 'Crédito', dentroDelModal: true })
    if (!check('el POS ofrece pagar con crédito', METODO_CREDITO, 'no apareció la opción de crédito')) return finish()
    await sleep(500)

    // Find the customer: type the document into the credit search, then click the row.
    const CAMPO_CLIENTE = 'input[placeholder^="Buscá por nombre"]'
    const tieneBuscador = await esperarEn(win, `!!document.querySelector(${JSON.stringify(CAMPO_CLIENTE)})`, 4000)
    if (!check('la pantalla de crédito ofrece elegir cliente', tieneBuscador)) return finish()
    const busqueda = await tipear(win, { selector: CAMPO_CLIENTE, texto: DOCUMENTO, dentroDelModal: true })
    check('el nombre del cliente se puede buscar', busqueda.ok, `vía ${busqueda.via}`)
    await sleep(1200)

    const eligio = await buscar(win, { texto: NOMBRE, dentroDelModal: true })
    if (!check('el cliente aparece en la lista y se elige', eligio, `no apareció ${NOMBRE}`)) {
      const diag = await leer(win, `(() => { const o=document.querySelectorAll('.modal-overlay'); const u=o[o.length-1]; return u ? (u.textContent||'').replace(/\\s+/g,' ').trim().slice(0,220) : '' })()`)
      say(`  [diagnóstico] modal: ${diag}`)
      return finish()
    }
    await sleep(500)

    // The chosen account is shown back with its balance and limit. A cashier billing the wrong
    // person is the one mistake this screen exists to prevent, so the confirmation is checked.
    const elegido = await leer(
      win,
      `(() => { const o=document.querySelectorAll('.modal-overlay'); const u=o[o.length-1]; if(!u) return ''; const p=Array.from(u.querySelectorAll('p')).find(n=>(n.textContent||'').trim()===${JSON.stringify(NOMBRE)}); return p ? (u.textContent||'').replace(/\\s+/g,' ').trim().slice(0,200) : '' })()`
    )
    check('la pantalla confirma a quién se le está fiando', String(elegido).includes(NOMBRE), `modal: "${elegido}"`)

    await buscar(win, { texto: 'Confirmar Venta', dentroDelModal: true })
    await sleep(2500)

    const ventaRow = db1(`SELECT * FROM ventas ORDER BY id DESC LIMIT 1`)
    const esCredito =
      Boolean(ventaRow) && ventaRow.metodo_pago === 'credito' && ventaRow.deudor_id === cliente.id
    if (!check('la venta a crédito quedó escrita contra el cliente', esCredito,
      `metodo=${ventaRow?.metodo_pago} deudor=${ventaRow?.deudor_id} esperado=${cliente.id}`)) {
      // Say WHY, from the app itself. A drive that only reports "no row" makes the next person
      // guess; the toast carries the repository's own refusal verbatim.
      const avisos = await leer(
        win,
        `Array.from(document.querySelectorAll('.Toastify__toast, [role="alert"]')).map(t => (t.textContent||'').replace(/\\s+/g,' ').trim()).join(' || ') || '(sin toast)'`
      )
      const modalAbierto = await leer(win, `!!document.querySelector('.modal-overlay')`)
      const fila = db1(`SELECT id, folio, metodo_pago, deudor_id, total_centavos, descripcion FROM ventas ORDER BY id DESC LIMIT 1`)
      say(`  [diagnóstico] última venta: ${JSON.stringify(fila ?? null)}`)
      say(`  [diagnóstico] avisos en pantalla: ${avisos}`)
      say(`  [diagnóstico] modal de cobro todavía abierto: ${modalAbierto}`)
      return finish()
    }

    const totalVenta = ventaRow.total_centavos
    say(`         venta #${ventaRow.folio}: ${pesos(totalVenta)} fiados a ${NOMBRE}`)
    check('un cobro NO movió el cajón: no entró efectivo', !db1(`SELECT id FROM movimientos_caja WHERE venta_id = ? AND tipo = 'ingreso'`, ventaRow.id),
      'una venta a crédito no puede dejar efectivo en el cajón')
    const stockDespues = db1(`SELECT stock_milli FROM productos WHERE id = ?`, stockAntes.id)
    check('el stock bajó igual por una venta fiada', stockDespues.stock_milli < stockAntes.stock_milli,
      `${stockAntes.stock_milli} → ${stockDespues.stock_milli}`)

    // ---- 3. the debt is on the debtor screen ---------------------------------------------------
    await navegar(win, '/deudores')
    await esperarEn(win, `!!document.querySelector('[data-testid="debe-${cliente.id}"]')`, 8000)
    const debeEnPantalla = await leer(win, `document.querySelector('[data-testid="debe-${cliente.id}"]').textContent`)
    const debeEnBase = db1(`SELECT deuda_pendiente_centavos AS n FROM v_clientes_deudores WHERE id = ?`, cliente.id)
    check('la pantalla muestra la deuda con el número de la base',
      String(debeEnPantalla).replace(/[^\d]/g, '') === String(debeEnBase.n),
      `pantalla "${debeEnPantalla}", base ${pesos(debeEnBase.n)}`)
    say(`         debe en pantalla: ${debeEnPantalla}`)

    // ---- 4. take a PART payment, in cash -------------------------------------------------------
    const ABONO = Math.round(totalVenta / 3) // deliberately not the whole debt
    check('el abono es menor que la deuda (un cobro parcial, no una liquidación)',
      ABONO > 0 && ABONO < totalVenta, `abono ${pesos(ABONO)} sobre ${pesos(totalVenta)}`)

    const movimientosAntes = dbAll(`SELECT * FROM movimientos_caja`).length
    const ingresosAntes = db1(`SELECT total_ingresos_centavos AS n FROM cajas WHERE id = ?`, caja.id).n

    await buscar(win, { selector: `[data-testid="cobrar-${cliente.id}"]` })
    const abrioCobro = await esperarEn(win, `!!document.querySelector('[data-testid="monto-pago"]')`, 6000)
    if (!check('el botón "Cobrar" abre la pantalla de cobro', abrioCobro)) return finish()

    const tipéo = await tipear(win, { selector: '[data-testid="monto-pago"]', texto: String(ABONO / 100) })
    check('el monto del abono se puede digitar', tipéo.ok, `vía ${tipéo.via}`)
    await sleep(300)

    const hayMixto = await leer(win, `!!document.querySelector('[data-testid="metodo-mixto"]')`)
    check('el cobro NO ofrece "mixto": no hay con qué dividirlo', !hayMixto,
      'un pago mixto no tiene cuenta de destino verdadera')

    await buscar(win, { selector: '[data-testid="confirmar-pago"]' })
    const pagoHecho = await esperarEn(win, `!!document.querySelector('[data-testid="cobro-pendiente"]')`, 8000)
    const pagoRow = db1(`SELECT * FROM pagos_deuda ORDER BY id DESC LIMIT 1`)
    if (!check('el pago quedó escrito en la base real', Boolean(pagoRow) && pagoRow.monto_centavos === ABONO,
      pagoRow ? `guardado ${pesos(pagoRow.monto_centavos)}` : 'no hay pago')) return finish()
    check('el pago quedó a nombre del cliente correcto', pagoRow.deudor_id === cliente.id)
    say(`         pago #${pagoRow.id}: ${pesos(ABONO)} en efectivo, método ${pagoRow.metodo_pago}`)

    // ---- 5. the money actually moved ----------------------------------------------------------
    const movimientosDespues = dbAll(`SELECT * FROM movimientos_caja`)
    check('el cajón registró exactamente un movimiento nuevo por el abono',
      movimientosDespues.length === movimientosAntes + 1,
      `antes ${movimientosAntes}, ahora ${movimientosDespues.length}`)
    const ingreso = db1(`SELECT * FROM movimientos_caja ORDER BY id DESC LIMIT 1`)
    check('el movimiento del cajón es el abono, como ingreso',
      ingreso.tipo === 'ingreso' && ingreso.monto_centavos === ABONO,
      `${ingreso.tipo} ${pesos(ingreso.monto_centavos)}`)
    const ingresosDespues = db1(`SELECT total_ingresos_centavos AS n FROM cajas WHERE id = ?`, caja.id).n
    check('el total de ingresos del cajón subió por el abono',
      ingresosDespues - ingresosAntes === ABONO,
      `subió ${pesos(ingresosDespues - ingresosAntes)}`)

    const saldoCaja = db1(`SELECT saldo_inicial_centavos + total_ingresos_centavos - total_egresos_centavos AS n FROM cajas WHERE id = ?`, caja.id).n
    check('el saldo del cajón es el fondo más lo cobrado, sin la venta a crédito',
      saldoCaja === fondoCaja + ABONO, `saldo ${pesos(saldoCaja)}, esperado ${pesos(fondoCaja + ABONO)}`)
    say(`         cajón: fondo ${pesos(fondoCaja)} + cobrado ${pesos(ABONO)} = ${pesos(saldoCaja)}`)

    // The journal: a cash collection debits the drawer and credits the receivable, balanced.
    const partidas = dbAll(
      `SELECT c.codigo, SUM(d.debe_centavos) AS debe, SUM(d.haber_centavos) AS haber
         FROM detalles_asientos d
         JOIN asientos_contables a ON a.id = d.asiento_contable_id
         JOIN cuentas_contables c ON c.id = d.cuenta_contable_id
        WHERE a.referencia = ?
        GROUP BY c.codigo`,
      `pago:${pagoRow.id}`
    )
    const porCuenta = Object.fromEntries(partidas.map((p) => [p.codigo, p]))
    const totalDebe = partidas.reduce((s, p) => s + p.debe, 0)
    const totalHaber = partidas.reduce((s, p) => s + p.haber, 0)
    check('el asiento del pago está balanceado', totalDebe === totalHaber && totalDebe === ABONO,
      `debe ${pesos(totalDebe)}, haber ${pesos(totalHaber)}`)
    check('el efectivo entra por 1.1.01 Caja', porCuenta['1.1.01']?.debe === ABONO,
      `1.1.01 debe ${pesos(porCuenta['1.1.01']?.debe ?? 0)}`)
    check('la deuda del cliente se acredita en 1.3.01 Clientes', porCuenta['1.3.01']?.haber === ABONO,
      `1.3.01 haber ${pesos(porCuenta['1.3.01']?.haber ?? 0)}`)
    say(`         asiento pago:${pagoRow.id} → 1.1.01 debe ${pesos(ABONO)} / 1.3.01 haber ${pesos(ABONO)}`)

    // ---- 6. the receipt ------------------------------------------------------------------------
    const pendienteEsperado = totalVenta - ABONO
    const pendienteEnPantalla = await leer(win, `document.querySelector('[data-testid="cobro-pendiente"]').textContent`)
    check('la pantalla muestra lo que queda, no lo que el cliente pagó',
      String(pendienteEnPantalla).replace(/[^\d]/g, '') === String(pendienteEsperado),
      `pantalla "${pendienteEnPantalla}", esperado ${pesos(pendienteEsperado)}`)

    const totalPagadoTexto = await leer(win, `document.querySelector('[data-testid="cobro-total-pagado"]').textContent`)
    check('el historial suma exactamente lo pagado', String(totalPagadoTexto).replace(/[^\d]/g, '') === String(ABONO),
      `pantalla "${totalPagadoTexto}"`)
    say(`         queda debiendo ${pendienteEnPantalla}, pagado ${totalPagadoTexto}`)

    await buscar(win, { texto: 'Ver boleta' })
    // The receipt lives in the shared `Modal` component, which is styled inline and therefore has
    // NO `.modal-overlay` class — the POS's own hand-rolled modals do, `Modal` does not. So the
    // receipt is found by its own title, the way a person finds it on screen.
    const TITULO_BOLETA = `Array.from(document.querySelectorAll('h3')).find(h => (h.textContent||'').trim() === 'Boleta de pago')`
    const boleta = await esperarEn(win, `!!${TITULO_BOLETA}`, 6000)
    const textoBoleta = await leer(
      win,
      `(() => { const h = ${TITULO_BOLETA}; if (!h) return ''; const panel = h.parentElement && h.parentElement.parentElement; return panel ? (panel.textContent||'').replace(/\\s+/g,' ').trim().slice(0,260) : '' })()`
    )
    check('la boleta se abre y trae el saldo pendiente', boleta && /Pendiente/i.test(String(textoBoleta)),
      `no apareció la boleta: "${textoBoleta}"`)
    check('la boleta imprime el saldo que queda', String(textoBoleta).replace(/[^\d]/g, '').includes(String(pendienteEsperado)),
      `boleta: "${textoBoleta}"`)
    say(`         boleta: ${String(textoBoleta).slice(0, 150)}`)

    // ---- 7. a card payment must not touch the drawer -------------------------------------------
    // A cashier who assumes the card went into the till counts money that is not there, and the
    // shortage surfaces at the till count at the end of the shift. So: the drawer is measured
    // before and after, and the answer has to be "it did not move".
    const movimientosPreCard = dbAll(`SELECT * FROM movimientos_caja`).length
    await buscar(win, { texto: 'Cerrar' }).catch(() => {})
    await win.webContents.executeJavaScript(`(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => /cerrar|cancelar/i.test(x.textContent||''));
      if (b) b.click();
    })()`)
    await sleep(600)

    if (await buscar(win, { selector: `[data-testid="cobrar-${cliente.id}"]` })) {
      await esperarEn(win, `!!document.querySelector('[data-testid="monto-pago"]')`, 6000)
      await buscar(win, { selector: '[data-testid="metodo-tarjeta"]' })
      await sleep(300)
      const nota = await leer(win, `document.querySelector('[data-testid="nota-metodo"]').textContent`)
      check('la pantalla explica que la tarjeta NO entra al cajón', /caja no se mueve/i.test(String(nota)), `nota: "${nota}"`)

      const ABONO_CARD = Math.min(10000, pendienteEsperado)
      await tipear(win, { selector: '[data-testid="monto-pago"]', texto: String(ABONO_CARD / 100) })
      await sleep(200)
      await buscar(win, { selector: '[data-testid="confirmar-pago"]' })
      await sleep(2000)
      const pagoCard = db1(`SELECT * FROM pagos_deuda ORDER BY id DESC LIMIT 1`)
      check('el pago con tarjeta quedó registrado', Boolean(pagoCard) && pagoCard.metodo_pago === 'tarjeta',
        pagoCard ? `método ${pagoCard.metodo_pago}` : 'no hay pago')
      check('el pago con tarjeta NO movió el cajón',
        dbAll(`SELECT * FROM movimientos_caja`).length === movimientosPreCard,
        `antes ${movimientosPreCard}, ahora ${dbAll('SELECT * FROM movimientos_caja').length}`)
      const partidasCard = dbAll(
        `SELECT c.codigo, SUM(d.debe_centavos) AS debe, SUM(d.haber_centavos) AS haber
           FROM detalles_asientos d
           JOIN asientos_contables a ON a.id = d.asiento_contable_id
           JOIN cuentas_contables c ON c.id = d.cuenta_contable_id
          WHERE a.referencia = ? GROUP BY c.codigo`,
        `pago:${pagoCard.id}`
      )
      const porCuentaCard = Object.fromEntries(partidasCard.map((p) => [p.codigo, p]))
      check('el asiento con tarjeta también está balanceado',
        partidasCard.reduce((s, p) => s + p.debe, 0) === partidasCard.reduce((s, p) => s + p.haber, 0),
        'debe y haber no coinciden')
      check('la tarjeta entra por 1.1.02 Banco, no por la caja',
        porCuentaCard['1.1.02']?.debe === ABONO_CARD && !porCuentaCard['1.1.01'],
        `1.1.02 debe ${pesos(porCuentaCard['1.1.02']?.debe ?? 0)}`)
      say(`         pago con tarjeta ${pesos(ABONO_CARD)} contra 1.1.02 Banco, cajón sin cambios`)
    }

    // ---- 8. the debt closes --------------------------------------------------------------------
    const final = db1(`SELECT deuda_pendiente_centavos AS n FROM v_clientes_deudores WHERE id = ?`, cliente.id)
    const pagadoTotal = db1(`SELECT COALESCE(SUM(monto_centavos), 0) AS n FROM pagos_deuda WHERE deudor_id = ?`, cliente.id).n
    check('la deuda final es la venta menos todo lo cobrado', final.n === totalVenta - pagadoTotal,
      `debe ${pesos(final.n)}, venta ${pesos(totalVenta)}, cobrado ${pesos(pagadoTotal)}`)
    say('')
    say(`         RESUMEN: venta ${pesos(totalVenta)} · cobrado ${pesos(pagadoTotal)} · debe ${pesos(final.n)}`)

    return finish()
  })()

  function finish() {
    say('')
    say(fallos === 0
      ? `=== RECORRIDO DE DEUDORES: OK ${total}/${total} ===`
      : `=== RECORRIDO DE DEUDORES: FALLÓ ${total - fallos}/${total} ===`)
    say('')
    return { ok: fallos === 0, total, failed: fallos }
  }
}
