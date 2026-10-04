/**
 * TILL CLOSE DRIVE — counting the drawer, in the real app, against the real SQLite file.
 *
 * THE GAP THIS FILES FILLS. `verify:s0` ran six Electron drives before the accounting one, and every
 * one of them OPENED a till and moved money through it — `drive:payment` opens one, `drive:compras`
 * even had to be rewritten to drive its own "open the till" modal because a closed till blocked it.
 * What none of them ever did is COUNT one, because `cajas.close` had no screen to drive: the only
 * way it could be reached was a unit test calling the repository. So the whole end of the day was
 * untested in the running application, and a mount-time crash on `/cierre-caja` — the one screen a
 * shop reaches once a day, at closing, when it is busiest — would have been GREEN on the full gate.
 *
 * ── WHAT IT PROVES, AND WHY IT IS NOT THE OTHER DRIVES ──────────────────────────────────────────
 *
 * `drive:contabilidad` reconciles the TRIAL BALANCE. This one reconciles a COUNT: the figure an
 * operator types, the figure the screen echoes back, and the three integers the file ends up
 * holding. Three readings, derived independently, that have to agree:
 *
 *   1. THE SCREEN, read off `data-testid` before and after the close.
 *   2. THE ROW, `monto_contado_centavos` / `diferencia_centavos` / `saldo_final_centavos`.
 *   3. THE JOURNAL, the `caja_cierre` movement and the two accounts it must have touched.
 *
 * A drive that compared (1) against (2) alone would prove the screen faithfully renders what it was
 * handed. Comparing all three is what makes "the drawer was counted" a fact about the FILE.
 *
 * ── WHY THE DAY IS SEEDED THROUGH THE REPOSITORIES ───────────────────────────────────────────────
 *
 * The same reason `reportes-drive.js` and `contabilidad-drive.js` do it, and it is the reason this
 * drive stays readable: `drive:payment`, `drive:deudores`, `drive:compras`, `drive:handover` and
 * `drive:reportes` already click the POS screen by screen inside `verify:s0`. Re-clicking four
 * hundred POS steps to obtain a till would prove the same thing twice. So the day's figures are
 * produced by calling the functions the IPC handlers call, and what this drive then types with real
 * key events is the part nobody else touches.
 *
 * ── THE PART MOST LIKELY TO BE WRITTEN WRONGLY ───────────────────────────────────────────────────
 *
 * Step 7: the operator ticks the acknowledgement, then changes the count. The box must UN-TICK. That
 * is the whole reason the acknowledgement is per-difference rather than a sticky "I understand", and
 * it is invisible to a screenshot, invisible to the repository tests, and invisible to any drive
 * that types the count once and closes. So it is checked here, on the real window, with the real
 * input path — and if the screen ever starts keeping a stale tick, this gate is what says so.
 *
 * It runs against a THROWAWAY data directory, so it can never touch a real shop's database, and it
 * prints every figure it reads so a human can look at the numbers rather than at a word saying OK.
 */
import { firmarComoDueño } from './first-launch-signin.js'
import { esperarEn, buscar, tipear, leer, recargar } from './drive-primitives.js'
import { createCtx } from './db/ctx.js'
import { abrir as abrirCaja, registrarMovimiento, cajaActiva } from './db/repositories/cajas.repo.js'
import { crear as crearVenta } from './db/repositories/ventas.repo.js'
import { CUENTA } from './db/repositories/cuentas.repo.js'

/** The float the day starts with. */
const FLOAT = 50_000

/** How much the drawer is SHORT by at the end of the day. The whole point of the exercise. */
const FALTANTE = 5_000

/** An ordinary petty-cash expense, so the day is not only money coming in. */
const GASTO = 3_000

export function runCierreDrive(win, db) {
  const lines = []
  let fallos = 0
  let total = 0
  const say = (s) => {
    lines.push(s)
    console.log(s)
  }
  const db1 = (sql, ...args) => db.conn.db.prepare(sql).get(...args)
  const dbAll = (sql, ...args) => db.conn.db.prepare(sql).all(...args)
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
  const pesos = (c) => (c === null || c === undefined ? '—' : `$${(c / 100).toFixed(2)}`)

  /**
   * What the SCREEN printed, back to centavos. `$1.234,56` and `$-35,00` are 123456 and -3500.
   *
   * The screen prints es-AR and the file holds an integer, so comparing the two as STRINGS fails a
   * perfectly correct screen over a decimal comma — which is how a drive ends up "proving" a bug
   * that is really a formatting difference in the drive itself. Everything money-ish goes through
   * this, and a figure that was never printed comes back `null` rather than 0: a number nobody saw
   * is not a number that matches.
   */
  const aCentavos = (texto) => {
    if (texto === null || texto === undefined) return null
    const limpio = String(texto).replace(/[^\d,-]/g, '')
    if (!limpio) return null
    const negativo = limpio.startsWith('-')
    const digitos = limpio.replace(/-/g, '')
    const [entero, frac] = digitos.split(',')
    const centavos = frac
      ? entero.replace(/\./g, '') + frac.padEnd(2, '0').slice(0, 2)
      : entero.replace(/\./g, '')
    const n = Number(centavos)
    return Number.isFinite(n) ? (negativo ? -n : n) : null
  }
  /** The money inside a `data-testid`, or null when it printed nothing. */
  const dinero = async (id) => {
    const txt = await leer(
      win,
      `(document.querySelector('[data-testid=${JSON.stringify(id)}]')||{}).textContent || null`
    )
    if (txt === null) return null
    // The sign can sit BEFORE the `$` — `-$50,00` — so the minus has to be part of the match, not
    // assumed to follow the currency sign. A parser that only looks after the `$` reads a shortage
    // as a surplus, and then the drive "proves" that a $50 shortage agrees with the file's −$50.
    const m = String(txt).match(/(-?)\$\s?([\d.,]+)/)
    if (!m) return null
    const n = aCentavos(m[2])
    if (n === null) return null
    return m[1] === '-' ? -n : n
  }
  /**
   * Write a value into a CONTROLLED React input and say whether React took it.
   *
   * `tipear` cannot do this job: it SENDS KEYSTROKES, and sending the empty string sends nothing, so
   * asking it to clear a field is asking it to leave the field alone. `tipear(win, { texto: '' })`
   * "cleared" nothing and the retraction check below then read a stale tick and blamed the screen.
   * The native value setter plus a bubbling `input` event is the React-aware way, and it is the same
   * technique `elegirOpcion` documents for `<select>`: assigning `el.value` directly can be ignored,
   * because React tracks the previous value on the DOM node.
   */
  const escribirCampo = async (selector, valor) => {
    const quedo = await leer(
      win,
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(valor)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return el.value;
      })()`
    )
    await sleep(200)
    return quedo
  }
  const textoDeLaPagina = () =>
    leer(
      win,
      `((document.querySelector('.card')||document.body||{}).textContent||'').replace(/\\s+/g,' ')`
    )

  return (async () => {
    say('')
    say('=== RECORRIDO DE CIERRE DE CAJA ===')
    say('')

    // ---- 1. an operator on the till ------------------------------------------------------------
    const sesion = await firmarComoDueño({
      win,
      base: { leer, esperarEn, buscar, tipear, sleep },
      check,
      say,
      db1
    })
    if (!sesion.ok) {
      check('hay un operador en la caja antes de cerrar el día', false, sesion.motivo || 'no se pudo entrar')
      return finish()
    }
    check('hay un operador en la caja antes de cerrar el día', true)
    const negocio = db1(`SELECT id FROM negocios ORDER BY id LIMIT 1`)
    const actor = db1(
      `SELECT id, nombre FROM users WHERE negocio_id = ? AND rol = 'admin' ORDER BY id LIMIT 1`,
      negocio.id
    )

    // ---- 2. a day worth counting ----------------------------------------------------------------
    // Seeded through the repositories on purpose (see the header): the money is real, the figures are
    // real rows, and what this drive then types with real key events is the part no other drive
    // reaches.
    const ctx = createCtx(db.conn, { negocioId: negocio.id, actorId: actor.id })
    const caja = await abrirCaja(ctx, { saldoInicial: '500.00', observaciones: 'drive: apertura del día' })
    // No `eliminado` column on this schema: soft deletion is `activo`. Guessing a column name here is
    // how a drive dies on its first query instead of on the thing it is testing.
    const producto = db1(
      `SELECT * FROM productos WHERE negocio_id = ? AND activo = 1 ORDER BY id LIMIT 1`,
      negocio.id
    )
    let esperada = FLOAT
    if (producto) {
      // `crear` returns `{ venta, duplicado }`, so the total is one level DOWN. Reading
      // `.total_centavos` off the wrapper would be `undefined`, and `undefined` in a reconciliation
      // compares false forever instead of throwing, which is the quietest way to write a drive that
      // lies. The total is also the FILE's, never a number typed here: a drive that assumed $300,00
      // would silently reconcile against the wrong expectation the day the catalogue changed.
      const { venta } = await crearVenta(ctx, {
        items: [{ productoId: producto.id, cantidad: '0.5' }],
        metodoPago: 'efectivo',
        montoRecibido: '1000.00'
      })
      esperada = FLOAT + venta.total_centavos
      say(`  · float ${pesos(FLOAT)} + venta ${pesos(venta.total_centavos)} = esperado ${pesos(esperada)}`)
    } else {
      // No catalogue, so the day is the float alone. Still a real day, and the shortage below is
      // still a shortage — the drive reports the shape it actually got instead of pretending.
      say(`  · sin catalogo: el dia es solo el float ${pesos(esperada)}`)
    }
    // `caja` here is the ROW, not its id: `registrarMovimiento` re-reads the chain from the drawer
    // rather than trusting a caller's snapshot, so it takes the till and looks. Passing `caja.id`
    // binds a string where an object is expected and dies deep inside better-sqlite3 with a
    // message about "parameter 1" that says nothing about which call was wrong.
    await registrarMovimiento(ctx, {
      caja,
      tipo: 'egreso',
      concepto: 'Bolsas',
      montoCentavos: GASTO,
      origen: 'manual'
    })
    esperada -= GASTO
    say(`  · menos un gasto de ${pesos(GASTO)} = esperado ${pesos(esperada)}`)
    const contada = esperada - FALTANTE
    say(`  · el operador cuenta ${pesos(contada)}, o sea faltan ${pesos(FALTANTE)}`)

    // RELOAD, because the window already drew itself before this till existed. On sign-in the app
    // lands on `/pos`, its `CajaGuard` asks `cajas.active` once, finds nothing, and commits to the
    // "Caja Cerrada" screen — which renders NO `<aside>` at all. So after seeding a till from the
    // repositories the window is still certain the shop has no drawer: the sidebar link does not
    // exist, and every keystroke goes nowhere. The renderer is not wrong to be confused, it is
    // answering an older question. Reloading is what a person gets when they open the app with a
    // till already in the database, and it is the same `recargar` the POS catalogue needs.
    await recargar(win)

    // ---- 3. reach the screen the way the shop does ------------------------------------------------
    // Wait for the SHELL before asserting anything about it. `firmarComoDueño` returns the moment
    // the session exists in the MAIN process; React has not re-rendered the routes yet, so the
    // sidebar is not in the DOM. Asserting a link at that instant reports "no está en la pantalla"
    // for an entry that is plainly there, and — worse — every later `tipear` loses focus to the
    // shell mounting underneath it. Both failures were this one race. The other drives wait too.
    const menuListo = await esperarEn(win, `!!document.querySelector('.sidebar-menu a')`, 15_000)
    check('la barra lateral se dibuja una vez que hay sesión', menuListo,
      menuListo ? '' : `ruta ${await leer(win, 'location.pathname')} · aside ${await leer(win, `(document.querySelector('aside')||{}).className || 'sin aside'`)} · pantalla ${JSON.stringify(String(await leer(win, `((document.querySelector('#root')||{}).textContent||'').replace(/\\s+/g,' ').slice(0,200)`)))}`)
    if (!menuListo) return finish()
    const porElMenu = await buscar(win, { selector: '[href="/cierre-caja"]' })
    check('el menú lateral tiene una entrada al cierre de caja', porElMenu.ok, porElMenu.via)
    const llegoPorElClic = await esperarEn(win, `location.pathname === '/cierre-caja'`, 6000)
    check('el clic en el menú lleva a la pantalla de cierre', llegoPorElClic,
      `no se llegó a /cierre-caja (ruta ${await leer(win, 'location.pathname')})`)
    const pintada = await esperarEn(win, `!!document.querySelector('[data-testid="cierre-conteo"]')`, 8000)
    check('la pantalla de cierre se dibuja con el campo de conteo', pintada, 'no apareció el campo')
    if (!pintada) return finish()

    // ---- 4. the drawer is open and it is the right drawer ----------------------------------------
    const esperadoEnPantalla = await dinero('cierre-esperado')
    check(
      'la pantalla muestra el mismo esperado que el archivo',
      esperadoEnPantalla === esperada,
      `pantalla ${pesos(esperadoEnPantalla)}, archivo ${pesos(esperada)}`
    )
    check(
      'antes de contar no hay diferencia que reconocer',
      await dinero('cierre-diferencia') === null,
      `la diferencia apareció sin que nadie contara: ${pesos(await dinero('cierre-diferencia'))}`
    )

    // ---- 5. counting a drawer that is short -----------------------------------------------------
    const tipeoCorto = await tipear(win, {
      selector: '[data-testid="cierre-conteo"]',
      texto: String(contada / 100)
    })
    check('el conteo se puede escribir en la caja real', tipeoCorto.ok, `vía ${tipeoCorto.via}`)
    const aparecioFaltante = await esperarEn(
      win,
      `!!document.querySelector('[data-testid="cierre-reconocer"]')`,
      6000
    )
    check('contar menos que el esperado pide reconocer la diferencia', aparecioFaltante,
      'no apareció la casilla de reconocimiento')
    const difEnPantalla = await dinero('cierre-diferencia')
    check(
      'la diferencia que muestra la pantalla es el faltante, con signo',
      difEnPantalla === -FALTANTE,
      `pantalla ${pesos(difEnPantalla)}, esperado ${pesos(-FALTANTE)}`
    )
    check(
      'con el faltante sin reconocer, el botón de cerrar está bloqueado',
      await leer(win, `(document.querySelector('[data-testid="cierre-confirmar"]')||{}).disabled === true`),
      'el botón estaba habilitado'
    )

    // ---- 6. acknowledging -----------------------------------------------------------------------
    const marcado = await buscar(win, { selector: '[data-testid="cierre-reconocer"]', tag: 'input' })
    check('la casilla de reconocimiento se puede marcar', marcado.ok, marcado.via)
    check(
      'reconocer habilita el cierre',
      await leer(win, `(document.querySelector('[data-testid="cierre-confirmar"]')||{}).disabled === false`),
      'sigue bloqueado'
    )

    // ---- 7. and changing the count takes the acknowledgement AWAY ---------------------------------
    // The part that is invisible to a screenshot and to every repository test. See the header.
    //
    // Deliberately NOT written as "the checkbox came back unchecked", with an `if` that skips the
    // rest when it does not come back. That version was tried and it is a weak gate: when the
    // screen keeps a stale tick the box simply never reappears, the guard swallowed two checks, and
    // the mutation was reported as a vague "no reapareció" instead of naming the defect. What
    // actually matters is the CONSEQUENCE — a fresh non-zero difference must not be closable on
    // somebody else's acknowledgement — so both facts are asserted unconditionally, and the message
    // says what a person would have got wrong.
    const vaciadoA = await escribirCampo('[data-testid="cierre-conteo"]', '')
    check('el campo de conteo se puede vaciar', vaciadoA === '', `quedó ${JSON.stringify(vaciadoA)}`)
    const vaciado = await esperarEn(
      win,
      `document.querySelector('[data-testid="cierre-reconocer"]') === null`,
      5000
    )
    check('borrar el conteo esconde el reconocimiento', vaciado, 'siguió pidiendo reconocer')

    // Type it back through the REAL key path, so the screen reacts to keystrokes and not to a
    // script placing a value.
    await tipear(win, { selector: '[data-testid="cierre-conteo"]', texto: String(contada / 100) })
    await esperarEn(win, `!!document.querySelector('[data-testid="cierre-diferencia"]')`, 5000)
    check(
      'CAMBIAR EL CONTEO VUELVE A EXIGIR RECONOCER LA DIFERENCIA NUEVA',
      await leer(win, `!!document.querySelector('[data-testid="cierre-reconocer"]')`),
      'la casilla no volvió: la diferencia que acaba de escribirse se cerraría sin que nadie la mire'
    )
    check(
      'y con una diferencia sin reconocer, el cierre está bloqueado',
      await leer(win, `(document.querySelector('[data-testid="cierre-confirmar"]')||{}).disabled === true`),
      'el botón quedó habilitado con el reconocimiento de OTRA diferencia'
    )
    // Tick it again for the close, this time through a click, so the close below is driven by a
    // person-equivalent path rather than by whatever state the previous step left behind.
    const reticado = await buscar(win, { selector: '[data-testid="cierre-reconocer"]', tag: 'input' })
    check('la casilla se puede volver a marcar', reticado.ok, reticado.via)
    check(
      'reconocer de nuevo deja el cierre habilitado',
      await leer(win, `(document.querySelector('[data-testid="cierre-confirmar"]')||{}).disabled === false`),
      'sigue bloqueado'
    )

    // ---- 8. closing ------------------------------------------------------------------------------
    const tipeoObs = await tipear(win, {
      selector: '[data-testid="cierre-observaciones"]',
      texto: 'falta un billete de cien'
    })
    check('la observación se puede escribir', tipeoObs.ok, `vía ${tipeoObs.via}`)
    const cerrado = await buscar(win, { selector: '[data-testid="cierre-confirmar"]' })
    check('el botón de cerrar responde', cerrado.ok, cerrado.via)
    const llegoResumen = await esperarEn(
      win,
      `!!document.querySelector('[data-testid="cierre-resultado-diferencia"]')`,
      10_000
    )
    check('la pantalla pasa al resumen de la caja cerrada', llegoResumen, 'no apareció el resumen')
    if (!llegoResumen) return finish()

    // ---- 9. the screen's three figures are the file's three integers -------------------------------
    const resEsperado = await dinero('cierre-resultado-esperado')
    const resContado = await dinero('cierre-resultado-contado')
    const resDiferencia = await dinero('cierre-resultado-diferencia')
    check('el resumen esperado coincide con el archivo', resEsperado === esperada,
      `pantalla ${pesos(resEsperado)}, archivo ${pesos(esperada)}`)
    check('el resumen contado coincide con lo que se escribió', resContado === contada,
      `pantalla ${pesos(resContado)}, archivo ${pesos(contada)}`)
    check('el resumen de la diferencia coincide', resDiferencia === -FALTANTE,
      `pantalla ${pesos(resDiferencia)}, archivo ${pesos(-FALTANTE)}`)
    const texto = await textoDeLaPagina()
    check(
      `la pantalla dice EN QUÉ CUENTA quedó el faltante (${CUENTA.FALTANTES})`,
      new RegExp(String(CUENTA.FALTANTES).replace(/\./g, '\\.')).test(texto || ''),
      'no nombró la cuenta de faltantes'
    )
    check(
      'la pantalla conserva la observación que escribió el operador',
      /falta un billete de cien/.test(texto || ''),
      'no se ve la observación'
    )

    // ---- 10. the file ----------------------------------------------------------------------------
    const fila = db1('SELECT * FROM cajas WHERE id = ? AND negocio_id = ?', caja.id, negocio.id)
    check('la caja quedó CERRADA en el archivo', fila.estado === 'cerrada', `estado ${fila.estado}`)
    check('el archivo guardó el monto contado', fila.monto_contado_centavos === contada,
      `archivo ${pesos(fila.monto_contado_centavos)}, esperado ${pesos(contada)}`)
    check('el archivo guardó la diferencia con signo', fila.diferencia_centavos === -FALTANTE,
      `archivo ${pesos(fila.diferencia_centavos)}`)
    check('el saldo final es lo que se CONTÓ, no lo que decía el sistema',
      fila.saldo_final_centavos === contada, `archivo ${pesos(fila.saldo_final_centavos)}`)
    check('la fecha de cierre quedó escrita', Boolean(fila.fecha_cierre), `fecha ${fila.fecha_cierre}`)
    check('quedó la observación del operador', fila.observaciones === 'falta un billete de cien',
      `observaciones ${JSON.stringify(fila.observaciones)}`)

    const movCierre = dbAll(
      `SELECT * FROM movimientos_caja
        WHERE caja_id = ? AND origen = 'caja_cierre' AND negocio_id = ?`,
      caja.id,
      negocio.id
    )
    check('el faltante se registró como un movimiento de caja', movCierre.length === 1,
      `movimientos ${movCierre.length}`)
    check('ese movimiento es un EGRESO por el faltante',
      movCierre[0]?.tipo === 'egreso' && movCierre[0]?.monto_centavos === FALTANTE,
      `tipo ${movCierre[0]?.tipo}, monto ${pesos(movCierre[0]?.monto_centavos)}`)
    check('y su saldo nuevo es el saldo contado', movCierre[0]?.saldo_nuevo_centavos === contada,
      `saldo nuevo ${pesos(movCierre[0]?.saldo_nuevo_centavos)}`)

    // ---- 11. the ledger --------------------------------------------------------------------------
    const saldo = (codigo) =>
      db1(
        `SELECT COALESCE(SUM(d.debe_centavos), 0) - COALESCE(SUM(d.haber_centavos), 0) AS n
           FROM detalles_asientos d JOIN cuentas_contables c ON c.id = d.cuenta_contable_id
          WHERE c.codigo = ? AND c.negocio_id = ?`,
        codigo,
        negocio.id
      ).n
    const enFaltantes = saldo(CUENTA.FALTANTES)
    check(`el faltante quedó cargado a ${CUENTA.FALTANTES}`, enFaltantes === FALTANTE,
      `saldo ${pesos(enFaltantes)}, esperado ${pesos(FALTANTE)}`)
    check(`la caja del ledger (${CUENTA.CAJA}) quedó en lo que se CONTÓ, no en lo esperado`,
      saldo(CUENTA.CAJA) === contada, `libro ${pesos(saldo(CUENTA.CAJA))}, contado ${pesos(contada)}`)
    check(`no se inventó un sobrante en ${CUENTA.SOBRANTES} cuando faltó efectivo`,
      saldo(CUENTA.SOBRANTES) === 0, `saldo ${pesos(saldo(CUENTA.SOBRANTES))}`)

    // ---- 12. tomorrow ----------------------------------------------------------------------------
    // The half nobody demos: a shop that cannot open a till tomorrow cannot trade tomorrow.
    const abierta = await buscar(win, { texto: 'abrir la caja de mañana' })
    check('el resumen ofrece abrir la caja del día siguiente', abierta.ok, abierta.via)
    const abrio = await esperarEn(win, `!!document.querySelector('[data-testid="cierre-conteo"]')`, 10_000)
    check('el clic vuelve a la pantalla de conteo, para el día siguiente', abrio, 'no volvió al conteo')
    const nueva = cajaActiva(db.conn.db, negocio.id)
    check('el archivo tiene ahora UNA caja abierta, y es otra', Boolean(nueva) && nueva.id !== caja.id,
      `caja activa ${nueva?.id}, la de ayer ${caja.id}`)
    check('la caja de ayer sigue cerrada y no se reabrió',
      db1('SELECT estado FROM cajas WHERE id = ?', caja.id).estado === 'cerrada', 'volvió a abierta')

    return finish()
  })()

  function finish() {
    say('')
    say(
      fallos === 0
        ? `=== RECORRIDO DE CIERRE: OK ${total}/${total} ===`
        : `=== RECORRIDO DE CIERRE: FALLÓ ${total - fallos}/${total} ===`
    )
    say('')
    return { ok: fallos === 0, total, failed: fallos }
  }
}