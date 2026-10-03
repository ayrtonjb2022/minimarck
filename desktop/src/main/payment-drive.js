/**
 * FIRSTHAND PAYMENT DRIVE — the real app, the real window, the real keys.
 *
 * The UI tests prove the payment path works with a registry standing in for the Electron
 * transport. This proves it in the app a shop actually opens: real `BrowserWindow`, real preload,
 * real `app://bundle` origin, real IPC over the real channel, real SQLite file, and a real `F2`
 * keypress dispatched to the real `window`.
 *
 * It is gated on `MINIMARCK_PAYMENT_DRIVE=1` and launched by `scripts/drive-payment.mjs`, exactly
 * the way the launch probe is gated on `MINIMARCK_S0_PROBE=1`. Nothing here runs in normal use.
 *
 * WHAT IT CHECKS, and why none of it is the test suite again:
 *
 *   1. The POS refuses to sell until a till is open, and the till opens from the screen button.
 *   2. A product goes on the ticket by clicking its card — the thing a barcode scanner replaces.
 *   3. `F2` opens the payment screen. A real `KeyboardEvent` on the real window is the only way to
 *      prove the shortcut is wired to the running application; jsdom cannot make that claim.
 *   4. Confirming writes the sale, the stock decrement, the drawer movement and the change to the
 *      REAL database file, read back from the MAIN process — not from a mock.
 *   5. The change on screen is the change that was stored.
 *   6. The sale cancels from the sales list, the stock returns, and the drawer records the egress.
 *
 * The output is deliberately plain: what a person pressed, and what the shop file then said.
 */
import { app } from 'electron'
import { firmarComoDueño } from './first-launch-signin.js'

/** Wait for a condition in the RENDERER. Polls with `executeJavaScript`, which is async-safe. */
async function esperarEn(win, expr, ms = 8000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const ok = await win.webContents.executeJavaScript(`(() => { try { return !!(${expr}) } catch { return false } })()`)
    if (ok) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

/**
 * Find a clickable element. `dentroDelModal` scopes the search to the top overlay, because the
 * page underneath keeps its own buttons in the DOM while a modal is up — the "Abrir caja" that
 * OPENS the dialog and the "Abrir caja" that CONFIRMS it are both buttons with the same text.
 * The text match is case-insensitive: the screen writes "Abrir Caja" and the confirm button writes
 * "Abrir caja", and a drive that only finds one of them is not looking at the app.
 */
function buscar(win, { texto, selector, tag = 'button', dentroDelModal = false }) {
  return win.webContents.executeJavaScript(`(() => {
    // "The modal" is the LAST overlay, not the first. The app keeps several .modal-overlay
    // elements in the DOM at once — the receipt sits on top of the payment screen — and clicking
    // "Confirmar Venta" inside the wrong one is a silent no-op that reads as a broken button.
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

/**
 * Type into an input, the way a person does, and prove the component actually saw it.
 *
 * Three ways in, tried in the order that earns trust, because each one fails differently:
 *
 *   1. `webContents.sendInputEvent` — real Chromium input pipeline, exactly what a physical
 *      keyboard does. Best evidence, but it needs the window to actually hold OS focus, which a
 *      window created by a headless run does not always have.
 *   2. `document.execCommand('insertText')` — the browser's own editing command. It fires the real
 *      `beforeinput`/`input` pair, which a CONTROLLED React input does respond to.
 *   3. The native value setter plus an `input` event — the DOM value changes but React's state
 *      does not, which is the classic way a "typed" test types nothing at all. Only a last resort,
 *      and it is reported when it is what actually worked, because a value React never saw is not
 *      evidence of anything.
 *
 * The return value says which one did it, so a silent no-op can never be mistaken for a pass.
 */
async function tipear(win, { selector, texto, dentroDelModal = false }) {
  // Focus the field, then type into `document.activeElement` — NOT into the node the selector
  // found. Those can be different elements: asking "is the node I focused the focused one?"
  // returned false while `activeElement` plainly WAS the tender field, because the focus lands on
  // a wrapper the browser promotes. Whichever element really holds focus is the one a keystroke
  // would reach, so that is the one the drive reads and writes.
  const localizado = await win.webContents.executeJavaScript(`(() => {
    const overlays = document.querySelectorAll('.modal-overlay');
    const raiz = ${dentroDelModal} ? (overlays[overlays.length - 1] || document) : document;
    const el = raiz.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    return true;
  })()`)
  if (!localizado) return { ok: false, via: 'no se encontró el campo' }

  const enFoco = await win.webContents.executeJavaScript(`(() => {
    const a = document.activeElement;
    return a && a.tagName === 'INPUT' ? true : false;
  })()`)
  if (!enFoco) return { ok: false, via: 'nada tiene el foco' }

  const valor = `(() => { const a = document.activeElement; return a && a.tagName === 'INPUT' ? a.value : null })()`

  for (const ch of texto) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch })
    await new Promise((r) => setTimeout(r, 40))
  }
  if (await win.webContents.executeJavaScript(valor) === texto) {
    return { ok: true, via: 'sendInputEvent' }
  }

  const porExec = await win.webContents.executeJavaScript(`(() => {
    const el = document.activeElement;
    if (!el) return false;
    el.value = '';
    el.focus();
    return document.execCommand('insertText', false, ${JSON.stringify(texto)});
  })()`)
  await new Promise((r) => setTimeout(r, 200))
  if (await win.webContents.executeJavaScript(valor) === texto) {
    return { ok: true, via: porExec ? 'execCommand' : 'execCommand(sinRetorno)' }
  }

  await win.webContents.executeJavaScript(`(() => {
    const el = document.activeElement;
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(texto)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await new Promise((r) => setTimeout(r, 200))
  return {
    ok: (await win.webContents.executeJavaScript(valor)) === texto,
    via: 'setter+input(React puede no haberlo visto)'
  }
}

/** A real F2 keypress, through the real input pipeline. */
function pulsarF2(win) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F2' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F2' })
  return true
}

/**
 * Move to another screen by clicking the app's own sidebar link.
 *
 * NOT by `win.loadURL`. Loading a second document tears the page down underneath the poll, and
 * `executeJavaScript` then runs against a dying document — the drive failed "the POS is on
 * screen" on some runs and passed on others for exactly that reason. A person walks between
 * screens by clicking "Vender" and "Ventas", the router swaps the view with no reload, and the
 * DOM stays alive the whole time. That is both more faithful and more stable.
 */
async function navegar(win, ruta) {
  await buscar(win, { selector: `a[href="${ruta}"]`, tag: 'a' })
  return esperarEn(win, `location.pathname === ${JSON.stringify(ruta)}`, 8000)
}

/** Reload the window and wait for the new document to finish loading. */
async function recargar(win) {
  const listo = new Promise((r) => win.webContents.once('did-finish-load', () => r()))
  win.reload()
  await listo
  await new Promise((r) => setTimeout(r, 1000))
}

/** Read something out of the live DOM, for the report. */
function leer(win, expr) {
  return win.webContents.executeJavaScript(`(() => { try { return (${expr}) } catch { return null } })()`)
}

/** The payment modal is the overlay that contains the tender field. */
const PAGO_ABIERTO = `!!document.querySelector('.modal-overlay input[placeholder^="M\\u00ednimo"]')`
/**
 * The till is opened by `CajaGuard`, which owns the `/pos` route and renders its own "Caja Cerrada"
 * screen BEFORE `PuntoDeVenta` ever mounts. So the "open a till" form the drive has to fill is
 * CajaGuard's initial-balance number input — not the `ModalAperturaCaja` inside the POS page.
 */
const CAJA_CERRADA = `!!document.querySelector('input[type="number"][placeholder="0.00"]')`
const CAMPO_FONDO = `input[type="number"][placeholder="0.00"]`
/**
 * Relative to the overlay, NOT to the document. `tipear` with `dentroDelModal` already searches
 * inside `.modal-overlay`, so a selector that re-includes `.modal-overlay` asks the overlay for a
 * DESCENDANT that is itself an overlay — finds nothing, and the tender is never typed. That is
 * what made the first run get as far as F2 and then quietly stop.
 *
 * The `í` is written as a real escape, NOT a literal backslash sequence. `PAGO_ABIERTO` above gets
 * away with `\\u00ed` because the whole expression is shipped as JavaScript source and the
 * BROWSER's parser resolves the escape. This constant is shipped through `JSON.stringify` instead,
 * and JSON escapes the backslash — so the browser would have been handed a CSS selector
 * containing a literal backslash, which matches no input, ever.
 */
const CAMPO_MINIMO = `input[placeholder^="M\u00ednimo"]`

export function runPaymentDrive(win, db) {
  const lines = []
  // `say`/`check`/`fallos`/`total` live in the OUTER scope on purpose: `finish()` is a sibling of
  // the async body, not a nested closure, so counters declared inside the body are invisible to it
  // — which is how the first version of this drive died with `fallos is not defined`.
  let fallos = 0
  let total = 0
  const say = (s) => { lines.push(s); console.log(s) }
  const db1 = (sql, ...args) => db.conn.db.prepare(sql).get(...args)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const check = (nombre, ok, detalle) => {
    total++
    if (ok) say(`  OK    ${nombre}`)
    else { fallos++; say(`  FALLA ${nombre}${detalle ? ` — ${detalle}` : ''}`) }
    return ok
  }

  return (async () => {
    say('')
    say('=== RECORRIDO DE COBRO A MANO (app real, ventana real, teclas reales) ===')
    say(`  base: ${db.paths.dataDir}`)

    // A blank screen is the hardest thing to debug from a screenshot, so the drive listens to the
    // renderer console and reports what the page itself complained about. `offline-selfcheck.invalid`
    // and the blocked inline script are the launch probe DELIBERATELY tripping the CSP to prove it
    // holds, so they are filtered: that is a passing security check, not a fault in the money path.
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level < 2) return
      if (/offline-selfcheck\.invalid/.test(message)) return
      if (/inline script/.test(message)) return
      say(`  [renderer] ${message} (${String(sourceId).split('/').pop()}:${line})`)
    })
    // A window created by a script does not necessarily hold OS focus, and `sendInputEvent`
    // delivers nothing to an unfocused window. Ask for both before driving keys at it.
    win.show()
    win.focus()
    say('')

    // ---- 0. who is on the till -------------------------------------------------------------
    // The first frame is the SIGN-IN PANEL, not the point of sale. This drive used to assert
    // `/pos` here and that assertion is GONE, not loosened: a machine that is switched on knows
    // nobody, so the honest first frame is the panel. What replaces it is a WALK of that panel
    // with real keystrokes, shared with the other two drives so the security path has one
    // definition instead of three copies.
    const sesion = await firmarComoDueño({
      win,
      base: { leer, esperarEn, buscar, tipear, sleep },
      check,
      say,
      db1
    })
    if (!sesion.ok) {
      check('la app abre con un operador en la caja antes de cobrar', false, sesion.motivo || 'no se pudo entrar')
      return finish()
    }

    // ---- 1. the till -------------------------------------------------------------------------
    // The window already finished its own first load; the app is now past the panel.
    await sleep(1500)
    const pantallaInicial = await leer(win, `(() => {
      const raiz = document.querySelector('#root');
      if (!raiz || !raiz.firstElementChild) return { ruta: location.pathname, vacio: true, texto: '' };
      return { ruta: location.pathname, vacio: false, texto: (raiz.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) };
    })()`)
    say(`  al abrir, la app queda en ${pantallaInicial?.ruta}${pantallaInicial?.vacio ? ' (React todavía no montó)' : `: "${pantallaInicial?.texto}"`}`)

    // A brand-new database seeds a business and a user but NO catalogue — a real install on a real
    // empty shelf. There is nothing to sell, so the drive stocks one product directly, BEFORE the
    // POS mounts, because the grid is fetched once when the screen mounts. That is not a shortcut
    // around the thing under test: the till, the ticket, the payment, the receipt and the
    // cancellation are all driven through the UI. It is said out loud so nobody reads this run as
    // a claim that the app ships with stock.
    if (db1(`SELECT COUNT(*) AS n FROM productos WHERE deleted_at IS NULL`).n === 0) {
      const negocio = db1(`SELECT id FROM negocios ORDER BY id LIMIT 1`)
      const usuario = db1(`SELECT id FROM users ORDER BY id LIMIT 1`)
      db.conn.db.prepare(`INSERT INTO productos
        (nombre, codigo, precio_centavos, precio_compra_centavos, stock_milli, stock_minimo_milli,
         user_id, negocio_id, activo, unidad_medida)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'unidad')`).run(
        'Gaseosa 500ml', 'DRINK-500', 1500, 900, 24000, 6000, usuario.id, negocio.id
      )
      say('  (la base nueva no trae catálogo: se carga una "Gaseosa 500ml" para poder cobrar)')
      // And then RELOAD, because a reload is what makes the app actually see it. The POS fetches
      // its catalogue with `staleTime: 5 * 60 * 1000`, and `CajaGuard` lets `PuntoDeVenta` mount
      // for a moment while the user is still loading — before the till exists. That early mount
      // fires the query, caches an empty catalogue, and the five-minute freshness window means the
      // grid is still empty long after the till opens and the product exists. Found by watching
      // the drive fail with a product sitting right there in the database.
      await recargar(win)
    }

    // THEN: walk to the sales screen the way a person does — the "Vender" link in the sidebar.
    if (!(await navegar(win, '/pos'))) {
      check('el POS se abre desde la barra lateral', false, `no se pudo llegar a /pos (ruta ${await leer(win, 'location.pathname')})`)
      return finish()
    }
    if (!(await esperarEn(win, `document.querySelector('.pos-container') || ${CAJA_CERRADA}`))) {
      check('la pantalla de venta se dibuja', false, 'no apareció la pantalla de venta ni el aviso de caja cerrada')
      return finish()
    }

    const cajaAbierta = db1(`SELECT id, saldo_inicial_centavos FROM cajas WHERE estado = 'abierta' AND deleted_at IS NULL`)
    if (!cajaAbierta) {
      const ofreceAbrir = await esperarEn(win, CAJA_CERRADA, 6000)
      check('sin caja abierta, la app pide abrir una antes de vender', ofreceAbrir)
      if (ofreceAbrir) {
        await tipear(win, { selector: CAMPO_FONDO, texto: '50000' })
        await sleep(250)
        await buscar(win, { texto: 'Abrir Caja' })
        await sleep(2000)
      }
    }
    const caja = db1(`SELECT id, saldo_inicial_centavos FROM cajas WHERE estado = 'abierta' AND deleted_at IS NULL`)
    check('la caja queda abierta, con su fondo', Boolean(caja), 'no quedó ninguna caja abierta')
    if (caja) say(`         caja #${caja.id}, fondo $${(caja.saldo_inicial_centavos / 100).toFixed(2)}`)

    // With the till open, CajaGuard steps aside and the real sales screen mounts.
    if (!(await esperarEn(win, `document.querySelector('.pos-container')`, 8000))) {
      check('con la caja abierta aparece la pantalla de venta', false, 'sigue sin aparecer la grilla de productos')
      return finish()
    }
    check('con la caja abierta aparece la pantalla de venta', true)

    // ---- 2. a product on the ticket ----------------------------------------------------------
    const hayProducto = await esperarEn(win, `!!document.querySelector('.pos-product-card:not(.stock-cero)')`, 6000)
    if (!hayProducto) {
      const enDb = db.conn.db.prepare(`SELECT nombre, stock_milli, activo FROM productos ORDER BY id LIMIT 8`).all()
      const tarjetas = await leer(win, `Array.from(document.querySelectorAll('.pos-product-card')).length`)
      const texto = await leer(win, `(() => { const e = document.querySelector('.pos-products'); return e ? (e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,160) : '(sin .pos-products)' })()`)
      say(`  [diagnóstico] tarjetas=${tarjetas} productos en base=${enDb.length}`)
      for (const p of enDb) say(`  [diagnóstico]   db: ${p.nombre} stock=${p.stock_milli} activo=${p.activo}`)
      say(`  [diagnóstico] grilla="${texto}"`)
    }
    check('el grid muestra productos con stock', hayProducto, 'el grid vino vacío')
    if (!hayProducto) return finish()

    const nombreProducto = await leer(win, `document.querySelector('.pos-product-card:not(.stock-cero)').textContent`)
    // The product's id comes off the CARD being clicked, not from `ORDER BY id LIMIT 1`.
    //
    // Those are different products whenever the grid is not sorted by insertion order, which is the
    // normal case: the POS sorts the shelf, so the first card is the first product ALPHABETICALLY,
    // while `ORDER BY id LIMIT 1` is the first product SEEDED. With the demo catalogue those are
    // "Aceite 900 ml" and "Queso artesanal" respectively, so the drive used to assert that Queso's
    // stock fell after selling oil — reported as "the stock did not go down" on a run where the
    // decrement was exactly right. A check aimed at the wrong row is worse than no check: it
    // invites someone to "fix" correct stock logic to satisfy it.
    const productoIdClickeado = await leer(win, `(() => {
      const card = document.querySelector('.pos-product-card:not(.stock-cero)');
      if (!card) return null;
      return card.dataset.productoId || card.getAttribute('data-producto-id') || null;
    })()`)
    const stockAntes = productoIdClickeado === null
      ? db1(`SELECT id, stock_milli, unidad_medida FROM productos WHERE deleted_at IS NULL ORDER BY id LIMIT 1`)
      : db1(`SELECT id, stock_milli, unidad_medida FROM productos WHERE id = ?`, Number(productoIdClickeado))
    await buscar(win, { selector: '.pos-product-card:not(.stock-cero)' })
    const enTicket = await esperarEn(win, `document.querySelectorAll('.cart-item').length > 0`)
    check('el clic del producto lo pone en el ticket', enTicket)
    say(`         producto: ${String(nombreProducto).replace(/\\s+/g, ' ').trim().slice(0, 46)}`)

    // ---- 3. F2 ------------------------------------------------------------------------------
    await pulsarF2(win)
    const abrioConF2 = await esperarEn(win, PAGO_ABIERTO, 5000)
    check('F2 abre la pantalla de cobro', abrioConF2, 'la tecla F2 no abrió el cobro')

    // ---- 4. take the money ------------------------------------------------------------------
    let cambioEnPantalla = null
    let tipeo = { ok: false, via: 'no se intentó' }
    if (abrioConF2) {
      // Tender ENOUGH, computed from what is actually in the ticket.
      //
      // This used to type a hardcoded `500` pesos. That was only ever true for the drive's own
      // throwaway product, which costs $15. Point the drive at a real catalogue — which is what
      // `verify-installed-e2e.mjs` does, seeding six products before selling — and the first card in
      // the grid may be a $2.400 oil, the tender comes up short, "Confirmar Venta" is correctly
      // disabled by `montoValido`, and the run fails on a harness assumption rather than on a
      // product defect. The app was right; the drive was wrong.
      //
      // The total is read off the modal's own "Total a cobrar" figure instead of recomputed from the
      // database, so the money typed in is compared against the same number the cashier sees. A round
      // note above it guarantees a non-zero change, which is what the next check looks for.
      const totalTexto = await leer(win, `(() => {
        const overlays = document.querySelectorAll('.modal-overlay');
        const raiz = overlays[overlays.length - 1] || document;
        const etiqueta = Array.from(raiz.querySelectorAll('p'))
          .find(p => (p.textContent || '').trim() === 'Total a cobrar');
        return etiqueta && etiqueta.nextElementSibling ? etiqueta.nextElementSibling.textContent.trim() : null;
      })()`)
      const totalPesos = totalTexto === null ? NaN : Number(String(totalTexto).replace(/[^\d,]/g, '').replace(',', '.'))
      if (!Number.isFinite(totalPesos) || totalPesos <= 0) {
        check('la pantalla muestra el total a cobrar', false, `no se pudo leer el total: ${JSON.stringify(totalTexto)}`)
        return finish()
      }
      // A whole peso note above the total, so the change is never zero and the "cambio" assertion
      // has something real to read. Rounded UP to the next 500 so the figure looks like money a
      // customer would actually hand over rather than an exact-match edge case.
      const aEntregar = Math.ceil((totalPesos + 1) / 500) * 500
      say(`         total $${totalPesos.toFixed(2)}, se entrega $${aEntregar.toFixed(2)}`)
      tipeo = await tipear(win, { selector: CAMPO_MINIMO, texto: String(aEntregar), dentroDelModal: true })
      await sleep(500)
      // Read the change the way the markup presents it: the label paragraph, then its next
      // sibling. Scraping dollars out of the whole modal's text is how a drive ends up matching
      // the "Total a cobrar" figure and confidently reporting the wrong number.
      cambioEnPantalla = await leer(win, `(() => {
        const overlays = document.querySelectorAll('.modal-overlay');
        const raiz = overlays[overlays.length - 1] || document;
        const etiqueta = Array.from(raiz.querySelectorAll('p'))
          .find(p => (p.textContent || '').trim() === 'Cambio a entregar');
        return etiqueta && etiqueta.nextElementSibling ? etiqueta.nextElementSibling.textContent.trim() : null;
      })()`)
      check('la pantalla muestra el cambio antes de confirmar', Boolean(cambioEnPantalla),
        'no se pudo leer el cambio en pantalla')
      if (!cambioEnPantalla) {
        const dentro = await leer(win, `(() => {
          const overlays = document.querySelectorAll('.modal-overlay');
          const m = overlays[overlays.length - 1];
          const inp = m && m.querySelector('input[placeholder^="M\\u00ednimo"]');
          return {
            valorTendido: inp ? inp.value : '(sin input)',
            parrafos: m ? Array.from(m.querySelectorAll('p')).map(p => (p.textContent||'').trim().slice(0,32)).join(' | ') : '(sin modal)',
            botones: m ? Array.from(m.querySelectorAll('button')).map(b => ((b.textContent||'').trim().slice(0,22)) + (b.disabled ? '[off]' : '')).join(' | ') : ''
          };
        })()`)
        say(`  [diagnóstico] tipeo=${tipeo?.ok} via=${tipeo?.via} foco=${await leer(win, `document.activeElement ? document.activeElement.tagName + '/' + (document.activeElement.getAttribute('placeholder')||'') : '(nada)'`)}`)
        say(`  [diagnóstico] tender digitado="${dentro?.valorTendido}"`)
        say(`  [diagnóstico] <p>=[${dentro?.parrafos}]`)
        say(`  [diagnóstico] botones=[${dentro?.botones}]`)
      }
      if (cambioEnPantalla) say(`         cambio mostrado: $${cambioEnPantalla}`)

      await buscar(win, { texto: 'Confirmar Venta', dentroDelModal: true })
    }
    const ticketVacio = await esperarEn(win, `document.querySelectorAll('.cart-item').length === 0`, 8000)
    await sleep(700)
    check('el ticket se vacía después de cobrar', ticketVacio)

    // ---- 5. what the shop file actually says -------------------------------------------------
    const venta = db1(`SELECT * FROM ventas ORDER BY id DESC LIMIT 1`)
    if (!check('la venta quedó escrita en la base real', Boolean(venta))) return finish()

    const totalPesos = venta.total_centavos / 100
    const recibido = venta.monto_recibido_centavos / 100
    const cambio = venta.monto_cambio_centavos / 100
    say(`         venta #${venta.folio}: total $${totalPesos.toFixed(2)}, recibido $${recibido.toFixed(2)}, cambio $${cambio.toFixed(2)}`)

    check('el cambio guardado es el que calculó el servidor',
      venta.monto_cambio_centavos === venta.monto_recibido_centavos - venta.total_centavos,
      `guardado $${cambio}, esperado $${(recibido - totalPesos).toFixed(2)}`)

      // The screen writes Argentine money: `$485,00` — and `formatCents` prepends its own symbol,
      // so the string can arrive as `$$485,00`. Parse the number out of it rather than eyeballing.
      const enNumero = cambioEnPantalla
        ? Number(String(cambioEnPantalla).replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.'))
        : NaN
      check('el cambio en pantalla es el mismo que quedó guardado',
        Number.isFinite(enNumero) && Math.abs(enNumero - cambio) < 0.005,
        `pantalla ${cambioEnPantalla}, base $${cambio}`)

    const movimiento = db1(`SELECT tipo, monto_centavos FROM movimientos_caja WHERE venta_id = ? ORDER BY id DESC LIMIT 1`, venta.id)
    check('el cajón registró el ingreso por el total',
      Boolean(movimiento) && movimiento.monto_centavos === venta.total_centavos,
      movimiento ? `movimiento $${(movimiento.monto_centavos / 100).toFixed(2)}` : 'no hay movimiento de caja')
    if (movimiento) say(`         cajón: ${movimiento.tipo} $${(movimiento.monto_centavos / 100).toFixed(2)}`)

    const stockDespues = db1(`SELECT stock_milli FROM productos WHERE id = ?`, stockAntes.id)
    check('el stock bajó con la venta', stockDespues.stock_milli < stockAntes.stock_milli,
      `${stockAntes.stock_milli} → ${stockDespues.stock_milli}`)
    say(`         stock (${stockAntes.unidad_medida}): ${(stockAntes.stock_milli / 1000).toFixed(3)} → ${(stockDespues.stock_milli / 1000).toFixed(3)}`)

    // ---- 6. cancel it, from the sales list ---------------------------------------------------
    // The POS is a full-screen takeover outside `app-layout`, so it has no sidebar. It used to have
    // no way out at all — and since the app now LAUNCHES on `/pos`, that made the sales list, and
    // therefore cancellation, unreachable after taking the money. The drive asserts the exit
    // exists, because that is the thing a person has.
    const haySalida = await esperarEn(win, `!!document.querySelector('#root a[href="/ventas"]')`, 4000)
    check('desde el punto de venta se puede salir a la lista de ventas', haySalida,
      'la pantalla de venta no tiene ni un enlace: no se puede volver a la lista de ventas')

    const llegueAVentas = await navegar(win, '/ventas')
    // Read the app, not the document. The launch probe renders its own results TABLE outside
    // `#root`, so a document-wide `querySelector('table')` finds the PROBE's table and cheerfully
    // reports a full list of PASS lines that has nothing to do with the shop.
    const enRaiz = `(() => { const r = document.querySelector('#root'); return r ? r.textContent || '' : '' })()`
    const enLista = await esperarEn(win, `${enRaiz}.includes(${JSON.stringify(venta.folio)})`, 10000)
    if (!enLista) {
      const estado = await leer(win, `(() => {
        const r = document.querySelector('#root');
        return {
          ruta: location.pathname,
          filas: r ? r.querySelectorAll('table tbody tr').length : -1,
          texto: r ? (r.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) : '(sin #root)'
        };
      })()`)
      say(`  [diagnóstico] lleguéAVentas=${llegueAVentas} ruta=${estado?.ruta} filas=${estado?.filas}`)
      say(`  [diagnóstico] app="${estado?.texto}"`)
    }
    check('la lista de ventas muestra la venta recién hecha', enLista)
    if (enLista) {
      await buscar(win, { selector: 'button[aria-label^="Ver detalle"]' })
      const abrioDetalle = await esperarEn(win, `!!document.querySelector('button[aria-label^="Ver detalle"]') && document.body.textContent.includes(${JSON.stringify(venta.folio)})`, 4000)
      await sleep(500)
      const ofreceCancelar = await esperarEn(win,
        `!!Array.from(document.querySelectorAll('button')).find(b => /Cancelar venta/i.test(b.textContent))`, 6000)
      check('el detalle ofrece cancelar la venta', ofreceCancelar && abrioDetalle)
      if (ofreceCancelar) {
        await buscar(win, { texto: 'Cancelar venta' })
        await esperarEn(win, `!!Array.from(document.querySelectorAll('button')).find(b => /Confirmar cancelaci/i.test(b.textContent))`)
        await sleep(300)
        await buscar(win, { texto: 'Confirmar cancelaci' })
        await sleep(1800)

        const cancelada = db1(`SELECT estado FROM ventas WHERE id = ?`, venta.id)
        check('la venta queda cancelada en la base', cancelada?.estado === 'cancelada', `estado=${cancelada?.estado}`)

        const stockFinal = db1(`SELECT stock_milli FROM productos WHERE id = ?`, stockAntes.id)
        check('el stock volvió al estante', stockFinal.stock_milli === stockAntes.stock_milli,
          `antes ${stockAntes.stock_milli}, ahora ${stockFinal.stock_milli}`)
        say(`         stock tras cancelar: ${(stockFinal.stock_milli / 1000).toFixed(3)} ${stockAntes.unidad_medida} (igual que antes de vender)`)

        const egreso = db1(`SELECT tipo, monto_centavos FROM movimientos_caja WHERE venta_id = ? AND tipo = 'egreso' ORDER BY id DESC LIMIT 1`, venta.id)
        check('el cajón registró la salida del dinero',
          Boolean(egreso) && egreso.monto_centavos === venta.total_centavos,
          egreso ? `egreso $${(egreso.monto_centavos / 100).toFixed(2)}` : 'no hay egreso')
        if (egreso) say(`         cajón: ${egreso.tipo} $${(egreso.monto_centavos / 100).toFixed(2)}`)
      }
    }

    return finish()
  })()

  function finish() {
    say('')
    say(fallos === 0
      ? `=== RECORRIDO DE COBRO: OK ${total}/${total} ===`
      : `=== RECORRIDO DE COBRO: FALLÓ ${total - fallos}/${total} ===`)
    say('')
    return { ok: fallos === 0, total, failed: fallos }
  }
}
