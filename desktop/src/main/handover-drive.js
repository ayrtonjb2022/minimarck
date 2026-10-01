/**
 * THE HANDOVER DRIVE — two people, one till, in the real app, on real keys.
 *
 * WHAT THIS RUN IS FOR. The other three drives prove money: cash in, a debt
 * collected, goods and money arriving. This one proves the thing the sign-in feature
 * actually changes, which is not arithmetic:
 *
 *   the OWNER creates an employee;
 *   the EMPLOYEE takes the till and types THEIR OWN password;
 *   a wrong password is refused and the till does not move;
 *   the EMPLOYEE rings up a sale, and that sale carries the EMPLOYEE's name;
 *   the OWNER takes the till back with THEIR password, and the next sale is theirs.
 *
 * Every one of those is done through the real window with real keystrokes. The sale is
 * made through the real POS: click the product, F2, take the money. Only the shelf is
 * stocked directly, and the drive says so out loud, because a fresh install has no
 * catalogue and pretending otherwise would be a lie in a file whose job is to be
 * believed.
 *
 * WHY THE DRAWER IS CHECKED TO THE CENTAVO. The till is money. A handover that loses
 * or invents a centavo is a broken handover, so this compares the drawer balance with
 * the account total and requires them to be EQUAL — not close, equal. `1.1.01` is read
 * straight from the table, not through the API, so a rounding bug in the API cannot
 * hide the discrepancy.
 */
import { app } from 'electron'
import {
  esperarEn,
  buscar,
  elegirOpcion,
  tipear,
  leer,
  navegar,
  recargar,
  pulsarF2
} from './drive-primitives.js'
import { firmarComoDueño } from './first-launch-signin.js'

const PASSWORD_DUENA = 'Clave-De-La-Prueba-9'
const PASSWORD_AYUDANTE = 'Clave-Del-Ayudante-7'
const ESPERAR_SCYPT = 15000
/**
 * The account the drawer is supposed to BE. `1.1.01 Caja` is the shop's own chart of accounts, not
 * a guess: `deudores.spec.js` and `compras.spec.js` already assert this code against the same
 * ledger, and the point of comparing it here is that the handover must not move the drawer without
 * moving the account that stands for it.
 */
const CUENTA_CAJA = '1.1.01'

export function runHandoverDrive(win, db) {
  const lines = []
  let fallos = 0
  let total = 0
  const say = (s) => {
    lines.push(s)
    console.log(s)
  }
  const db1 = (sql, ...args) => db.conn.db.prepare(sql).get(...args)
  const todos = (sql, ...args) => db.conn.db.prepare(sql).all(...args)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const check = (nombre, ok, detalle) => {
    total++
    if (ok) say(`  OK    ${nombre}`)
    else {
      fallos++
      say(`  FALLA ${nombre}${detalle ? ` — ${detalle}` : ''}`)
    }
    return ok
  }

  return (async () => {
    say('')
    say('=== RECORRIDO DE RELEVO DE TURNO A MANO (app real, ventana real, teclas reales) ===')
    say(`  base: ${db.paths.dataDir}`)

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
    await sleep(1500)

    // ---- 1. the owner exists ------------------------------------------------------------------
    const sesion = await firmarComoDueño({
      win,
      base: { leer, esperarEn, buscar, tipear, sleep },
      check,
      say,
      db1,
      password: PASSWORD_DUENA
    })
    if (!sesion.ok) {
      check('hay un dueño en la caja antes de delegar', false, sesion.motivo || 'no se pudo entrar')
      return finish()
    }
    const duena = db1(`SELECT id, nombre, rol FROM users WHERE rol = 'admin' ORDER BY id LIMIT 1`)
    if (duena) say(`         dueña: ${duena.nombre} (id ${duena.id})`)

    // ---- 2. the owner adds an employee, through the module a person would use ----------------
    if (!(await navegar(win, '/usuarios'))) {
      check('el módulo de usuarios se abre', false, `ruta ${await leer(win, 'location.pathname')}`)
      return finish()
    }
    check('el módulo de usuarios se abre', true)
    // The form lives in a modal, so "Nuevo empleado" comes FIRST. The first version of this step
    // waited for the form before clicking anything and reported the module as broken, when in
    // fact it was asking the right question in the wrong order.
    const abrioAlta = await buscar(win, { texto: 'Nuevo empleado' })
    const formAbierto = await esperarEn(win, `document.querySelector('[data-testid="usuario-nombre"]')`, 6000)
    check('el formulario de alta se abre con un clic', Boolean(abrioAlta.ok) && Boolean(formAbierto),
      `clic=${JSON.stringify(abrioAlta.via)}`)

    await tipear(win, { selector: '[data-testid="usuario-nombre"]', texto: 'Ayudante de Mostrador' })
    await tipear(win, { selector: '[data-testid="usuario-acceso"]', texto: 'ayudante' })
    await elegirOpcion(win, { selector: '[data-testid="usuario-rol"]', valor: 'vendedor' })
    await tipear(win, { selector: '[data-testid="usuario-password"]', texto: PASSWORD_AYUDANTE })
    await buscar(win, { selector: '[data-testid="usuario-crear"]' })
    const alta = await esperarEn(
      win,
      `(() => { const t = document.body.textContent || ''; return t.includes('Ayudante de Mostrador'); })()`,
      ESPERAR_SCYPT
    )
    check('el dueño agrega a un empleado y aparece en la lista', Boolean(alta),
      'el empleado no apareció en la tabla')

    const ayudante = db1(
      `SELECT id, nombre, rol FROM users WHERE rol = 'vendedor' AND deleted_at IS NULL ORDER BY id LIMIT 1`
    )
    check('el empleado existe en la base, como vendedor',
      Boolean(ayudante) && ayudante.rol === 'vendedor',
      `fila=${JSON.stringify(ayudante)}`)
    if (ayudante) say(`         empleado: ${ayudante.nombre} (id ${ayudante.id}, ${ayudante.rol})`)

    // The seeded admin's credential is a real scrypt row. The employee must have one too, or the
    // handover would be refused for a reason that has nothing to do with passwords.
    const credencial = db1(
      `SELECT algoritmo, provider, external_id, activo FROM user_identidades WHERE user_id = ? AND activo = 1`,
      ayudante?.id
    )
    check('el empleado tiene su propia credencial, con hash y no la del dueño',
      Boolean(credencial) && credencial.algoritmo === 'scrypt' && credencial.provider === 'local',
      `credencial=${JSON.stringify(credencial)}`)

    // ---- 3. a shelf, and an open till ---------------------------------------------------------
    if (db1(`SELECT COUNT(*) AS n FROM productos WHERE deleted_at IS NULL`).n === 0) {
      const negocio = db1(`SELECT id FROM negocios ORDER BY id LIMIT 1`)
      db.conn.db
        .prepare(
          `INSERT INTO productos
             (nombre, codigo, precio_centavos, precio_compra_centavos, stock_milli, stock_minimo_milli,
              user_id, negocio_id, activo, unidad_medida)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'unidad')`
        )
        .run('Gaseosa 500ml', 'DRINK-500', 1500, 900, 24000, 6000, duena.id, negocio.id)
      say('  (la base nueva no trae catálogo: se carga una "Gaseosa 500ml" a $15,00 para poder cobrar)')
      await recargar(win)
    }

    if (!(await navegar(win, '/pos'))) {
      check('se llega al punto de venta', false, `ruta ${await leer(win, 'location.pathname')}`)
      return finish()
    }
    // The till is opened by `CajaGuard`, which renders its own "Caja Cerrada" form. The field has
    // no id of its own — it is the only number input with that placeholder — so that is the
    // selector, and it is the same one the payment drive uses rather than a second guess.
    const CAJA_CERRADA = `!!document.querySelector('input[type="number"][placeholder="0.00"]')`
    const CAMPO_FONDO = `input[type="number"][placeholder="0.00"]`
    if (!db1(`SELECT id FROM cajas WHERE estado = 'abierta' AND deleted_at IS NULL`)) {
      const ofrece = await esperarEn(win, CAJA_CERRADA, 6000)
      check('sin caja abierta, la app pide abrir una antes de vender', Boolean(ofrece))
      if (ofrece) {
        await tipear(win, { selector: CAMPO_FONDO, texto: '50000' })
        await buscar(win, { texto: 'Abrir Caja' })
        await sleep(2000)
      }
    }
    const caja = db1(`SELECT id, saldo_inicial_centavos FROM cajas WHERE estado = 'abierta' AND deleted_at IS NULL`)
    check('la caja está abierta, con su fondo', Boolean(caja), 'no quedó ninguna caja abierta')
    if (caja) say(`         caja #${caja.id}, fondo $${(caja.saldo_inicial_centavos / 100).toFixed(2)}`)

    // ---- 4. the handover, the wrong way first --------------------------------------------------
    // The window is "open" when the LIST is on screen, not when the password field is: the field
    // only appears after somebody is picked. The first version waited for the field and so timed
    // out on a handover that had opened perfectly — a check aimed at the wrong state, which reports
    // a working feature as broken.
    const abrirRelevo = async () => {
      const estado = await leer(win, `(() => ({
        hayBoton: !!document.querySelector('[data-testid="relevo-turno"]'),
        hayModal: !!document.querySelector('.modal-overlay'),
        pos: !!document.querySelector('.pos-container'),
        raiz: Array.from(document.getElementById('root').children).map(n => n.className).slice(0, 5),
        clases: Array.from(new Set(Array.from(document.querySelectorAll('div')).map(n => n.className).filter(c => typeof c === 'string' && c))).slice(0, 20)
      }))()`)
      const clic = await buscar(win, { selector: '[data-testid="relevo-turno"]' })
      if (!clic.ok) {
        say(`         [estado] ${JSON.stringify(estado)}`)
        return false
      }
      const abrio = await esperarEn(win, `!!document.querySelector('[data-testid^="relevo-persona-"]')`, 6000)
      if (!abrio) say(`         [estado tras el clic] ${JSON.stringify(await leer(win, `(() => ({ modal: !!document.querySelector('.modal-overlay'), texto: (document.body.textContent||'').replace(/\\s+/g,' ').slice(0, 200) }))()`))}`)
      return abrio
    }

    check('la ventana de relevo se abre', Boolean(await abrirRelevo()))
    if (ayudante) {
      await buscar(win, { selector: `[data-testid="relevo-persona-${ayudante.id}"]` })
      const pid = await esperarEn(win, `document.querySelector('[data-testid="relevo-password"]')`, 4000)
      check('el empleado aparece en la lista de relevo, por su nombre de acceso', Boolean(pid))
      if (pid) {
        // The list must show the name a person TYPES, not an email that is not a credential.
        const fila = await leer(win, `(() => {
          const n = document.querySelector('[data-testid="relevo-persona-${ayudante.id}"]');
          return n ? (n.textContent || '').replace(/\\s+/g, ' ').trim() : null;
        })()`)
        check('la lista dice "ayudante", el nombre con el que entra, y no un correo',
          typeof fila === 'string' && fila.toLowerCase().includes('ayudante') && !fila.includes('@'),
          `fila=${JSON.stringify(fila)}`)
        say(`         fila: "${fila}"`)

        // A WRONG password, first. The till must not move, and the reason must be shown.
        await tipear(win, { selector: '[data-testid="relevo-password"]', texto: 'Clave-Incorrecta-1' })
        await buscar(win, { selector: '[data-testid="relevo-confirmar"]' })
        const rechazo = await esperarEn(
          win,
          `document.querySelector('.acceso-error') && document.querySelector('[data-testid="relevo-password"]')`,
          ESPERAR_SCYPT
        )
        const mensaje = await leer(win, `(() => { const e = document.querySelector('.acceso-error'); return e ? (e.textContent||'').trim() : null; })()`)
        check('una contraseña incorrecta deja la caja con el dueño',
          Boolean(rechazo) && db1(`SELECT 1 AS ok FROM cajas WHERE estado = 'abierta' AND deleted_at IS NULL`).ok === 1,
          `mensaje=${JSON.stringify(mensaje)}`)
        say(`         el rechazo dice: "${mensaje}"`)
        const sigueDueña = await leer(win, `(async () => {
          const r = await window.minimarck.call('auth', 'me');
          return r && r.user && r.user.id;
        })()`)
        check('y la sesión sigue siendo la de la dueña, en el proceso principal',
          Number(sigueDueña) === Number(duena.id), `auth.me devolvió ${JSON.stringify(sigueDueña)}`)

        // Now the RIGHT password, typed by the employee.
        await tipear(win, { selector: '[data-testid="relevo-password"]', texto: PASSWORD_AYUDANTE })
        await buscar(win, { selector: '[data-testid="relevo-confirmar"]' })
        const entro = await esperarEn(win, `!document.querySelector('[data-testid="relevo-password"]')`, ESPERAR_SCYPT)
        check('con SU contraseña, el empleado entra a la caja', Boolean(entro),
          'la ventana de relevo sigue abierta')
        const ahora = await leer(win, `(async () => {
          const r = await window.minimarck.call('auth', 'me');
          return r && r.user ? { id: r.user.id, nombre: r.user.nombre, rol: r.user.rol } : null;
        })()`)
        check('la sesión cambió al empleado, en el proceso principal',
          Number(ahora?.id) === Number(ayudante.id), `auth.me devolvió ${JSON.stringify(ahora)}`)
        if (ahora?.nombre) say(`         ahora en la caja: ${ahora.nombre} (${ahora.rol})`)
      }
    }

    // ---- 5. the employee rings up a sale ------------------------------------------------------
    if (!(await esperarEn(win, `document.querySelector('.pos-container')`, 8000))) {
      check('con la caja abierta aparece la pantalla de venta', false, 'no apareció la grilla')
      return finish()
    }
    const idProducto = db1(`SELECT id FROM productos WHERE deleted_at IS NULL ORDER BY id LIMIT 1`).id
    const precio = db1(`SELECT precio_centavos FROM productos WHERE id = ?`, idProducto).precio_centavos
    // The CARD, not a guessed test id: `.pos-product-card` is what `PuntoDeVenta` renders and its
    // `data-producto-id` is the id the click will actually use. Clicking by product name would be a
    // second assumption stacked on the first, and a check aimed at the wrong row is worse than no
    // check: it invites someone to break correct stock logic to satisfy it.
    const idClickeado = await leer(win, `(() => {
      const card = document.querySelector('.pos-product-card:not(.stock-cero)');
      if (!card) return null;
      return Number(card.dataset.productoId || card.getAttribute('data-producto-id'));
    })()`)
    const idReal = Number.isFinite(idClickeado) ? idClickeado : idProducto
    const producto = db1(`SELECT nombre, precio_centavos FROM productos WHERE id = ?`, idReal)
    check('la grilla ofrece un producto con stock', Number.isFinite(idClickeado),
      'no hay ninguna tarjeta de producto en la grilla')
    if (producto) say(`         producto: ${producto.nombre} a $${(producto.precio_centavos / 100).toFixed(2)}`)

    await buscar(win, { selector: '.pos-product-card:not(.stock-cero)' })
    const enTicket = await esperarEn(win, `document.querySelectorAll('.cart-item').length > 0`, 6000)
    check('el empleado pone un producto en el ticket', Boolean(enTicket))

    pulsarF2(win)
    // TRES FORMAS DE ESCRIBIR LO MISMO, Y CADA UNA FALLÓ POR SU CUENTA EN ESTE RECORRIDO.
    //
    // 1. `JSON.stringify(CAMPO_PAGO)` — "escapar el selector" le entrega al navegador un `\`
    //    LITERAL. El modal estaba abierto con el placeholder exacto `Mínimo $15,00` y el
    //    `querySelector` no encontraba nada. JSON escapa el backslash; un selector con un
    //    backslash literal no matchea ningún input, nunca.
    // 2. Un selector pelado — `esperarEn` envuelve lo que le des en `Boolean(${expr})`, así que
    //    un selector desnudo es un ERROR DE SINTAXIS, y su `try { return false }` lo convierte
    //    en un `false` silencioso durante seis segundos. Un chequeo que no puede gritar no puede
    //    estar bien: el modal estaba abierto y el chequeo dio FALLA igual, mintiendo en las dos
    //    direcciones.
    // 3. Ésta: la expresión COMPLETA, con su `!!document.querySelector(...)` y su `\\u00ed`, que
    //    resuelve el parser del navegador antes de que el CSS la vea. Es la del payment drive,
    //    copiada tal cual porque ya está probada contra la misma pantalla.
    //
    // Y `CAMPO_MINIMO` es para `tipear`, que ya busca DENTRO de `.modal-overlay`: un selector
    // que vuelva a incluir `.modal-overlay` le pide al overlay una descendiente que sea el
    // propio overlay. Aquí el `í` es un escape real, no una pareja de backslashes, porque este
    // valor viaja como DATO y no como código.
    const PAGO_ABIERTO = `!!document.querySelector('.modal-overlay input[placeholder^="M\\u00ednimo"]')`
    const abrioCobro = await esperarEn(win, PAGO_ABIERTO, 6000)
    check('F2 abre el cobro', Boolean(abrioCobro))
    const CAMPO_MINIMO = `input[placeholder^="M\u00ednimo"]`
    await tipear(win, { selector: CAMPO_MINIMO, texto: String(producto?.precio_centavos ?? precio) })
    await buscar(win, { texto: 'Confirmar' })
    const cobro = await esperarEn(win, `document.querySelectorAll('.cart-item').length === 0`, 10000)
    check('el cobro se confirma y el ticket se vacía', Boolean(cobro))

    const venta = db1(
      `SELECT id, user_id, total_centavos FROM ventas WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1`
    )
    check('la venta quedó escrita a nombre del EMPLEADO, no del dueño',
      Boolean(venta) && Number(venta.user_id) === Number(ayudante?.id) && Number(venta.user_id) !== Number(duena.id),
      `venta.user_id=${venta?.user_id} empleado=${ayudante?.id} dueña=${duena.id}`)
    if (venta) {
      const quienVendio = db1(`SELECT nombre FROM users WHERE id = ?`, venta.user_id)
      say(`         venta #${venta.id}: $${(venta.total_centavos / 100).toFixed(2)} — ${quienVendio?.nombre}`)
    }
    if (!venta) return finish()

    // ---- 6. the money must add up -------------------------------------------------------------
    // Two sides, compared as EQUALITY and not as "both moved by the same amount": a drawer and an
    // account that are supposed to be the same number were never actually compared, and a till
    // whose books disagreed with its drawer by exactly the float looked green forever.
    //
    // `movimientos_caja` is the drawer's own ledger. The first version of this section queried a
    // table called `caja_movimientos` with columns `delta_centavos`/`saldo_centavos` that do not
    // exist, and the drive died with `no such table` — which is the good outcome: a wrong table
    // name in a proof of money fails loudly instead of quietly proving nothing.
    const saldoCuenta = db1(
      `SELECT COALESCE(SUM(d.debe_centavos), 0) - COALESCE(SUM(d.haber_centavos), 0) AS n
         FROM detalles_asientos d
         JOIN cuentas_contables c ON c.id = d.cuenta_contable_id
        WHERE c.codigo = ?`,
      CUENTA_CAJA
    )
    const ultimoMovimiento = db1(
      `SELECT id, tipo, concepto, monto_centavos, saldo_anterior_centavos, saldo_nuevo_centavos, origen, user_id
         FROM movimientos_caja WHERE caja_id = ? ORDER BY id DESC LIMIT 1`,
      caja.id
    )
    const saldoCajon = ultimoMovimiento?.saldo_nuevo_centavos ?? caja.saldo_inicial_centavos

    check('el cajón y la cuenta 1.1.01 dicen EXACTAMENTE el mismo número',
      Number(saldoCajon) === Number(saldoCuenta?.n),
      `cajón=${saldoCajon} 1.1.01=${saldoCuenta?.n}`)
    say(`         fondo $${(caja.saldo_inicial_centavos / 100).toFixed(2)} + venta $${(venta.total_centavos / 100).toFixed(2)} = $${(saldoCajon / 100).toFixed(2)}, y 1.1.01 = $${(Number(saldoCuenta?.n ?? 0) / 100).toFixed(2)}`)

    check('el movimiento del cajón también quedó a nombre del EMPLEADO',
      Number(ultimoMovimiento?.user_id) === Number(ayudante?.id),
      `movimiento.user_id=${ultimoMovimiento?.user_id} empleado=${ayudante?.id}`)
    check('el cajón tiene un asiento escrito por esa venta, con su saldo de antes y de después',
      Boolean(ultimoMovimiento?.id) && ultimoMovimiento.origen === 'venta'
        && Number(ultimoMovimiento.saldo_nuevo_centavos) - Number(ultimoMovimiento.saldo_anterior_centavos) === Number(venta.total_centavos),
      `último movimiento=${JSON.stringify(ultimoMovimiento)}`)
    if (ultimoMovimiento) {
      say(`         movimiento #${ultimoMovimiento.id}: ${ultimoMovimiento.tipo} ${ultimoMovimiento.concepto} ${ultimoMovimiento.monto_centavos} centavos (${ultimoMovimiento.saldo_anterior_centavos} → ${ultimoMovimiento.saldo_nuevo_centavos}, origen ${ultimoMovimiento.origen})`)
    }

    // ---- 7. taking the till back --------------------------------------------------------------
    check('la ventana de relevo se abre otra vez', Boolean(await abrirRelevo()))
    if (duena) {
      await buscar(win, { selector: `[data-testid="relevo-persona-${duena.id}"]` })
      await esperarEn(win, `document.querySelector('[data-testid="relevo-password"]')`, 4000)
      await tipear(win, { selector: '[data-testid="relevo-password"]', texto: PASSWORD_DUENA })
      await buscar(win, { selector: '[data-testid="relevo-confirmar"]' })
      const volvio = await esperarEn(win, `!document.querySelector('[data-testid="relevo-password"]')`, ESPERAR_SCYPT)
      check('con la contraseña de la dueña, el dueño recupera la caja', Boolean(volvio),
        'la ventana de relevo sigue abierta')
      const final = await leer(win, `(async () => {
        const r = await window.minimarck.call('auth', 'me');
        return r && r.user ? { id: r.user.id, nombre: r.user.nombre } : null;
      })()`)
      check('la sesión vuelve a ser la de la dueña',
        Number(final?.id) === Number(duena.id), `auth.me devolvió ${JSON.stringify(final)}`)
      if (final?.nombre) say(`         vuelve a la caja: ${final.nombre}`)
    }

    // ---- 8. handing over to the NEXT PROCESS ---------------------------------------------------
    // The restart is not asserted here, it is PERFORMED: this phase ends, the process exits, and
    // `scripts/drive-handover.mjs` launches the app AGAIN on the same data directory with
    // `MINIMARCK_HANDOVER_RESTART=1`, where `runHandoverRestartPhase` below checks what survived.
    //
    // A comment saying "the session cannot survive a restart" proves nothing about a restart. The
    // unit test proves the session object forgets; only a second OS process proves the APP does.
    say('  -- el proceso sale ahora; la segunda fase vuelve a lanzar la app sobre la misma base --')
    return finish()
  })()

  function finish() {
    say('')
    say(fallos === 0
      ? `=== RECORRIDO DE RELEVO DE TURNO (fase 1): OK ${total}/${total} ===`
      : `=== RECORRIDO DE RELEVO DE TURNO (fase 1): FALLÓ ${total - fallos}/${total} ===`)
    say('')
    return { ok: fallos === 0, total, failed: fallos }
  }
}

/**
 * PHASE 2: the same database, a brand new process.
 *
 * THE CONTRAST IS THE WHOLE POINT. The money must have survived the restart and the session must
 * NOT have, and both halves are checked against the same rows: the till is still open with the same
 * balance, the sale is still stamped with the employee, and the account `1.1.01` still equals the
 * drawer to the centavo. If the session had survived, the sign-in panel would be absent and a
 * repository would happily stamp the next sale with whoever happened to be there yesterday.
 *
 * `ACTOR_REQUERIDO` is asked for on purpose rather than reading a session flag: it is the refusal
 * a real operation gives, through the real IPC bridge, with nobody signed in.
 */
export function runHandoverRestartPhase(win, db) {
  const lines = []
  let fallos = 0
  let total = 0
  const say = (s) => {
    lines.push(s)
    console.log(s)
  }
  const db1 = (sql, ...args) => db.conn.db.prepare(sql).get(...args)
  const check = (nombre, ok, detalle) => {
    total++
    if (ok) say(`  OK    ${nombre}`)
    else {
      fallos++
      say(`  FALLA ${nombre}${detalle ? ` — ${detalle}` : ''}`)
    }
    return Boolean(ok)
  }

  return (async () => {
    say('')
    say('=== SEGUNDA FASE: LA MISMA BASE, UN PROCESO NUEVO ===')

    // The businesses in the file, by name. Printed because a shop file with two of them is not a
    // mystery to solve later — `resolveLocalIdentity` refuses to pick one, and then EVERY
    // operation answers TENANT_REQUIRED, which looks like a broken app and is a broken FILE.
    const negocios = db.conn.db
      .prepare(`SELECT id, nombre, activo FROM negocios WHERE deleted_at IS NULL ORDER BY id`)
      .all()
    say(`         negocios en el archivo: ${negocios.map((n) => `#${n.id} "${n.nombre}"${n.activo ? '' : ' (inactivo)'}`).join(', ') || 'ninguno'}`)

    const panel = await esperarEn(win, `!!document.querySelector('.acceso-panel')`, 15000)
    const posVisible = await leer(win, `!!document.querySelector('.pos-container')`)
    check('al reiniciar, la app vuelve a pedir una contraseña', Boolean(panel) && !posVisible,
      `panel=${Boolean(panel)} pos=${Boolean(posVisible)}`)

    const me = await leer(win, `(async () => await window.minimarck.call('auth', 'me'))()`)
    check('`auth.me` contesta null: nadie está en la caja', me === null || me === undefined,
      `auth.me devolvió ${JSON.stringify(me)}`)

    // UNA ESCRITURA REAL, SIN ACTOR. Asked for by name, not by reading a session flag: a flag says
    // what the process believes, this says what the process DOES.
    //
    // It is `ventas.create` and NOT `ventas.list`, because a READ legitimately needs no actor —
    // the first version of this check used the list and "passed" by being refused for a completely
    // unrelated reason (`TENANT_REQUIRED`, from a half-wired tenant marker), then, once that was
    // fixed, it FAILED because the read had succeeded. A check pointed at the wrong operation
    // measures the wrong thing and still looks like a result.
    //
    // The payload is empty on purpose. `ventas.repo.js` checks the tenant, then the actor, and only
    // then validates the body — so `ACTOR_REQUERIDO` here proves the gate fires BEFORE any write,
    // and the sale count below proves nothing was written.
    const ventasAntes = db1(`SELECT COUNT(*) AS n FROM ventas WHERE deleted_at IS NULL`).n
    const sinActor = await leer(win, `(async () => {
      try {
        await window.minimarck.call('ventas', 'create', {})
        return { ok: true }
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code ? String(e.code) : null }
      }
    })()`)
    const ventasDespues = db1(`SELECT COUNT(*) AS n FROM ventas WHERE deleted_at IS NULL`).n
    // MATCHED ON THE TEXT BECAUSE THE CODE DOES NOT CROSS THE BRIDGE. The main process raises
    // `IpcError('ACTOR_REQUERIDO', 401, 'La venta necesita un usuario en sesión')`, and what arrives
    // in the renderer is the MESSAGE: `code` is null over the real channel. So the renderer cannot
    // branch on a stable code and has to match Spanish prose — fragile, and worth knowing before
    // someone builds an error-code switch on the other side of this boundary.
    check('una escritura real se niega sin actor, en vez de aceptarla',
      sinActor?.ok === false && /ACTOR_REQUERIDO|usuario en sesi/i.test(`${sinActor?.error} ${sinActor?.code}`),
      `ventas.create respondió: ${JSON.stringify(sinActor)}`)
    check('y no escribió nada: la venta se negó ANTES de tocar la base',
      Number(ventasAntes) === Number(ventasDespues),
      `ventas antes=${ventasAntes} después=${ventasDespues}`)
    if (sinActor?.error) say(`         sin sesión: ${sinActor.error}`)

    // The money: same till, same drawer, same account, same sale, same employee.
    const caja = db1(`SELECT * FROM cajas WHERE estado = 'abierta' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`)
    check('la caja sigue abierta después del reinicio', Boolean(caja?.id),
      'no hay ninguna caja abierta')
    const ultimo = db1(
      `SELECT saldo_nuevo_centavos, user_id FROM movimientos_caja WHERE caja_id = ? ORDER BY id DESC LIMIT 1`,
      caja?.id
    )
    const cuenta = db1(
      `SELECT COALESCE(SUM(d.debe_centavos), 0) - COALESCE(SUM(d.haber_centavos), 0) AS n
         FROM detalles_asientos d
         JOIN cuentas_contables c ON c.id = d.cuenta_contable_id
        WHERE c.codigo = ?`,
      CUENTA_CAJA
    )
    check('el dinero NO se perdió: el cajón y 1.1.01 siguen diciendo el mismo número',
      Boolean(ultimo) && Number(ultimo.saldo_nuevo_centavos) === Number(cuenta?.n),
      `cajón=${ultimo?.saldo_nuevo_centavos} 1.1.01=${cuenta?.n}`)
    if (ultimo) say(`         la caja sigue en $${(Number(ultimo.saldo_nuevo_centavos) / 100).toFixed(2)}, y el movimiento sigue a nombre de user_id=${ultimo.user_id}`)

    const venta = db1(`SELECT id, user_id, total_centavos FROM ventas WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1`)
    // The employee is whoever is NOT the owner, so the check is a real comparison between the two
    // people and not "some id greater than zero".
    const duena = db1(
      `SELECT u.id, u.nombre, i.external_id AS nombre_acceso
         FROM users u
         JOIN user_identidades i ON i.user_id = u.id AND i.activo = 1 AND i.deleted_at IS NULL
        WHERE u.rol = 'admin' AND u.deleted_at IS NULL
        ORDER BY u.id LIMIT 1`
    )
    const empleado = db1(
      `SELECT u.id, u.nombre FROM users u
         JOIN user_identidades i ON i.user_id = u.id AND i.activo = 1 AND i.deleted_at IS NULL
        WHERE u.rol = 'vendedor' AND u.deleted_at IS NULL
        ORDER BY u.id LIMIT 1`
    )
    check('la venta del empleado sigue escrita a SU nombre, no al de quien reinició',
      Boolean(venta) && Boolean(empleado) && Number(venta.user_id) === Number(empleado.id)
        && Number(venta.user_id) !== Number(duena?.id),
      `venta.user_id=${venta?.user_id} empleado=${empleado?.id} dueña=${duena?.id}`)
    if (empleado) say(`         sigue a nombre de ${empleado.nombre} (id ${empleado.id}), y la dueña es la id ${duena?.id}`)

    // And the credential outlived the session: the owner can sign in again and finds the same till.
    if (duena?.nombre_acceso) {
      await tipear(win, { selector: '#acceso-nombre', texto: duena.nombre_acceso })
      await tipear(win, { selector: '#acceso-password', texto: PASSWORD_DUENA })
      // BY CLASS, NOT BY THE WORD "Entrar". `Acceso` has a tab strip whose first tab is also
      // called "Entrar", and `buscar({ texto })` takes the FIRST match — so it clicked the tab,
      // the form never submitted, and the phase reported a credential that had stopped working.
      // A check that fails for a reason unrelated to what it claims to check is worse than no
      // check: it sends you to fix the password instead of the selector.
      await buscar(win, { selector: '.acceso-boton' })
      const entro = await esperarEn(win, `!document.querySelector('.acceso-panel')`, ESPERAR_SCYPT)
      check('la credencial de la dueña sigue sirviendo después del reinicio', Boolean(entro),
        'el panel de acceso sigue abierto')
      const sesion = await leer(win, `(async () => {
        const r = await window.minimarck.call('auth', 'me');
        return r && r.user ? { id: r.user.id, nombre: r.user.nombre } : null;
      })()`)
      check('y entra ASÍ MISMA, no como otra persona', Number(sesion?.id) === Number(duena.id),
        `auth.me devolvió ${JSON.stringify(sesion)}`)
      if (sesion?.nombre) say(`         vuelve a entrar: ${sesion.nombre}`)

      // The other half of the contrast, in the same window and the same route: without a session
      // the app was the sign-in panel and there was no till on screen; with the session it is the
      // till. Without this second half, "the operation was refused" could just as well have meant
      // "this op is broken".
      //
      // It is deliberately NOT `ventas.list` succeeding. That op refuses with `TENANT_REQUIRED`
      // through `requireTenant()` even WITH a session, because the business id is not part of what
      // this feature delivers. Pinning a session check to it would have been asserting on the
      // order of two unrelated validations, and would have sent the next person to fix the tenant
      // resolver instead of the session.
      const ahoraSi = await esperarEn(win, `!!document.querySelector('.pos-container')`, 15000)
      check('la misma ventana, la misma ruta: ahora sí muestra la caja, porque hay sesión',
        Boolean(ahoraSi), 'sigue sin aparecer la pantalla de la caja')
    } else {
      check('hay una dueña con nombre de acceso para poder volver a entrar', false,
        'no se encontró ningún admin con nombre_acceso')
    }

    say('')
    say(fallos === 0
      ? `=== SEGUNDA FASE: OK ${total}/${total} ===`
      : `=== SEGUNDA FASE: FALLÓ ${total - fallos}/${total} ===`)
    say('')
    return { ok: fallos === 0, total, failed: fallos }
  })()
}
