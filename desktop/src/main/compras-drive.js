/**
 * FIRSTHAND SUPPLIER AND PURCHASE DRIVE — goods arriving, in the real app, on real keys.
 *
 * `payment-drive.js` proves cash IN from a customer; `deudores-drive.js` proves collecting a debt.
 * Both are money leaving the shop. This proves the OTHER direction, and it is the direction that had
 * no screen at all until now: goods and money arriving TOGETHER — the one operation that moves stock,
 * changes the cost every later sale is measured against, and posts to the ledger.
 *
 * The claims, each of which `tests/db/compras.spec.js` also makes against a real database, but NONE
 * of which that suite can make about a running Electron process talking over a real preload:
 *
 *   1. A supplier is created FROM THE SCREEN, so a purchase has somebody to buy from.
 *   2. A purchase is recorded from the screen with a FRACTIONAL quantity, which the web's integer
 *      `cantidad` cannot express, and the stock moves by thousandths.
 *   3. The method actually changes the money: cash moves the DRAWER, card leaves it alone and posts
 *      to `1.1.02`, credit leaves it alone and posts to `2.1.01` as a payable.
 *   4. The supplier screen shows what is owed, DERIVED rather than stored.
 *   5. A purchase is cancellable from the screen: stock, cost and the mirrored entry come back.
 *   6. A CASH purchase cannot be cancelled with the till closed, and says so instead of losing the
 *      money. This is the one that would have shipped a permanent, invisible hole.
 *
 * WHY A SCRIPT AND NOT A HUMAN. Same argument as the other two drives: these claims are about a real
 * window, a real preload, a real `app://` origin and a real SQLite file. A jsdom suite cannot make
 * that claim, and a human clicking once cannot make it reproducibly.
 *
 * Gated on `MINIMARCK_COMPRAS_DRIVE=1`, launched by `scripts/drive-compras.mjs`, against a THROWAWAY
 * data directory so it can never touch a real shop's database.
 */

async function esperarEn(win, expr, ms = 8000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const ok = await win.webContents.executeJavaScript(`(() => { try { return !!(${expr}) } catch { return false } })()`)
    if (ok) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

import { firmarComoDueño } from './first-launch-signin.js'

/**
 * Click something by visible text or by selector.
 *
 * Returns `{ ok, via }` rather than a bare boolean, because "the click did not happen" and the
 * "click happened and nothing changed" are different bugs and a boolean cannot tell them apart. The
 * first version of this file returned a boolean and a caller asked it for `.ok`, so the check read
 * `undefined`, failed, and reported a form that had in fact been submitted correctly.
 */
function buscar(win, { texto, selector, tag = 'button', dentroDelModal = false }) {
  return win.webContents
    .executeJavaScript(`(() => {
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
      if (!el) return 'no está en la pantalla';
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    })()`)
    .then((r) => ({ ok: r === true, via: r === true ? 'clic' : r }))
}

/** Type into a controlled React input. Same three-way fallback as the other two drives. */
async function tipear(win, { selector, texto, dentroDelModal = false }) {
  // The window must be VISIBLE and focused before anything else, or a scripted `el.focus()` is
  // discarded, `document.activeElement` stays on `<body>`, and every keystroke goes nowhere — while
  // the element still exists and the selector still matches. That is the whole failure here: a
  // field that could not be typed into, with nothing in the DOM to show for it.
  //
  // `win.show()` comes first on purpose. `focus()` alone on a window that was never shown does not
  // make it the foreground window on Windows, and Chromium then refuses to deliver input to it.
  win.show()
  win.focus()
  await sleep(150)

  const localizado = await win.webContents.executeJavaScript(`(() => {
    const overlays = document.querySelectorAll('.modal-overlay');
    const raiz = ${dentroDelModal} ? (overlays[overlays.length - 1] || document) : document;
    const el = raiz.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height };
  })()`)
  if (!localizado) return { ok: false, via: 'no se encontró el campo' }

  // A REAL mouse click at the field's centre, not `el.focus()`. This is the same code path a
  // cashier's hand takes, and it is the only one that reliably hands the field the caret: scripted
  // focus is skipped for elements the compositor has not laid out yet, which is exactly the case
  // for a dialog that has just animated in.
  win.webContents.sendInputEvent({ type: 'mouseMove', x: localizado.x, y: localizado.y })
  win.webContents.sendInputEvent({ type: 'mouseDown', x: localizado.x, y: localizado.y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: localizado.x, y: localizado.y, button: 'left', clickCount: 1 })
  await sleep(120)
  // No "type an `a` then Backspace" to empty the field. It was here to clear leftovers, and it is
  // the reason a price field once reached `toCents` as "120.00a": the char and the Backspace are
  // queued to the renderer independently, so the deletion can be processed first and the `a`
  // survives into the value. A form field opened fresh is already empty, and the fallbacks below
  // already empty a field that is not. Clearing is the DOM's job, not a guess about event order.
  await sleep(60)

  // Focusing by script is not always enough: the window itself may not hold focus, and a
  // `document.activeElement` that never became the target means the keystrokes below would be
  // delivered to nothing. The real problem was found by asking the DOM which element has focus
  // instead of asking whether it is "some input", which cannot tell "no field" from "the wrong
  // field". `sendInputEvent` still requires the WINDOW to be focused, so it is asserted too.
  const enFoco = await win.webContents.executeJavaScript(
    `(() => { const a = document.activeElement; return a ? (a.tagName + '#' + (a.id || '') + '.' + (a.className || '')) : null })()`
  )
  if (!win.isFocused()) { win.show(); win.focus(); await sleep(120) }
  if (!/^(INPUT|TEXTAREA)/.test(String(enFoco) || '')) {
    return {
      ok: false,
      via:
        `nada tiene el foco (activeElement = ${JSON.stringify(enFoco)}) · ` +
        `pulsé en (${localizado.x},${localizado.y}) · rect ${JSON.stringify(localizado)} · ` +
        `ventana ${JSON.stringify(await win.webContents.executeJavaScript(
          '({w: innerWidth, h: innerHeight, dpr: devicePixelRatio, vis: document.visibilityState})'
        ))} · ` +
        `inputs ${JSON.stringify(await win.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('input,textarea,select')).map((e) => { const r = e.getBoundingClientRect(); return (e.id||e.type||e.tagName) + '@' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + (e.closest('form') ? '' : ' [sin form]') })`
        ).catch(() => 'n/a'))} · ` +
        `root ${String(await leer(win,
          `(document.getElementById('root')||{}).innerHTML ? (document.getElementById('root').innerHTML.replace(/\\s+/g,' ').slice(0,260)) : '(root vacío)'`
        ))} · ` +
        `page ${String(await leer(win,
          `(() => { const p = document.querySelector('.page'); if (!p) return '(no .page)'; const c = getComputedStyle(p); const r = p.getBoundingClientRect(); return c.display + ' ' + c.visibility + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' padre ' + (p.parentElement ? p.parentElement.className || p.parentElement.tagName : '?') })()`
        ))} · ` +
        // `Modal` sets `body { overflow: hidden }` while it is mounted and its cleanup restores
        // `unset`. That single value says whether the dialog is STILL OPEN after the click, which is
        // the difference between "the click missed the field" and "the click dismissed the form" —
        // two completely different bugs that otherwise look identical from the drive.
        `overflow ${String(await leer(win, 'document.body.style.overflow'))} · ` +
        `formAbierto ${String(await leer(win, `!!document.querySelector('#compra-proveedor') || !!document.querySelector('input#prov-nombre')`))} · ` +
        `dialogos ${String(await leer(win,
          `Array.from(document.querySelectorAll('h3')).map((h) => { const d = h.closest('div[style]') || h.parentElement; const r = d.getBoundingClientRect(); return JSON.stringify(h.textContent) + '@' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) }).join(' ; ') || '(ninguno)'`
        ))}`
    }
  }

  const valor = `(() => { const a = document.activeElement; return a && a.value !== undefined ? a.value : null })()`

  for (const ch of texto) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch })
    await sleep(40)
  }
  if ((await win.webContents.executeJavaScript(valor)) === texto) return { ok: true, via: 'sendInputEvent' }

  await win.webContents.executeJavaScript(`(() => {
    const el = document.activeElement;
    if (!el) return;
    el.value = '';
    el.focus();
    document.execCommand('insertText', false, ${JSON.stringify(texto)});
  })()`)
  await sleep(200)
  if ((await win.webContents.executeJavaScript(valor)) === texto) return { ok: true, via: 'execCommand' }

  await win.webContents.executeJavaScript(`(() => {
    const el = document.activeElement;
    if (!el) return;
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, ${JSON.stringify(texto)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await sleep(200)
  return { ok: (await win.webContents.executeJavaScript(valor)) === texto, via: 'setter+input' }
}

/**
 * A `<select>` has no text to type into, so it is set through React's own value setter plus a
 * `change` event. Setting `.value` alone would not notify React, and the state would keep the
 * previous option while the DOM showed the new one — a form that submits the wrong supplier.
 */
async function elegirOpcion(win, { selector, valor, dentroDelModal = false }) {
  const resultado = await win.webContents.executeJavaScript(`(() => {
    const overlays = document.querySelectorAll('.modal-overlay');
    const raiz = ${dentroDelModal} ? (overlays[overlays.length - 1] || document) : document;
    const el = raiz.querySelector(${JSON.stringify(selector)});
    if (!el) return 'no se encontró el select';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(String(valor))});
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value === ${JSON.stringify(String(valor))} ? true : 'el select no tomó el valor';
  })()`)
  return { ok: resultado === true, via: resultado === true ? 'setter+change' : resultado }
}

/**
 * Nothing in this file looks for `.modal-overlay`, and the reason is worth writing down.
 *
 * `components/common/Modal.jsx` renders an UNCLASSED fixed-position wrapper — there is no
 * `.modal-overlay` class anywhere in it. The two existing drives pass anyway because their
 * `dentroDelModal` helpers read `overlays[overlays.length - 1] || document`, and the `|| document`
 * quietly turns a class that matches nothing into "the whole document", which works only because
 * the other fields carry unique selectors. The first version of this file waited on
 * `.modal-overlay input#prov-nombre` and could therefore never pass: the selector describes a
 * screen that does not exist.
 *
 * The fix is NOT to add the class to the shared `Modal`. Every dialog in the app goes through that
 * one component, and the drive is not worth the risk of restyling it. The fields here have IDs
 * unique to this screen, so the document scope is precise on its own.
 */

/**
 * Click the nav link for a route and wait for the router to arrive.
 *
 * The failure path says WHAT WAS ON SCREEN, because a drive that reports only "it did not navigate"
 * cannot be debugged by the next person. The two existing drives discard the click's own result
 * here, which is why this one keeps it: a missing link and a link that was clicked and ignored are
 * completely different bugs, and only the first one is a missing screen. That distinction is what
 * turned up the missing POS nav below — the diagnostic printed `/ventas /deudores`, which is the
 * whole reason the two new screens were unreachable.
 */
async function navegar(win, ruta) {
  const habria = await buscar(win, { selector: `a[href="${ruta}"]`, tag: 'a' })
  const llego = await esperarEn(win, `location.pathname === ${JSON.stringify(ruta)}`, 8000)
  if (llego) return true
  const diagnostico = {
    habria: habria.via,
    donde: await leer(win, 'location.pathname'),
    enlaces: await leer(
      win,
      `Array.from(document.querySelectorAll('a[href]')).map((a) => a.getAttribute('href')).join(' ')`
    )
  }
  console.log(`  [drive] navegar a ${ruta} falló: ${JSON.stringify(diagnostico)}`)
  return false
}

async function recargar(win) {
  const listo = new Promise((r) => win.webContents.once('did-finish-load', () => r()))
  win.reload()
  await listo
  await sleep(1000)
}

function leer(win, expr) {
  return win.webContents.executeJavaScript(`(() => { try { return (${expr}) } catch { return null } })()`)
}

/**
 * Close whatever dialog is open, the way a person closes it: Escape.
 *
 * `Modal` listens for `keydown` Escape and calls `onClose`, and it sets `body { overflow: hidden }`
 * for exactly as long as it is mounted. That overflow flag is what this waits on, because it is the
 * only signal that says "a dialog is up" without guessing at the dialog's contents.
 *
 * This exists because `Compras.jsx:191` calls `setDetalle(creada)` after a successful purchase: the
 * app opens the purchase you just made, with its lines and its journal entry, which is the right
 * thing to do. The drive then carried on to the NEXT purchase underneath an open dialog — clicking
 * "Registrar compra" on a covered button, opening a form behind the detail, and typing into fields
 * that a second dialog was about to take away. A scripted `el.click()` reaches a button no matter
 * what is painted over it, so nothing complained until the focus check did.
 */
async function cerrarDialogo(win) {
  const abierto = await leer(win, `document.body.style.overflow === 'hidden'`)
  if (!abierto) return { ok: true, via: 'no había ningún diálogo abierto' }
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  const cerrado = await esperarEn(win, `document.body.style.overflow !== 'hidden'`, 6000)
  return { ok: cerrado, via: cerrado ? 'Escape' : 'el diálogo no se cerró con Escape' }
}

/**
 * Open a till the way the operator does it, which is through `CajaGuard`, not through the POS.
 *
 * `/pos` is wrapped in `CajaGuard` (`App.jsx:198`), and with no open till the guard never renders
 * the POS at all: it shows its own "Caja Cerrada" screen with an inline `type="number"`
 * `placeholder="0.00"` field and an "Abrir Caja" button. The POS has a *second*, unreachable
 * no-till screen of its own with a modal, and that one is what this helper was rewritten to drive
 * on the theory that the POS was in charge. The drive then sat on "Caja Cerrada", clicked the
 * button, and waited six seconds for a modal that belongs to a component that never mounts.
 *
 * So: the guard's field and button, with the state dumped on failure, because "no se pudo abrir
 * una caja" is not a diagnosis.
 */
async function abrirCajaDesde(win, db, centavos) {
  const estado = async () =>
    `ruta ${await leer(win, 'location.pathname')} · h2 ${JSON.stringify(await leer(win, `Array.from(document.querySelectorAll('h2')).map((h) => (h.textContent||'').trim())`))} · ` +
    `campo de fondo ${await leer(win, `!!document.querySelector('input[placeholder="0.00"]')`)} · ` +
    `cajas ${JSON.stringify(db.conn.db.prepare('SELECT id, estado FROM cajas ORDER BY id').all())} · ` +
    `texto ${JSON.stringify(String(await leer(win, `document.body.innerText`)).replace(/\s+/g, ' ').slice(0, 200))}`

  const campo = await esperarEn(win, `!!document.querySelector('input[placeholder="0.00"]')`, 8000)
  if (!campo) return { ok: false, via: `el formulario de apertura no apareció · ${await estado()}` }
  const tipeado = await tipear(win, { selector: 'input[placeholder="0.00"]', texto: String(centavos / 100) })
  if (!tipeado.ok) return { ok: false, via: `no se pudo escribir el fondo · ${tipeado.via}` }
  const abierto = await buscar(win, { texto: 'Abrir Caja' })
  if (!abierto.ok) return { ok: false, via: `no se pudo pulsar "Abrir Caja" · ${abierto.via}` }
  return { ok: true, via: 'CajaGuard: fondo escrito y "Abrir Caja" pulsado' }
}

export function runComprasDrive(win, db) {
  const lines = []
  let fallos = 0
  let total = 0
  const say = (s) => { lines.push(s); console.log(s) }

  /**
   * Errors thrown by the renderer, kept so a failing check can say WHY.
   *
   * React 18 unmounts the WHOLE tree when a render throws and there is no error boundary, and this
   * app has none. That is what a blank `#root` with zero children is: not an empty page, not a slow
   * page, a page that died. Without the renderer's own console output the only evidence is the
   * absence of buttons, which is a symptom, not a cause.
   *
   * Electron 44 passes a single event object to `console-message`; the old positional
   * `(event, level, message, line, sourceId)` signature was removed, so both shapes are read.
   */
  const erroresRender = []
  win.webContents.on('console-message', (...args) => {
    const ev = args[0] && typeof args[0] === 'object' ? args[0] : null
    const mensaje = ev ? ev.message : args[2]
    const nivel = ev ? ev.level : args[1]
    if (nivel === 'error' || nivel === 'warning' || nivel === 3 || nivel === 2) {
      erroresRender.push(String(mensaje).split('\n')[0].slice(0, 300))
    }
  })
  win.webContents.on('render-process-gone', (_e, detalles) => {
    erroresRender.push(`render-process-gone: ${detalles && detalles.reason}`)
  })
  /**
   * A reload looks exactly like a navigation away, and it resets the route to `/pos`.
   *
   * The card purchase failed on a screen that showed the till with only an "Abrir Caja" button,
   * which reads like the app decided to go back to the point of sale. It had not: the window had
   * RELOADED, so react-router started from `/` again and the till state came back from scratch.
   * Nothing in the output said so, because a reload is not an error and produces no console
   * message. These three events are logged so the next person does not have to guess which of the
   * two it was.
   */
  win.webContents.on('did-start-loading', () => say('  [drive] la ventana empezó a cargar (¿recarga?)'))
  win.webContents.on('did-finish-load', () => say('  [drive] la ventana terminó de cargar'))
  win.webContents.on('unresponsive', () => say('  [drive] la ventana quedó sin responder'))
  /**
   * Only the renderer's OWN problems, not the ones the offline self-check provokes on purpose.
   *
   * `scripts/verify-offline.mjs` deliberately tries to load a remote pixel and open a remote
   * EventSource, and the CSP blocks both. Those two messages are the expected result of a passing
   * test, and they arrive on the same channel as real crashes. Mixing them in made this file
   * report the offline check's noise as the reason a form failed to save, which points the next
   * person at the wrong subsystem entirely.
   */
   const RUIDO_ESPERADO = /offline-selfcheck\.invalid|violates the following Content Security Policy/
  const ultimoError = (n = 3) => {
    const propios = erroresRender.filter((m) => !RUIDO_ESPERADO.test(m))
    if (!propios.length) return ''
    return ` · errores del renderer: ${propios.slice(-n).join(' | ')}`
  }
  const db1 = (sql, ...args) => db.conn.db.prepare(sql).get(...args)
  const dbAll = (sql, ...args) => db.conn.db.prepare(sql).all(...args)
  const check = (nombre, ok, detalle) => {
    total++
    if (ok) say(`  OK    ${nombre}`)
    else { fallos++; say(`  FALLA ${nombre}${detalle ? ` — ${detalle}` : ''}`) }
    return ok
  }
  /**
   * Money for the log, in the same thousands style the screens use.
   *
   * `(c / 100).toFixed(2)` prints `$50000.00`, which is arithmetically right and unreadable: a
   * reviewer scanning the drive output is comparing hundreds of figures, and an unseparated
   * five-digit number is exactly the kind of thing a human stops seeing. The app's own
   * `formatCentavos` writes `$500,00`, so the log matches the screen.
   */
  const pesos = (c) =>
    `$${new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(c / 100)}`

  /**
   * The natural balance of an account, signed by its own type, exactly as the suite reads it: a
   * debit raises an asset and lowers a liability, so `2.1.01 Proveedores` reads POSITIVE when the
   * shop owes money. A single debit-positive convention would show a payable as a shortfall.
   */
  /**
   * The balance of an account, read the way a book reads it.
   *
   * `debe - haber` is right for an asset and exactly backwards for a liability, and the difference
   * is a sign, not a rounding error: a credit purchase credits `2.1.01 Proveedores`, so this helper
   * reported the shop as owing NEGATIVE $80,00. A number that comes out negative for a debt that
   * exists is worse than no number — it reads like a credit in the shop's favour.
   *
   * `cuentas_contables.tipo` is what decides it, and it is the same column the app groups its
   * reports by, so this is not a rule invented for the drive: `activo` and `gasto` grow on the debit
   * side, `pasivo`, `capital` and `ingreso` on the credit side. `1.1.01 Caja` is an asset and a cash
   * purchase credits it, which is why the drawer and the account can be compared with the same
   * helper and still have to come out EQUAL.
   */
  const saldo = (codigo) =>
    Number(db1(
      `SELECT COALESCE(SUM(CASE WHEN c.tipo IN ('activo','gasto')
                                  THEN d.debe_centavos - d.haber_centavos
                                  ELSE d.haber_centavos - d.debe_centavos END), 0) AS saldo
         FROM cuentas_contables c
         JOIN detalles_asientos d ON d.cuenta_contable_id = c.id
        WHERE c.codigo = ?`,
      codigo
    )?.saldo ?? 0)

  const saldoCajon = (cajaId) =>
    Number(db1(
      `SELECT saldo_inicial_centavos + total_ingresos_centavos - total_egresos_centavos AS saldo
         FROM cajas WHERE id = ?`,
      cajaId
    )?.saldo ?? 0)

  /** The account codes a purchase is read back by, grouped and summed the way a book would read. */
  const partidasDe = (referencia) => {
    const filas = dbAll(
      `SELECT c.codigo, SUM(d.debe_centavos) AS debe, SUM(d.haber_centavos) AS haber
         FROM detalles_asientos d
         JOIN asientos_contables a ON a.id = d.asiento_contable_id
         JOIN cuentas_contables c ON c.id = d.cuenta_contable_id
        WHERE a.referencia = ? GROUP BY c.codigo`,
      referencia
    )
    return {
      porCuenta: Object.fromEntries(filas.map((f) => [f.codigo, f])),
      balanceada: filas.reduce((s, f) => s + f.debe, 0) === filas.reduce((s, f) => s + f.haber, 0)
    }
  }

  const movimientos = () => dbAll(`SELECT * FROM movimientos_caja`).length
  const negocioId = db1(`SELECT id FROM negocios ORDER BY id LIMIT 1`).id

  /**
   * One purchase, filled in from the screen and submitted.
   *
   * `cantidad` is typed as the operator would type it, comma and all, because that is the whole
   * claim: the web's `cantidad` is an integer column and this is a weighed product.
   *
   * `productoId` is passed in rather than read from a closure: the product is looked up inside the
   * async body below, and a helper defined out here has no access to it.
   */
  async function comprarDesde(win, { proveedorId, productoId, metodo, cantidad, precio }) {
    /**
     * Wait for any PREVIOUS form to be completely gone before opening the next one.
     *
     * `Modal` is wrapped in `AnimatePresence`, which keeps the outgoing dialog mounted while it
     * animates out. So right after a purchase succeeds, `#compra-proveedor` is still in the DOM —
     * belonging to a form that is already closing. Opening the next form and then waiting for the
     * selector matched that dying one, and the second purchase typed into fields that were removed
     * halfway through: the first step of the card purchase reported a click at a real, correctly
     * laid-out field and the next step said the field did not exist.
     *
     * This is the race the drive exists to catch, and it is a race in the DRIVE, not the app: the
     * app behaves correctly, and only a driver that forgets the exit animation gets fooled.
     */
    if (!(await esperarEn(win, `!document.querySelector('#compra-proveedor')`, 8000))) {
      return { ok: false, motivo: 'el formulario anterior seguía en pantalla' }
    }
    // Whatever dialog the app chose to open after the last purchase gets closed first.
    const cerrado = await cerrarDialogo(win)
    if (!cerrado.ok) return { ok: false, motivo: `no se pudo cerrar el diálogo anterior (${cerrado.via})` }
    await buscar(win, { texto: 'Registrar compra' })
    if (!(await esperarEn(win, `!!document.querySelector('select#compra-proveedor')`, 8000))) {
      return { ok: false, motivo: 'el formulario no se abrió' }
    }
    const pasos = []
    pasos.push(['proveedor', await elegirOpcion(win, { selector: '#compra-proveedor', valor: proveedorId, dentroDelModal: true })])
    pasos.push(['producto', await elegirOpcion(win, { selector: '#item-prod-0', valor: productoId, dentroDelModal: true })])
    if (metodo !== 'efectivo') {
      pasos.push(['metodo', await elegirOpcion(win, { selector: '#compra-metodo', valor: metodo, dentroDelModal: true })])
    }
    await sleep(250)
    // WHEN the form disappears is the whole question, so it is asked at this point instead of being
    // inferred later from a field that stopped existing.
    if (!(await esperarEn(win, `!!document.querySelector('#compra-proveedor')`, 1500))) {
      return {
        ok: false,
        motivo:
          'el formulario se cerró al elegir proveedor, producto o método · ' +
          `ruta ${await leer(win, 'location.pathname')} · ` +
          `botones ${String(await leer(win, `Array.from(document.querySelectorAll('button')).map((b)=>(b.textContent||'').replace(/\\s+/g,' ').trim()).filter(Boolean).slice(0,8).join(' | ')`))}` +
          `${ultimoError()}`
      }
    }
    pasos.push(['cantidad', await tipear(win, { selector: '#item-cant-0', texto: cantidad, dentroDelModal: true })])
    pasos.push(['precio', await tipear(win, { selector: '#item-precio-0', texto: precio, dentroDelModal: true })])
    const fallados = pasos.filter(([, r]) => !r.ok)
    if (fallados.length) {
      return { ok: false, motivo: `no se pudo completar: ${fallados.map(([c, r]) => `${c} (${r.via})`).join(', ')}${ultimoError()}` }
    }
    // The submit is clicked BY SELECTOR, not by its text.
    //
    // `dentroDelModal` cannot help here: `Modal` renders no `.modal-overlay`, so the scope
    // degrades to the whole document, and `document.querySelectorAll('button')` returns the
    // page's own "Registrar compra" button — the one that OPENS the form — before the modal's
    // submit button. The first version of this file searched by text, so it clicked the button
    // that opens the form, over and over, and the purchase was never submitted.
    //
    // `form button[type="submit"]` is unambiguous: the form's submit is the only one on the screen.
    const enviado = await buscar(win, { selector: 'form button[type="submit"]' })
    if (!enviado.ok) return { ok: false, motivo: `no se encontró el botón de enviar (${enviado.via})` }
    /**
     * The confirmation is matched against the EXACT success message, not the word "registrada".
     *
     * `body.textContent.includes('registrada')` is what this used, and it is a check that cannot
     * fail: `Compras.jsx:281` renders the empty state as "Todavía no hay compras registradas.", so
     * a screen where the purchase was rejected and nothing was written satisfied it. The drive
     * reported "una compra en efectivo se registra desde la pantalla: OK" for a purchase that did
     * not exist, and the next check blamed the server's arithmetic for a row that was never there.
     *
     * `Compra <folio> registrada:` is the shape of the real toast, and the empty state cannot
     * produce it. The form closing is checked too, because a rejected submission keeps the form
     * open and a successful one does not.
     */
    const exito = /Compra\s+\S+\s+registrada:/
    const registro = await esperarEn(win, `${exito}.test(document.body.textContent)`, 12000)
    const formCerrado = await esperarEn(win, `!document.querySelector('#compra-proveedor')`, 6000)
    await sleep(600)
    if (!registro) {
      const visibles = String(await leer(
        win,
        `Array.from(document.querySelectorAll('div,span,p')).map((n) => (n.textContent||'').trim()).filter((t) => t && t.length < 120 && /no se pudo|error|inválid|necesita|mayor a cero/i.test(t)).slice(0,4).join(' | ') || '(sin mensaje visible)'`
      )).slice(0, 300)
      return { ok: false, motivo: `no se confirmó el registro · ${visibles}${ultimoError()}` }
    }
    // The app opens the purchase it just made — lines, journal entry and all — and the drive has
    // to put that away before it goes looking for anything else on the page.
    await cerrarDialogo(win)
    return { ok: true, motivo: formCerrado ? null : 'registró, pero el formulario siguió abierto' }
  }

  /**
   * Cancel a purchase from the list, through the confirmation `Modal`.
   *
   * The `Modal` is the point. The first version of this screen used `window.confirm`, which blocks
   * the renderer on a native prompt no other screen in this app uses and that a drive cannot
   * answer — so a `window.confirm` here would have made the cancellation claim untestable by
   * construction. The button carries `data-testid` for the same reason `Deudores`' payment
   * confirmation does.
   */
  async function cancelarDesde(win, folio) {
    const cible = await win.webContents.executeJavaScript(`(() => {
      const tr = Array.from(document.querySelectorAll('tbody tr'))
        .find((n) => (n.textContent || '').includes(${JSON.stringify(folio)}));
      if (!tr) return 'no se encontró la compra en la tabla';
      const b = Array.from(tr.querySelectorAll('button')).find((n) => (n.textContent||'').includes('Cancelar'));
      if (!b) return 'la fila no tiene botón Cancelar';
      b.click();
      return true;
    })()`)
    if (cible !== true) return { ok: false, motivo: cible }
    if (!(await esperarEn(win, `!!document.querySelector('[data-testid="confirmar-cancelar-compra"]')`, 6000))) {
      return { ok: false, motivo: 'no apareció la confirmación' }
    }
    await buscar(win, { selector: '[data-testid="confirmar-cancelar-compra"]', tag: 'button' })
    return { ok: true }
  }

  return (async () => {
    say('')
    say('=== RECORRIDO DE PROVEEDORES Y COMPRAS A MANO (app real, ventana real, teclas reales) ===')
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

    // ---- 0. who is on the till -------------------------------------------------------------
    // The app opens SIGNED OUT. A purchase is a decision somebody made, so this drive has to say
    // who before it buys anything — with the shared walk, real keystrokes on the real panel, so
    // there is one definition of the security path instead of three copies that drift.
    const sesion = await firmarComoDueño({
      win,
      base: { leer, esperarEn, buscar, tipear, sleep },
      check,
      say,
      db1
    })
    if (!sesion.ok) {
      check('hay un operador en la caja antes de comprar', false, sesion.motivo || 'no se pudo entrar')
      return finish()
    }

    // ---- 0. a shelf to buy onto ------------------------------------------------------------
    // Said out loud for the same reason the other two drives say it: a fresh install has no
    // catalogue. The product is WEIGHED, because a fractional purchase is the point of this drive
    // and a fractional purchase of a discrete item would be nonsense.
    if (db1(`SELECT COUNT(*) AS n FROM productos WHERE deleted_at IS NULL`).n === 0) {
      const usuario = db1(`SELECT id FROM users ORDER BY id LIMIT 1`)
      db.conn.db
        .prepare(
          `INSERT INTO productos
             (nombre, codigo, precio_centavos, precio_compra_centavos, stock_milli, stock_minimo_milli,
              user_id, negocio_id, activo, unidad_medida)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'kg')`
        )
        .run('Queso artesanal', 'QUESO-1', 20000, 12000, 10000, 1000, usuario.id, negocioId)
      // A SECOND product, and it is not decoration.
      //
      // `compras.repo.js` refuses to cancel a purchase whose product's cost or stock has moved
      // since — the bounded-reversibility rule, and it is correct: a cancellation recomputes the
      // moving average from the recorded state, and a later purchase would make that number a lie.
      // With every purchase on one product, the credit purchase made the cash and card purchases
      // permanently uncancellable, so the drive could not test cancellation AT ALL and reported the
      // guard's own message as a failure of the cancellation feature.
      //
      // The credit purchase therefore buys a DIFFERENT product, which is also what a shop does:
      // repaying one supplier's invoice does not depend on what you bought from another. The cash
      // and card purchases share a product, and cancelling the card one puts that product back to
      // the state the cash purchase recorded, so the cash cancellation is still legitimate.
      db.conn.db
        .prepare(
          `INSERT INTO productos
             (nombre, codigo, precio_centavos, precio_compra_centavos, stock_milli, stock_minimo_milli,
              user_id, negocio_id, activo, unidad_medida)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'kg')`
        )
        .run('Miel de campo 1kg', 'MIEL-1', 15000, 9000, 6000, 500, usuario.id, negocioId)
      say('  (la base nueva no trae catálogo: se cargan "Queso artesanal" pesado, 10 kg a $200,00, y "Miel de campo 1kg")')
      await recargar(win)
    }
    const producto = db1(`SELECT * FROM productos WHERE codigo = 'QUESO-1' AND deleted_at IS NULL`)
    const productoCredito = db1(`SELECT * FROM productos WHERE codigo = 'MIEL-1' AND deleted_at IS NULL`)

    // ---- 1. a till, because one of the three methods needs it -------------------------------
    if (!(await navegar(win, '/pos'))) {
      check('el POS se abre desde la barra superior', false, `ruta ${await leer(win, 'location.pathname')}`)
      return finish()
    }
    let caja = db1(`SELECT id, saldo_inicial_centavos FROM cajas WHERE estado = 'abierta' AND deleted_at IS NULL`)
    if (!caja) {
      const apertura = await abrirCajaDesde(win, db, 50000)
      await sleep(1500)
      if (!check('sin caja abierta, el POS deja abrir una', apertura.ok, apertura.via)) return finish()
    }
    caja = db1(`SELECT id, saldo_inicial_centavos FROM cajas WHERE estado = 'abierta' AND deleted_at IS NULL`)
    if (!check('la caja queda abierta, con su fondo', Boolean(caja), 'no quedó ninguna caja abierta')) return finish()
    const fondo = caja.saldo_inicial_centavos
    say(`         caja #${caja.id}, fondo ${pesos(fondo)}`)

    // ---- 2. a supplier, FROM THE SCREEN -----------------------------------------------------
    if (!(await navegar(win, '/proveedores'))) {
      check('la pantalla de proveedores se abre desde la barra', false, `ruta ${await leer(win, 'location.pathname')}`)
      return finish()
    }
    // The heading has to be THIS screen's heading. `document.querySelector('h2')` was the first
    // version of this check and it was worthless: every screen in the app has an `h2`, the POS
    // included, so it passed while the drive sat on the till — which is exactly the failure it was
    // added to catch. A check that cannot fail is not a check.
    if (!check(
      'la pantalla de proveedores es la que se ve, con su propio título',
      await esperarEn(win, `(document.querySelector('h2')||{}).textContent === 'Proveedores'`, 5000),
      `título real: ${String(await leer(win, `(document.querySelector('h2')||{}).textContent`))}`
    )) {
      return finish()
    }

    const NOMBRE = 'Distribuidora del Sur'
    if (!db1(`SELECT id FROM proveedores WHERE nombre = ? AND deleted_at IS NULL`, NOMBRE)) {
      await buscar(win, { texto: 'Nuevo proveedor' })
      if (!(await esperarEn(win, `!!document.querySelector('input#prov-nombre')`, 8000))) {
        // Say what the buttons on screen actually are. "The form did not open" is not a
        // diagnosis; `texto del botón = 52` is. A drive that cannot name what it saw cannot be
        // fixed by the next person, only re-run.
        check('el formulario de proveedor se abre', false,
          `no apareció #prov-nombre · ruta ${await leer(win, 'location.pathname')} · ` +
          `botones ${String(await leer(win, `document.querySelectorAll('button').length`))} · ` +
          `#root hijos ${String(await leer(win, `(document.getElementById('root')||{children:[]}).children.length`))} · ` +
          `body ${String(await leer(win, 'document.body.innerHTML.replace(/\\s+/g," ").slice(0,220)'))}${ultimoError()}`)
        return finish()
      }
      // `tipear` tries real keys, then `execCommand`, then React's value setter, and reports WHICH
      // one worked. That report is checked here, and the field is read back by id. Skipping it is
      // how this step produced a form that was submitted empty: the browser then refused to submit
      // it ("An invalid form control with name='' is not focusable"), the row never appeared, and
      // the only visible symptom was a missing supplier.
      const nombreTipeado = await tipear(win, { selector: 'input#prov-nombre', texto: NOMBRE, dentroDelModal: true })
      if (!check('el nombre del proveedor se escribe en el campo', nombreTipeado.ok,
        `vía ${nombreTipeado.via}, valor real ${JSON.stringify(await leer(win, `(document.querySelector('input#prov-nombre')||{}).value`))}${ultimoError()}`)) return finish()
      const rucTipeado = await tipear(win, { selector: 'input#prov-ruc', texto: '20987654321', dentroDelModal: true })
      check('el RUC del proveedor se escribe en el campo', rucTipeado.ok, `vía ${rucTipeado.via}`)
      // The click's own result is checked, and the form is read back. A save that silently fails
      // looks exactly like a save that worked if all you check afterwards is whether the row landed
      // in the database — and the first version of this drive did exactly that, so a form that
      // never submitted was reported as "el proveedor no apareció" with no way to tell the two
      // apart.
      const guardado = await buscar(win, { texto: 'Guardar', dentroDelModal: true })
      const valorEnPantalla = await leer(win, `(document.querySelector('input#prov-nombre')||{}).value || null`)
      await sleep(1800)
      if (!check('el formulario de proveedor se envía y se cierra', guardado.ok, `clic en Guardar: ${guardado.via}`)) {
        check('un proveedor se crea desde la pantalla, sin editor de base de datos', false,
          `#prov-nombre valía ${JSON.stringify(valorEnPantalla)} al pulsar Guardar${ultimoError()}`)
        return finish()
      }
    }
    const proveedor = db1(`SELECT id, nombre FROM proveedores WHERE nombre = ? AND deleted_at IS NULL`, NOMBRE)
    if (!check('un proveedor se crea desde la pantalla, sin editor de base de datos', Boolean(proveedor),
      `no apareció el proveedor${ultimoError()}`)) return finish()
    say(`         proveedor ${proveedor.nombre} (#${proveedor.id})`)

    const filaProveedor = await leer(
      win,
      `(() => {
        const r = Array.from(document.querySelectorAll('tbody tr')).find((n) => (n.textContent||'').includes(${JSON.stringify(NOMBRE)}));
        return r ? r.textContent : null;
      })()`
    )
    // The row is checked for the things a supplier row must show, and the "no debt" state is
    // checked as the DASH this screen uses for it. The first version of this check looked for
    // `$0,00` and failed against a screen that deliberately prints `-` when nothing is owed: a
    // derived figure of zero is not a price, and printing `$0,00` in a money column for every new
    // supplier is noise. The pending figure gets a real assertion further down, with a credit
    // purchase that leaves an actual amount in it.
    check('el proveedor aparece en la tabla, con su RUC y su estado',
      String(filaProveedor).includes(NOMBRE) &&
        String(filaProveedor).includes('20987654321') &&
        String(filaProveedor).includes('Activo'),
      `fila: ${String(filaProveedor).replace(/\s+/g, ' ').slice(0, 140)}`)

    // ---- 3. a CASH purchase with a FRACTIONAL quantity --------------------------------------
    if (!(await navegar(win, '/compras'))) {
      check('la pantalla de compras se abre desde la barra', false, `ruta ${await leer(win, 'location.pathname')}`)
      return finish()
    }
    if (!check(
      'la pantalla de compras es la que se ve, con su propio título',
      await esperarEn(win, `(document.querySelector('h2')||{}).textContent === 'Compras'`, 5000),
      `título real: ${String(await leer(win, `(document.querySelector('h2')||{}).textContent`))}`
    )) {
      return finish()
    }

    const CANTIDAD = '2,5'
    const PRECIO = '120.00'
    const ESPERADO = 30000 // 2,5 kg x $120,00

    const stockAntes = Number(producto.stock_milli)
    const costoAntes = Number(producto.precio_compra_centavos)
    const movAntes = movimientos()

    const compraCash = await comprarDesde(win, {
      proveedorId: proveedor.id, productoId: producto.id, metodo: 'efectivo', cantidad: CANTIDAD, precio: PRECIO
    })
    if (!check('una compra en efectivo se registra desde la pantalla', compraCash.ok, compraCash.motivo)) return finish()

    const cash = db1(`SELECT * FROM compras WHERE proveedor_id = ? ORDER BY id DESC LIMIT 1`, proveedor.id)
    // `?? 0` used to stand in for a missing row, so "no purchase was created" and "the purchase
    // was created for $0" printed the same `$0,00` and this check could not tell them apart. It
    // reported a server arithmetic bug for what was really a row that did not exist.
    if (!check('el total lo calculó el servidor, no la pantalla', cash?.total_centavos === ESPERADO,
      cash
        ? `total ${pesos(cash.total_centavos)}, esperado ${pesos(ESPERADO)} · líneas ${JSON.stringify(
            dbAll(`SELECT producto_id, cantidad_milli, precio_unitario_centavos, subtotal_centavos
                     FROM compras_detalles WHERE compra_id = ?`, cash.id)
          )}`
        : `no hay ninguna compra del proveedor #${proveedor.id} · toast: ${String(await leer(
            win,
            `Array.from(document.querySelectorAll('[role="alert"],.Toastify__toast')).map((n)=>n.textContent.replace(/\\s+/g,' ').trim()).join(' | ') || '(ninguno)'`
          )).slice(0, 300)}${ultimoError()}`)) return finish()
    say(`         compra ${cash.folio}: ${CANTIDAD} kg x ${pesos(12000)} = ${pesos(cash.total_centavos)}`)

    const despues = db1(`SELECT * FROM productos WHERE id = ?`, producto.id)
    check('una cantidad fraccionaria suma en milésimas: 10 kg + 2,5 kg = 12,5 kg',
      Number(despues.stock_milli) === stockAntes + 2500,
      `stock ${despues.stock_milli}, antes ${stockAntes}`)

    /**
     * The moving average is checked against the number it MUST be, not against "it changed".
     *
     * This product was seeded at $120,00 and this purchase is at $120,00, so a correct weighted
     * average is $120,00 before and after. The first version of this check asserted
     * `costoDespues !== costoAntes` and failed on correct arithmetic — the worst kind of drive
     * failure, because the only way to satisfy it is to break the code. Buying at a different price
     * is what proves the average MOVES, and the card purchase below does exactly that.
     */
    const promedioEsperado = Math.round((stockAntes * costoAntes + 2500 * 12000) / (stockAntes + 2500))
    check('el costo promedio pondera stock y precio de la compra', Number(despues.precio_compra_centavos) === promedioEsperado,
      `costo ${pesos(despues.precio_compra_centavos)}, esperado ${pesos(promedioEsperado)} (comprar al mismo precio no lo mueve: antes ${pesos(costoAntes)})`)
    say(`         stock ${(stockAntes / 1000).toFixed(1)} → ${(despues.stock_milli / 1000).toFixed(1)} kg, costo ${pesos(costoAntes)} → ${pesos(despues.precio_compra_centavos)}`)

    check('el efectivo SÍ movió el cajón', movimientos() === movAntes + 1,
      `antes ${movAntes}, ahora ${movimientos()}`)
    check('el cajón bajó exactamente el total de la compra', saldoCajon(caja.id) === fondo - ESPERADO,
      `cajón ${pesos(saldoCajon(caja.id))}, esperado ${pesos(fondo - ESPERADO)}`)

    const entradaCash = partidasDe(`compra:${cash.id}`)
    check('el asiento de la compra queda balanceado', entradaCash.balanceada, 'debe y haber no coinciden')
    check('1.2.01 Mercaderías recibe el total de la compra',
      entradaCash.porCuenta['1.2.01']?.debe === ESPERADO,
      `1.2.01 debe ${pesos(entradaCash.porCuenta['1.2.01']?.debe ?? 0)}`)
    check('1.1.01 Caja paga el total de la compra',
      entradaCash.porCuenta['1.1.01']?.haber === ESPERADO,
      `1.1.01 haber ${pesos(entradaCash.porCuenta['1.1.01']?.haber ?? 0)}`)
    say(`         1.2.01 Mercaderías debe ${pesos(entradaCash.porCuenta['1.2.01']?.debe ?? 0)}, 1.1.01 Caja haber ${pesos(entradaCash.porCuenta['1.1.01']?.haber ?? 0)}`)
    check('el efectivo está en la cuenta Y en el cajón, con el mismo número',
      saldo('1.1.01') === saldoCajon(caja.id),
      `cuenta ${pesos(saldo('1.1.01'))} vs cajón ${pesos(saldoCajon(caja.id))}`)

    // ---- 4. a CARD purchase: same stock, no drawer ------------------------------------------
    const movAntesCard = movimientos()
    const stockAntesCard = Number(db1(`SELECT stock_milli FROM productos WHERE id = ?`, producto.id).stock_milli)
    const compraCard = await comprarDesde(win, {
      proveedorId: proveedor.id, productoId: producto.id, metodo: 'tarjeta', cantidad: '1', precio: '100.00'
    })
    if (!check('una compra con tarjeta se registra', compraCard.ok, compraCard.motivo)) return finish()
    const card = db1(`SELECT * FROM compras WHERE proveedor_id = ? ORDER BY id DESC LIMIT 1`, proveedor.id)

    check('una compra con tarjeta SÍ mueve el stock',
      Number(db1(`SELECT stock_milli FROM productos WHERE id = ?`, producto.id).stock_milli) === stockAntesCard + 1000)
    check('una compra con tarjeta NO toca el cajón', movimientos() === movAntesCard,
      `antes ${movAntesCard}, ahora ${movimientos()}`)
    const entradaCard = partidasDe(`compra:${card.id}`)
    check('la tarjeta entra por 1.1.02 Banco, no por la caja',
      entradaCard.porCuenta['1.1.02']?.haber === 10000 && !entradaCard.porCuenta['1.1.01'],
      `1.1.02 haber ${pesos(entradaCard.porCuenta['1.1.02']?.haber ?? 0)}`)
    check('el asiento con tarjeta también queda balanceado', entradaCard.balanceada)
    say(`         compra con tarjeta ${pesos(10000)} contra 1.1.02 Banco, cajón sin cambios`)

    // ---- 5. a CREDIT purchase: a real payable ------------------------------------------------
    const movAntesCredito = movimientos()
    // The SECOND product, so this purchase does not move the cost that the two cancellable
    // purchases recorded. See the note where it is seeded.
    const compraCredito = await comprarDesde(win, {
      proveedorId: proveedor.id, productoId: productoCredito.id, metodo: 'credito', cantidad: '1', precio: '80.00'
    })
    if (!check('una compra a crédito se registra', compraCredito.ok, compraCredito.motivo)) return finish()
    const credito = db1(`SELECT * FROM compras WHERE proveedor_id = ? ORDER BY id DESC LIMIT 1`, proveedor.id)

    check('una compra a crédito SÍ suma stock, en el otro producto',
      Number(db1(`SELECT stock_milli FROM productos WHERE id = ?`, productoCredito.id).stock_milli) === 7000,
      `stock ${db1('SELECT stock_milli FROM productos WHERE id = ?', productoCredito.id).stock_milli}, esperado 7000`)
    check('una compra a crédito queda PENDIENTE', credito?.estado === 'pendiente', `estado ${credito?.estado}`)
    check('una compra a crédito NO toca el cajón', movimientos() === movAntesCredito,
      `antes ${movAntesCredito}, ahora ${movimientos()}`)
    check('2.1.01 Proveedores recibe la deuda', saldo('2.1.01') === 8000,
      `2.1.01 = ${pesos(saldo('2.1.01'))}, esperado ${pesos(8000)}`)
    const entradaCredito = partidasDe(`compra:${credito.id}`)
    check('el crédito entra por 2.1.01, no por la caja',
      entradaCredito.porCuenta['2.1.01']?.haber === 8000 && !entradaCredito.porCuenta['1.1.01'],
      `2.1.01 haber ${pesos(entradaCredito.porCuenta['2.1.01']?.haber ?? 0)}`)
    say(`         compra a crédito ${pesos(8000)} contra 2.1.01 Proveedores, queda pendiente`)

    // The supplier screen now shows that owed figure — derived by a subquery, not stored on the row.
    await navegar(win, '/proveedores')
    await sleep(1400)
    const filaConDeuda = await leer(
      win,
      `(() => {
        const r = Array.from(document.querySelectorAll('tbody tr')).find((n) => (n.textContent||'').includes(${JSON.stringify(NOMBRE)}));
        return r ? r.textContent : null;
      })()`
    )
    check('la pantalla de proveedores muestra lo que se le debe, sin guardarlo en la fila',
      String(filaConDeuda).includes('80'),
      `fila: ${String(filaConDeuda).replace(/\s+/g, ' ').slice(0, 140)}`)

    // ---- 6. cancel the CARD purchase: stock, cost and entry come back ------------------------
    await navegar(win, '/compras')
    await sleep(1000)
    const stockPreCanc = Number(db1(`SELECT stock_milli FROM productos WHERE id = ?`, producto.id).stock_milli)
    const movPreCanc = movimientos()
    const cancelacion = await cancelarDesde(win, card.folio)
    if (check('una compra se cancela desde la pantalla, con su confirmación', cancelacion.ok, cancelacion.motivo)) {
      await sleep(1500)
      check('la compra queda marcada como cancelada',
        db1(`SELECT estado FROM compras WHERE id = ?`, card.id)?.estado === 'cancelada',
        `estado ${db1('SELECT estado FROM compras WHERE id = ?', card.id)?.estado}`)
      check('al cancelar, el stock vuelve atrás',
        Number(db1(`SELECT stock_milli FROM productos WHERE id = ?`, producto.id).stock_milli) === stockPreCanc - 1000,
        `stock ${db1('SELECT stock_milli FROM productos WHERE id = ?', producto.id).stock_milli}, esperado ${stockPreCanc - 1000}`)
      check('una compra con tarjeta anulada NO devuelve efectivo al cajón', movimientos() === movPreCanc,
        `antes ${movPreCanc}, ahora ${movimientos()}`)
      const anulacion = partidasDe(`compra:${card.id}`)
      check('la anulación postea el asiento espejo, con las cuentas al revés',
        anulacion.porCuenta['1.1.02']?.debe === 10000 && anulacion.porCuenta['1.2.01']?.haber === 10000,
        `1.1.02 debe ${pesos(anulacion.porCuenta['1.1.02']?.debe ?? 0)}, 1.2.01 haber ${pesos(anulacion.porCuenta['1.2.01']?.haber ?? 0)}`)
      check('el asiento de anulación también queda balanceado', anulacion.balanceada)
      say(`         compra con tarjeta anulada: stock ${(stockPreCanc / 1000).toFixed(1)} → ${(db1('SELECT stock_milli FROM productos WHERE id = ?', producto.id).stock_milli / 1000).toFixed(1)} kg`)
    }

    // ---- 7. a CASH purchase cannot be cancelled with the till CLOSED ------------------------
    // The hole. Without the refusal, the reversal entry posts, `1.1.01` is credited, the purchase
    // is marked cancelled and the money is never handed back — with both screens agreeing it was.
    db.conn.db
      .prepare(
        `UPDATE cajas
            SET estado = 'cerrada', fecha_cierre = ?,
                saldo_final_centavos = saldo_inicial_centavos + total_ingresos_centavos - total_egresos_centavos
          WHERE id = ?`
      )
      .run(new Date().toISOString(), caja.id)
    say('         (se cierra la caja a propósito, para probar que el efectivo no se pierde)')

    const saldosAntes = { cajon: saldoCajon(caja.id), cuenta: saldo('1.1.01') }
    const anulacionCash = await cancelarDesde(win, cash.folio)
    if (check('la pantalla permite intentar anular la compra en efectivo', anulacionCash.ok, anulacionCash.motivo)) {
      await sleep(1800)
      const toast = await leer(
        win,
        `Array.from(document.querySelectorAll('.Toastify__toast, [role="alert"]'))
           .map((t) => (t.textContent || '').replace(/\\s+/g, ' ').trim()).join(' || ') || '(sin toast)'`
      )
      check('la pantalla explica que hace falta una caja abierta, en vez de fallar en silencio',
        /caja abierta/i.test(String(toast)), `toast: ${String(toast).slice(0, 160)}`)
      check('la compra en efectivo sigue viva después del rechazo',
        db1(`SELECT estado FROM compras WHERE id = ?`, cash.id)?.estado === 'completada',
        `estado ${db1('SELECT estado FROM compras WHERE id = ?', cash.id)?.estado}`)
      check('el rechazo no movió el cajón', saldoCajon(caja.id) === saldosAntes.cajon,
        `cajón ${pesos(saldoCajon(caja.id))}, antes ${pesos(saldosAntes.cajon)}`)
      check('el rechazo no movió la cuenta 1.1.01', saldo('1.1.01') === saldosAntes.cuenta,
        `cuenta ${pesos(saldo('1.1.01'))}, antes ${pesos(saldosAntes.cuenta)}`)
      say(`         con la caja cerrada: se niega, el cajón sigue en ${pesos(saldoCajon(caja.id))} y el efectivo no se pierde`)
    }

    // ---- 8. and it DOES cancel once a till is open again ------------------------------------
    // Otherwise the refusal above is just a locked door: the money must come back when a drawer
    // exists, or the operator is stuck with a purchase they cannot undo.
    await cerrarDialogo(win)
    // A RELOAD, not a navigation, and the difference is the whole bug.
    //
    // The till was closed a few lines ago with raw SQL, behind the running app's back. The repos see
    // that immediately — which is why the cash cancellation was correctly refused a moment ago —
    // but `CajaContext` verifies the till once per session and never polls, so the POS was still
    // rendering its full register on a drawer the database had already closed. Clicking around that
    // screen could never reach the opening form, because the opening form is behind `CajaGuard` and
    // `CajaGuard` only asks when `cajaActiva` is empty.
    //
    // Reloading is not a trick to get past a product bug: it is what a terminal does when another
    // one closed the drawer, and it is the only honest way for a process to observe a change made
    // outside itself.
    await recargar(win)
    const alPos = await navegar(win, '/pos')
    await sleep(1000)
    const apertura = await abrirCajaDesde(win, db, 50000)
    await sleep(2000)
    const nuevaCaja = db1(`SELECT id FROM cajas WHERE estado = 'abierta' AND deleted_at IS NULL`)
    // Every one of these used to be an unchecked `await`, so a navigation that failed silently left
    // the drive on the previous screen and the only symptom was "no se pudo abrir una caja".
    if (!check('con la caja cerrada, se puede abrir una caja nueva',
      Boolean(nuevaCaja),
      `navegación ${alPos ? 'ok' : 'FALLÓ'} · apertura ${apertura.via} · ruta ${await leer(win, 'location.pathname')} · ` +
      `cajas ${JSON.stringify(dbAll('SELECT id, estado FROM cajas ORDER BY id'))}`)) {
      return finish()
    }

    {
      await navegar(win, '/compras')
      await sleep(1000)
      const reintento = await cancelarDesde(win, cash.folio)
      if (check('la anulación en efectivo se acepta con la caja abierta', reintento.ok, reintento.motivo)) {
        await sleep(1800)
        check('la compra en efectivo queda cancelada',
          db1(`SELECT estado FROM compras WHERE id = ?`, cash.id)?.estado === 'cancelada',
          `estado ${db1('SELECT estado FROM compras WHERE id = ?', cash.id)?.estado}`)
        check('el efectivo volvió a la caja nueva',
          saldoCajon(nuevaCaja.id) === fondo + ESPERADO,
          `cajón ${pesos(saldoCajon(nuevaCaja.id))}, esperado ${pesos(fondo + ESPERADO)}`)
        const anuladaCash = partidasDe(`compra:${cash.id}`)
        check('la anulación en efectivo devuelve la caja, con las cuentas al revés',
          anuladaCash.porCuenta['1.1.01']?.debe === ESPERADO && anuladaCash.porCuenta['1.2.01']?.haber === ESPERADO,
          `1.1.01 debe ${pesos(anuladaCash.porCuenta['1.1.01']?.debe ?? 0)}`)
        // The whole point: the two records of the same money agree again. Every till in the shop,
        // closed ones included, has to sum to the account — that is the reconciliation a shop
        // actually does, and it is the one the silent-skip bug made permanently impossible.
        const totalCajones = Number(db1(
          `SELECT COALESCE(SUM(saldo_inicial_centavos + total_ingresos_centavos - total_egresos_centavos), 0) AS s
             FROM cajas WHERE negocio_id = ? AND deleted_at IS NULL`,
          negocioId
        )?.s ?? 0)
        check('todos los cajones juntos dan exactamente el saldo de 1.1.01',
          totalCajones === saldo('1.1.01'),
          `cajones ${pesos(totalCajones)} vs 1.1.01 ${pesos(saldo('1.1.01'))}`)
        say(`         caja nueva ${pesos(saldoCajon(nuevaCaja.id))}, y 1.1.01 = ${pesos(saldo('1.1.01'))} = la suma de los cajones`)
      }
    }

    say('')
    say('=== fin del recorrido ===')

    return finish()
  })()

  function finish() {
    say('')
    const resumen = fallos === 0
      ? `=== RECORRIDO DE PROVEEDORES Y COMPRAS: OK ${total}/${total} ===`
      : `=== RECORRIDO DE PROVEEDORES Y COMPRAS: FALLÓ ${total - fallos}/${total} ===`
    say(resumen)
    say('')
    say(`[drive] finish() devolvió ${JSON.stringify({ ok: fallos === 0, total, failed: fallos })}`)
    return { ok: fallos === 0, total, failed: fallos }
  }
}
