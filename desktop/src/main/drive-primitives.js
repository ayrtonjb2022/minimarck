/**
 * DRIVE PRIMITIVES — the six ways a script touches a real window.
 *
 * WHY THIS FILE EXISTS. Every drive needs the same six things: wait for a thing to
 * appear, click something, type something, read something, navigate, reload. Three
 * drives each carried their own copy, which is how the sign-in walk ended up copied
 * too. This is the one definition.
 *
 * WHY THE AWKWARD PARTS ARE THE WAY THEY ARE — these are all defects that were found
 * by a drive failing, and the fixes are load-bearing:
 *
 *  - `tipear` types into `document.activeElement`, NOT into the node the selector
 *    found. Those can be different elements: the browser promotes focus to a wrapper,
 *    and asking "is the node I focused the focused one?" answered false while
 *    `activeElement` plainly WAS the field. Whichever element really holds focus is the
 *    one a keystroke reaches.
 *  - It sends `keyDown`/`char`/`keyUp` through `sendInputEvent`, because that is what a
 *    real keyboard produces, and only falls back to `execCommand('insertText')` if the
 *    events did not land. It returns WHICH one worked, because "the click did not happen"
 *    and "it happened and nothing changed" are different bugs and a boolean cannot tell
 *    them apart.
 *  - `buscar` clicks with `el.click()` and scrolls it into view first: an element below
 *    the fold is real and clickable in a test and invisible to a person.
 *  - `leer` returns `null` instead of throwing when the page is mid-navigation.
 *  - `esperarEn` polls instead of sleeping a fixed time, so a slow machine is not a flake.
 */

/** Wait until `expr` evaluates truthy in the page, or give up. Returns a boolean. */
export async function esperarEn(win, expr, ms = 8000) {
  const limite = Date.now() + ms
  while (Date.now() < limite) {
    let ok = false
    try {
      ok = await win.webContents.executeJavaScript(`(() => { try { return Boolean(${expr}); } catch { return false; } })()`)
    } catch {
      ok = false
    }
    if (ok) return true
    await new Promise((r) => setTimeout(r, 120))
  }
  return false
}

/**
 * Click by visible text or by selector.
 *
 * Returns `{ ok, via }` rather than a bare boolean: a caller that reads `.ok` off a
 * boolean gets `undefined`, fails, and reports a form that was in fact submitted correctly.
 */
export function buscar(win, { texto, selector, tag = 'button', dentroDelModal = false }) {
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

/**
 * Choose an option in a `<select>`.
 *
 * The native `value` SETTER plus a real `change` event, not `el.value = x`: React tracks
 * the previous value on the DOM node and a direct assignment can be ignored, which
 * produces a form that looks filled in and submits the first option.
 */
export function elegirOpcion(win, { selector, valor, dentroDelModal = false }) {
  return win.webContents
    .executeJavaScript(`(() => {
      const overlays = document.querySelectorAll('.modal-overlay');
      const raiz = ${dentroDelModal} ? (overlays[overlays.length - 1] || document) : document;
      const el = raiz.querySelector(${JSON.stringify(selector)});
      if (!el) return 'no se encontró el select';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(String(valor))});
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value === ${JSON.stringify(String(valor))} ? true : 'el select no tomó el valor';
    })()`)
    .then((r) => ({ ok: r === true, via: r === true ? 'setter+change' : r }))
}

/** Type `texto` into the field, with real key events, and say how it landed. */
export async function tipear(win, { selector, texto, dentroDelModal = false }) {
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
    `(() => { const a = document.activeElement; return a && a.tagName === 'INPUT' ? true : false; })()`
  )
  if (!enFoco) return { ok: false, via: 'nada tiene el foco' }

  const valor = `(() => { const a = document.activeElement; return a && a.tagName === 'INPUT' ? a.value : null })()`

  for (const ch of texto) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch })
    await new Promise((r) => setTimeout(r, 40))
  }
  if ((await win.webContents.executeJavaScript(valor)) === texto) {
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
  if ((await win.webContents.executeJavaScript(valor)) === texto) {
    return { ok: true, via: porExec ? 'execCommand' : 'execCommand(sinRetorno)' }
  }
  return { ok: false, via: 'el campo no quedó con el texto' }
}

/** Read an expression out of the page. `null` when the page is mid-navigation, not a throw. */
export async function leer(win, expr) {
  try {
    return await win.webContents.executeJavaScript(expr)
  } catch {
    return null
  }
}

/** Navigate the SPA, by clicking a sidebar link when there is one, else by location. */
export async function navegar(win, ruta) {
  const made = await buscar(win, {
    selector: `[href="${ruta}"]`
  })
  if (made.ok) {
    const llego = await esperarEn(win, `location.pathname === ${JSON.stringify(ruta)}`, 4000)
    if (llego) return true
  }
  await win.webContents.executeJavaScript(
    `history.pushState({}, '', ${JSON.stringify(ruta)}); window.dispatchEvent(new PopStateEvent('popstate')); true`
  )
  return esperarEn(win, `location.pathname === ${JSON.stringify(ruta)}`, 4000)
}

/** Reload, because the POS fetches its catalogue once and caches it. */
export async function recargar(win) {
  win.webContents.reload()
  await new Promise((r) => setTimeout(r, 2500))
}

/**
 * Press F2, which is the POS's "charge" key.
 *
 * `keyDown` then `keyUp` and NOTHING ELSE. The first version of the handover drive also sent a
 * `char` event, on the assumption that a key press is three events; for a function key it is two,
 * and the extra `char` inserted a literal "F2" into whatever field had focus.
 */
export function pulsarF2(win) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F2' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F2' })
  return true
}
