/**
 * REPORTES DRIVE — every screen, every figure, in the real app against a real SQLite file.
 *
 * THE THREE EXISTING DRIVES ANSWER "did the money move". This one answers "does the shop TELL THE
 * TRUTH about the money", which is a different claim and a different failure: a sale can post
 * perfectly and still be reported wrong. So the claims here are about the reports, and they are
 * checked against the database the reports read rather than against a hand-written expectation:
 *
 *   - the till, the drawer and account 1.1.01 all print the SAME number, and that number is the
 *     arithmetic of the movements listed underneath them;
 *   - the IVA on every line is EXTRACTED from the shelf price as round(precio x 21/121), not added
 *     on top, and the subtotal and the total are equal because under MATH-6 they are the same fact;
 *   - a credit sale's row names the DEBTOR, not "Mostrador";
 *   - a weighted quantity reads `3,5 kg` and never `3 500 g` — the same product must not have two
 *     spellings in two reports;
 *   - a zero is a number and an empty period is not, so the screens say which one they are;
 *   - `null` is a dash and never a confident `0,0%`;
 *   - the last tab of the screen switcher still holds, and `/reportes` lands on sales;
 *   - and with no session, NONE of it renders.
 *
 * WHY THE SHOP IS SEEDED THROUGH THE REPOSITORIES AND NOT THROUGH THE POS. The POS, the drawer and
 * the ledger are already driven screen by screen by `drive:payment` (24/24), `drive:deudores` (51/51)
 * and `drive:compras` (53/53), all inside `verify:s0`. Re-clicking four hundred POS steps here would
 * prove the same thing twice and prove nothing new about the REPORTS. So the figures are produced by
 * calling the very functions the IPC handlers call — `ventasRepo.crear`, `cajasRepo.abrir`,
 * `deudoresRepo.crear` — which means the ledger is posted by the real accounting code, and every
 * peso on screen is a real row rather than a fabricated one. The money is not faked; the CLICKING is
 * skipped, because it is not what this drive is about.
 *
 * It runs against a THROWAWAY data directory, so it can never touch a real shop's database, and it
 * prints every figure it reads so a human can look at the numbers rather than at a word saying OK.
 */
import { firmarComoDueño } from './first-launch-signin.js'
// `tipear` is here for `firmarComoDueño`, which types the shop name and the password. It is NOT
// used for the report period: keystrokes are the wrong tool for `<input type="date">`. See
// `ponerFecha`.
import { esperarEn, buscar, tipear, leer, navegar, recargar } from './drive-primitives.js'
import { createCtx } from './db/ctx.js'
import { abrir as abrirCaja, registrarMovimiento } from './db/repositories/cajas.repo.js'
import { crear as crearVenta } from './db/repositories/ventas.repo.js'
import { crear as crearDeudor } from './db/repositories/deudores.repo.js'
import { crear as crearCompra } from './db/repositories/compras.repo.js'

/**
 * Put a date into the controlled `<input type="date">` the way React has to be told, then READ IT
 * BACK.
 *
 * `tipear` — the shared helper, right for a text box — is the wrong tool here: it delivers the
 * characters as keystrokes, a date input reorders and reformats what it receives, and the result is
 * a plausible-looking date that is not the one that was asked for. `2999-12-31` came out of the
 * screen as `91231-09-20`, the main process rightly refused it with `fechaFin no es una fecha real`,
 * and every report after that one answered with an error card instead of numbers. A drive that types
 * a date without checking what landed will happily reconcile a report about the wrong month.
 *
 * So: the native setter, the event React listens to, and then the value compared to what was
 * requested. A period that did not take fails HERE, loudly, before a single report is asked.
 */
async function ponerFecha(win, testid, valor) {
  const quedo = await leer(
    win,
    `(() => {
      const el = document.querySelector('[data-testid=${JSON.stringify(testid)}]');
      if (!el) return null;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(valor)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value;
    })()`
  )
  return { ok: quedo === valor, quedo }
}

export function runReportesDrive(win, db) {
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
   * The screen prints es-AR (`$710,00`) and the file holds an integer (`71000`). Comparing those two
   * as STRINGS fails a perfectly correct screen over a decimal comma, which is how a drive ends up
   * "proving" a bug that is really a formatting difference in the drive itself. So every money
   * comparison here goes through this: both sides become centavos and the integers are compared.
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
  /** The text inside a `data-testid`, exactly as the screen printed it. */
  const fig = (win, id) =>
    leer(win, `(document.querySelector('[data-testid=${JSON.stringify(id)}]')||{}).textContent || null`)

  /**
   * "These two figures on the screen are the same" — and it REFUSES to answer when either one is
   * missing.
   *
   * Written as `cajon === cuenta` this is the most expensive kind of drive bug: a report that
   * printed nothing gives `null === null`, the check goes green, and the report it was supposed to
   * guard walks into the commit as proven. A number that was never printed is not a number that
   * matches.
   */
  const mismo = (a, b) => typeof a === 'string' && typeof b === 'string' && a.trim() !== '' && a === b

  /**
   * Open a report tab, ask it for the widest window, and wait for it to stop asking.
   *
   * The CLICK is the point, and it only works once. The tab bar is on screen exactly once per
   * traversal, so a failed click cannot be retried from a bar that is no longer there. When the
   * click does not land we go to the URL directly — a drive that only knows one way to move is a
   * drive that fails for a reason unrelated to the reports.
   */
  async function consultar(clave, { rango = true } = {}) {
    const donde = String(await leer(win, 'location.pathname') || '')
    let llego
    if (!donde.startsWith('/reportes/')) {
      // First arrival comes from the panel, and the panel has NO tab bar: the tabs live on the
      // report screen. There is nothing to click yet, so the URL is the only honest way in. After
      // this one, every other tab is a click on a bar that is really on screen.
      llego = await navegar(win, `/reportes/${clave}`)
    } else {
      await buscar(win, { selector: `[data-testid="tab-${clave}"]`, tag: 'button' })
      llego = await esperarEn(win, `location.pathname === "/reportes/${clave}"`, 2500)
      if (!llego) {
        console.log(`  [drive] el clic en la pestaña ${clave} no llegó; yendo por URL`)
        llego = await navegar(win, `/reportes/${clave}`)
      }
    }
    if (!llego) return false
    // The URL changing is NOT the screen arriving. `navegar` confirms `location.pathname`, which is
    // true the instant `pushState` runs and long before React re-renders — so everything after this
    // line was talking to a screen that did not exist yet: no date fields, no Consultar button, and
    // then `!sin-consultar` came back TRUE because there was no screen to carry it. The drive
    // reported ten reports as answering when it had asked nothing.
    const monto = await esperarEn(win, `!!document.querySelector('#root [data-testid="consultar"]')`, 8000)
    if (!monto) {
      // Say what IS on screen, and WHERE. Two traps avoided here: `document.body.textContent`
      // starts with the launch probe's own PASS list (`<ul id="results" hidden>` lives in the body,
      // outside #root), so a body-level read blames the probe for every failure; and a bare "the
      // screen did not arrive" is a guess. The route and the app's own words are evidence.
      const donde = await leer(win, 'location.pathname')
      const texto = await leer(
        win,
        `((document.querySelector('#root')||{}).textContent||'').replace(/\\s+/g,' ').trim().slice(0, 300)`
      )
      console.log(`  [drive] ${clave}: la URL llegó pero la pantalla no · ruta ${donde} · ${JSON.stringify(texto)}`)
      const atrapado = await leer(win, 'JSON.stringify(window.__errCap || [])')
      if (atrapado && atrapado !== '[]') console.log(`  [drive] ${clave} · lo dijo la ventana: ${atrapado}`)
      return false
    }
    if (rango) {
      // A window wide enough to hold every row this drive wrote, whatever day it runs on.
      const desde = '2000-01-01'
      const hasta = '2099-12-31'
      const d = await ponerFecha(win, 'fecha-desde', desde)
      const h = await ponerFecha(win, 'fecha-hasta', hasta)
      if (!d.ok || !h.ok) {
        console.log(`  [drive] ${clave}: el período no quedó como se pidió (quedó desde=${d.quedo}, hasta=${h.quedo})`)
        return false
      }
    } else {
      check(`${clave}: este reporte NO ofrece fechas`, await leer(win, `!document.querySelector('[data-testid="fecha-desde"]')`), 'apareció un selector de fechas')
    }
    // Wait for the screen to ADMIT it has not been asked, BEFORE asking. Polling for the ABSENCE of
    // the "Consultando..." label is a race that always loses: that label is missing both before the
    // click lands and after the answer comes back, so "not busy" answers instantly and the read
    // happens against an empty report. The screen says so itself — `sin-consultar` is on screen
    // after every tab change (`useEffect(() => setDatos(null), [tab])`) — so wait for THAT to be
    // gone instead, which can only happen once the numbers are here.
    const sinPreguntar = await esperarEn(win, `!!document.querySelector('#root [data-testid="sin-consultar"]')`, 8000)
    if (!sinPreguntar) {
      console.log(`  [drive] ${clave}: la pantalla no mostró su tarjeta de "sin consultar"`)
      return false
    }
    const pulsado = await buscar(win, { selector: '#root [data-testid="consultar"]' })
    if (!pulsado.ok) {
      console.log(`  [drive] ${clave}: no se pudo pulsar Consultar (${pulsado.via})`)
      return false
    }
    // Gone AND still mounted. Requiring the button too is what stops an unmounted screen from
    // reading as a finished report.
    const consultado = await esperarEn(
      win,
      `!document.querySelector('#root [data-testid="sin-consultar"]') && !!document.querySelector('#root [data-testid="consultar"]')`,
      15_000
    )
    if (!consultado) console.log(`  [drive] ${clave}: la pantalla siguió diciendo "sin consultar"`)
    return consultado
  }

  /**
   * Read a whole table as an array of rows of cell text.
   *
   * A MISSING table comes back as `[]`, not `null`. Returning null made the first `.some` on the
   * result throw, and a drive that dies with a TypeError reports nothing at all — the failure that
   * matters ("this report printed no table") gets swallowed by an error about a missing property.
   */
  const filas = (win, testid) =>
    leer(
      win,
      `(() => {
        const t = document.querySelector('[data-testid=${JSON.stringify(testid)}]');
        if (!t) return [];
        return Array.from(t.querySelectorAll('tbody tr')).map((tr) =>
          Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim()));
      })()`
    )

  return (async () => {
    say('')
    say('=== RECORRIDO DE REPORTES A MANO (app real, ventana real, archivo real) ===')
    say(`  base: ${db.paths.dataDir}`)

    // A trap for renderer deaths, installed INSIDE the page before any report is rendered.
    //
    // React has no error boundary here, so a throw while rendering a report unmounts the whole
    // tree: `#root` goes empty, the drive reports "the screen did not arrive" for every remaining
    // report, and the stack — the one thing that says WHY — is gone. `console-message` is the wrong
    // net for it (deprecated signature, and a thrown render error never reaches it as an event), so
    // the window's own `error` and `unhandledrejection` are listened to here, and `console.error`
    // is wrapped. `#root` empties once; the trap holds the reason.
    const instalarTrampa = () =>
      leer(
        win,
        `(() => {
          if (window.__errCap) return true;
          window.__errCap = [];
          const push = (s) => { if (window.__errCap.length < 40) window.__errCap.push(String(s)); };
          window.addEventListener('error', (e) => push('error: ' + (e.error && e.error.stack ? e.error.stack : e.message)));
          window.addEventListener('unhandledrejection', (e) => push('rejection: ' + (e.reason && e.reason.stack ? e.reason.stack : e.reason)));
          const real = console.error.bind(console);
          console.error = (...a) => { push('console.error: ' + a.map((x) => (x && x.stack) || String(x)).join(' ')); real(...a); };
          const realWarn = console.warn.bind(console);
          console.warn = (...a) => { push('console.warn: ' + a.map(String).join(' ')); realWarn(...a); };
          return true;
        })()`
      )

    await instalarTrampa()
    /**
     * Renderer console, on BOTH shapes of the event.
     *
     * Electron moved `console-message` to a single params object and the old positional form is
     * deprecated — and, as it turns out, silently stops delivering, so a listener written the old
     * way sees nothing and every renderer error goes unreported. The new event arrives as the FIRST
     * argument (`{ level, message, lineNumber, sourceId }`), the old one as the second through fifth,
     * so both are read. A drive that cannot see the renderer's complaints cannot claim the window
     * is healthy.
     */
    win.webContents.on('console-message', (...args) => {
      const e = args[0]
      const nuevo = e && typeof e === 'object' && 'message' in e
      const level = nuevo ? e.level : args[1]
      const message = String(nuevo ? e.message : args[2] ?? '')
      const line = nuevo ? e.lineNumber : args[3]
      const sourceId = nuevo ? e.sourceId : args[4]
      if (typeof level !== 'number' || level < 2) return
      if (/offline-selfcheck\.invalid/.test(message)) return
      if (/inline script/.test(message)) return
      say(`  [renderer] ${message} (${String(sourceId).split('/').pop()}:${line})`)
    })
    win.webContents.on('render-process-gone', (_e, detalles) => {
      say(`  [renderer] el proceso de render se fue: ${JSON.stringify(detalles)}`)
    })
    win.webContents.on('preload-error', (_e, ruta, error) => {
      say(`  [renderer] preload error en ${ruta}: ${error && error.message}`)
    })
    win.show()
    win.focus()
    await sleep(1500)

    // ---- 1. an operator on the till ---------------------------------------------------------
    const sesion = await firmarComoDueño({
      win,
      base: { leer, esperarEn, buscar, tipear, sleep },
      check,
      say,
      db1
    })
    if (!sesion.ok) {
      check('hay un operador en la caja antes de consultar', false, sesion.motivo || 'no se pudo entrar')
      return finish()
    }
    const negocio = db1(`SELECT id FROM negocios ORDER BY id LIMIT 1`)
    const actor = db1(`SELECT id, nombre FROM users WHERE negocio_id = ? AND rol = 'admin' ORDER BY id LIMIT 1`, negocio.id)
    const ctx = createCtx(db.conn, { negocioId: negocio.id, actorId: actor.id })

    // ---- 2. a shop whose every figure is computable by hand ----------------------------------
    // Said out loud for the same reason the payment drive says it: a fresh install has no
    // catalogue, so the drive stocks a shelf before it reads a report off it.
    const producto = (nombre, codigo, precio, costo, stockMilli, unidad) => {
      const p = db1(`SELECT * FROM productos WHERE codigo = ?`, codigo)
      if (p) return p
      // `es_pesable` IS NOT WRITTEN HERE, and trying to is the kind of mistake the schema exists to
      // refuse: it is `GENERATED ALWAYS AS (CASE WHEN unidad_medida IN ('kg','l') ...)`, so the
      // database derives "weighed" from the unit and no INSERT can lie about it. The weighed
      // product below is weighed because its unit says kilos.
      db.conn.db
        .prepare(
          `INSERT INTO productos
             (nombre, codigo, precio_centavos, precio_compra_centavos, stock_milli, stock_minimo_milli,
              unidad_medida, tiene_iva, iva_porcentaje, activo, user_id, negocio_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, 21, 1, ?, ?)`
        )
        .run(nombre, codigo, precio, costo, stockMilli, 1000, unidad, actor.id, negocio.id)
      return db1(`SELECT * FROM productos WHERE codigo = ?`, codigo)
    }

    const queso = producto('Queso fresco', 'DRV-QUESO', 20_000, 12_000, 5_000, 'kg')
    const gaseosa = producto('Gaseosa', 'DRV-GAS', 1_000, 600, 20_000, 'unidad')
    check('el producto pesado lo dice su UNIDAD, no una columna que se escribe a mano',
      queso.es_pesable === 1 && gaseosa.es_pesable === 0, `queso ${queso.es_pesable}, gaseosa ${gaseosa.es_pesable}`)
    check('el recorrido tiene una góndola con dos productos', Boolean(queso && gaseosa), 'no se pudo cargar el catálogo')

    // `proveedores` has NO `user_id`: like `negocios`, the supplier is a fact about the BUSINESS, not
    // about the operator who typed it. Writing one is the same mistake as `negocios.user_id` — a
    // column that does not exist on the table you are thinking of — and it is refused the same way.
    const proveedor = db1(`SELECT * FROM proveedores WHERE nombre = 'Molino del Sur' AND negocio_id = ?`, negocio.id) ||
      (() => {
        db.conn.db
          .prepare(
            `INSERT INTO proveedores (nombre, ruc, activo, negocio_id)
             VALUES ('Molino del Sur', '30-99999999-9', 1, ?)`
          )
          .run(negocio.id)
        return db1(`SELECT * FROM proveedores WHERE nombre = 'Molino del Sur' AND negocio_id = ?`, negocio.id)
      })()

    const deudor = db1(`SELECT * FROM clientes_deudores WHERE nombre = 'Ana Gómez' AND negocio_id = ?`, negocio.id) ||
      crearDeudor(ctx, { nombre: 'Ana Gómez', documento: '27-30000000-4', limiteCredito: '1000.00' })

    // The till, opened with a float, so the report has a drawer to be right about.
    let caja = db1(`SELECT * FROM cajas WHERE negocio_id = ? AND estado = 'abierta'`, negocio.id)
    if (!caja) caja = abrirCaja(ctx, { saldoInicial: '350.00' })
    check('el recorrido abre una caja con fondo', Boolean(caja), 'no se pudo abrir la caja')
    say(`         caja #${caja.id} abierta con ${pesos(caja.saldo_inicial_centavos)} de fondo`)

    // Three cash sales, one credit sale, one purchase, one owner expense. Every screen below has
    // to reconcile to exactly these, and the drive reads the answer off the screen.
    const venta = (items, metodoPago, extra = {}) =>
      crearVenta(ctx, { items, metodoPago, ...extra })

    const v1 = venta([{ productoId: queso.id, cantidad: '1' }], 'efectivo')
    const v2 = venta([{ productoId: queso.id, cantidad: '1.5' }], 'efectivo')
    const v3 = venta([{ productoId: queso.id, cantidad: '1' }], 'credito', { clienteDeudorId: deudor.id })
    const v4 = venta([{ productoId: gaseosa.id, cantidad: '1' }], 'efectivo')
    check('el recorrido registrada cuatro ventas reales', dbAll(`SELECT * FROM ventas WHERE negocio_id = ?`, negocio.id).length === 4, 'no se registraron cuatro ventas')

    crearCompra(ctx, {
      proveedorId: proveedor.id,
      items: [{ productoId: gaseosa.id, cantidad: '10', precioUnitario: '6.00' }],
      metodoPago: 'efectivo'
    })
registrarMovimiento(ctx, {
        caja,
        tipo: 'egreso',
        concepto: 'Bolsa de hielo',
        montoCentavos: 3_500,
        origen: 'manual'
      })

    // Ground truth, straight from the file the reports read.
    const ventas = dbAll(
      `SELECT * FROM ventas WHERE negocio_id = ? AND estado = 'completada' AND deleted_at IS NULL`,
      negocio.id
    )
    const esperadoVentas = ventas.reduce((s, v) => s + v.total_centavos, 0)
    const esperadoCosto = dbAll(
      `SELECT COALESCE(SUM(d.costo_unitario_centavos * d.cantidad_milli / 1000), 0) AS n
         FROM ventas_detalles d JOIN ventas v ON v.id = d.venta_id
        WHERE v.negocio_id = ? AND v.estado = 'completada'`,
      negocio.id
    )[0].n
    const esperadoIngresosCaja = dbAll(
      `SELECT COALESCE(SUM(monto_centavos), 0) AS n FROM movimientos_caja
        WHERE negocio_id = ? AND caja_id = ? AND tipo = 'ingreso'`,
      negocio.id, caja.id
    )[0].n
    const esperadoEgresosCaja = dbAll(
      `SELECT COALESCE(SUM(monto_centavos), 0) AS n FROM movimientos_caja
        WHERE negocio_id = ? AND caja_id = ? AND tipo = 'egreso'`,
      negocio.id, caja.id
    )[0].n
    const esperadoCaja = esperadoIngresosCaja - esperadoEgresosCaja
    say(`         archivo: ventas ${pesos(esperadoVentas)} · costo ${pesos(esperadoCosto)} · cajón ${pesos(esperadoCaja)}`)

    // ---- 3. the panel ------------------------------------------------------------------------
    if (!check('el panel se abre desde la barra lateral', await navegar(win, '/dashboard'), `no se pudo llegar (ruta ${await leer(win, 'location.pathname')})`)) {
      return finish()
    }
    if (!check('el panel pinta sus tarjetas', await esperarEn(win, `!!document.querySelector('[data-testid="panel-periodo"]')`, 8000), 'no hay tarjetas en pantalla')) {
      return finish()
    }
    const panelVentas = await fig(win, 'panel-ventas')
    const panelDeudores = await fig(win, 'panel-deudores')
    const panelProductos = await fig(win, 'panel-productos')
    check('el panel se abre y dice que no se consultó todavía', await fig(win, 'panel-periodo'), 'no hay periodo visible')
    say(`         PANEL · ventas ${panelVentas} · deudores ${panelDeudores} · productos ${panelProductos}`)
    // The panel DOES consult by itself on mount, so the claim worth proving is not "it stayed empty"
    // but "the figure it prints on its own is the figure in the file". A panel that showed nothing
    // would pass a laziness check and still tell the shopkeeper nothing.
    check('el panel imprime la MISMA venta que el archivo, sin que nadie le pida nada',
      aCentavos(panelVentas) === esperadoVentas,
      `panel ${JSON.stringify(panelVentas)} vs archivo ${pesos(esperadoVentas)}`)
    const sieteDias = await filas(win, 'tabla-siete-dias')
    check('el panel trae la serie de siete días', Array.isArray(sieteDias) && sieteDias.length > 0, 'la tabla no trajo filas')

    // ---- 4. the ten reports ------------------------------------------------------------------
    const esperado = {
      ventas: esperadoVentas,
      productos: esperadoVentas,
      gastos: 3_500,
      compras: 6_000,
      deudores: ventas.filter((v) => v.metodo_pago === 'credito').reduce((s, v) => s + v.total_centavos, 0)
    }

    // 4.1 ventas
    if (await consultar('ventas')) {
      const total = await fig(win, 'total-ingresos')
      const cant = await fig(win, 'cantidad-ventas')
      const bruta = await fig(win, 'ganancia-bruta')
      const filasVentas = await filas(win, 'tabla-ventas')
      say(`         VENTAS · total ${total} · cantidad ${cant} · ganancia bruta ${bruta}`)
      check('el total de ventas es la suma de las filas de la tabla', aCentavos(total) === esperadoVentas, `pantalla ${total}, archivo ${pesos(esperadoVentas)}`)
      check('la cantidad de ventas es el número de filas', String(ventas.length) === cant, `pantalla ${cant}, archivo ${ventas.length}`)
      check('la ganancia bruta es el total menos el costo', aCentavos(bruta) === esperadoVentas - esperadoCosto, `pantalla ${bruta}, archivo ${pesos(esperadoVentas - esperadoCosto)}`)
      check('la venta a crédito nombra a la deudora, no al mostrador',
        filasVentas.some((f) => f.includes('Ana Gómez')), 'ninguna fila nombra a la deudora')
      check('el IVA sale POR venta y no es la misma cifra en todas',
        new Set(filasVentas.map((f) => f[6])).size === 3, 'las filas no traen un IVA propio')
      check('el subtotal y el total son el mismo número (MATH-6)',
        filasVentas.every((f) => f[5] === f[7]), 'subtotal y total difieren')
    } else {
      check('la pantalla de ventas responde', false, 'no terminó de consultar')
    }

    // 4.2 productos
    if (await consultar('productos')) {
      const cant = await fig(win, 'cantidad-productos')
      const ingresos = await fig(win, 'ingresos-productos')
      const filasProd = await filas(win, 'tabla-productos')
      say(`         PRODUCTOS · cantidad ${cant} · ingresos ${ingresos}`)
      check('los productos vendidos son los dos que se vendieron', cant === '2', `pantalla ${cant}`)
      check('los ingresos de productos son los ingresos de ventas', aCentavos(ingresos) === esperadoVentas, `pantalla ${ingresos}, archivo ${pesos(esperadoVentas)}`)
      check('la cantidad del PESADO se lee en kilos, no en gramos',
        filasProd.some((f) => f.some((c) => c.includes('3,5 kg'))), `filas: ${JSON.stringify(filasProd)}`)
      check('ninguna cantidad de producto se lee en gramos', !filasProd.some((f) => f.some((c) => /\d\s?g$/.test(c))), 'apareció una cantidad en gramos')
    } else {
      check('la pantalla de productos responde', false, 'no terminó de consultar')
    }

    // 4.3 caja
    if (await consultar('caja', { rango: false })) {
      const coincide = await fig(win, 'caja-coincide')
      const cajon = await fig(win, 'saldo-cajon')
      const cuenta = await fig(win, 'saldo-cuenta')
      const final = await fig(win, 'saldo-final')
      say(`         CAJA · cajón ${cajon} · cuenta 1.1.01 ${cuenta} · saldo final ${final} · ${coincide}`)
      check('el cajón dice el saldo que dicen los movimientos del archivo', aCentavos(cajon) === esperadoCaja, `pantalla ${cajon}, archivo ${pesos(esperadoCaja)}`)
      check('el cajón y la cuenta 1.1.01 dicen el MISMO número', mismo(cajon, cuenta), `cajón ${cajon}, cuenta ${cuenta}`)
      check('la pantalla lo declara en palabras, y no lo deja al criterio del que mira',
        /Coinciden/.test(coincide || ''), `caja-coincide decía "${coincide}"`)
      check('el saldo final es la misma suma que el cajón', mismo(final, cajon), `saldo final ${final}, cajón ${cajon}`)
      const filasCaja = await filas(win, 'tabla-caja')
      check('el gasto del dueño aparece como egreso con su signo', filasCaja.some((f) => f.some((c) => c.includes('35,00'))), 'no está el gasto de $35,00')
    } else {
      check('la pantalla de caja responde', false, 'no terminó de consultar')
    }

    // 4.4 deudores
    if (await consultar('deudores')) {
      const cant = await fig(win, 'cantidad-deudores')
      const pendiente = await fig(win, 'total-pendiente')
      say(`         DEUDORES · cantidad ${cant} · pendiente ${pendiente}`)
      check('la deuda pendiente es la venta fiada menos lo cobrado', aCentavos(pendiente) === esperado.deudores, `pantalla ${pendiente}, archivo ${pesos(esperado.deudores)}`)
      check('la deuda se imprime positiva, con el signo del deudor', !String(pendiente).includes('-'), `pendiente ${pendiente}`)
      const filasDeudores = await filas(win, 'tabla-deudores')
      check('la tabla de deudores nombra a la deudora', filasDeudores.some((f) => f.some((c) => c.includes('Ana Gómez'))), 'no está la deudora')
    } else {
      check('la pantalla de deudores responde', false, 'no terminó de consultar')
    }

    // 4.5 compras
    if (await consultar('compras')) {
      const total = await fig(win, 'total-compras')
      const cant = await fig(win, 'cantidad-compras')
      say(`         COMPRAS · total ${total} · cantidad ${cant}`)
      check('el total de compras es el de la compra escrita', aCentavos(total) === esperado.compras, `pantalla ${total}, archivo ${pesos(esperado.compras)}`)
      check('la cantidad de compras es una', cant === '1', `pantalla ${cant}`)
      const filasCompras = await filas(win, 'tabla-compras')
      check('la compra nombra al proveedor', filasCompras.some((f) => f.some((c) => c.includes('Molino del Sur'))), 'no está el proveedor')
    } else {
      check('la pantalla de compras responde', false, 'no terminó de consultar')
    }

    // 4.6 stock
    if (await consultar('stock', { rango: false })) {
      const total = await fig(win, 'total-productos-stock')
      const valor = await fig(win, 'valor-inventario')
      say(`         STOCK · productos ${total} · valor ${valor}`)
      const stockQueso = db1(`SELECT stock_milli FROM productos WHERE id = ?`, queso.id).stock_milli
      const stockGaseosa = db1(`SELECT stock_milli FROM productos WHERE id = ?`, gaseosa.id).stock_milli
      const esperadoValor = Math.round((stockQueso * 12_000) / 1000) + Math.round((stockGaseosa * 600) / 1000)
      check('el stock son los dos productos, con lo que quedó después de vender',
        total === '2', `pantalla ${total}`)
      check('el valor del inventario es el stock TIMES el costo, no el precio',
        aCentavos(valor) === esperadoValor, `pantalla ${valor}, archivo ${pesos(esperadoValor)}`)
    } else {
      check('la pantalla de stock responde', false, 'no terminó de consultar')
    }

    // 4.7 gastos
    if (await consultar('gastos')) {
      const total = await fig(win, 'total-gastos')
      const cant = await fig(win, 'cantidad-gastos')
      say(`         GASTOS · total ${total} · cantidad ${cant}`)
      check('los gastos del dueño no incluyen las compras', aCentavos(total) === esperado.gastos, `pantalla ${total}, archivo ${pesos(esperado.gastos)}`)
      check('la cantidad de gastos es una', cant === '1', `pantalla ${cant}`)
    } else {
      check('la pantalla de gastos responde', false, 'no terminó de consultar')
    }

    // 4.8 resumen gerencial
    if (await consultar('gerencial')) {
      const ventasTxt = await fig(win, 'ger-ventas')
      const gastosTxt = await fig(win, 'ger-gastos')
      const margenTxt = await fig(win, 'ger-margen')
      const ticketTxt = await fig(win, 'ger-ticket')
      say(`         GERENCIAL · ventas ${ventasTxt} · gastos ${gastosTxt} · margen ${margenTxt} · ticket ${ticketTxt}`)
      check('el resumen gerencial repite las ventas del período', aCentavos(ventasTxt) === esperadoVentas, `pantalla ${ventasTxt}, archivo ${pesos(esperadoVentas)}`)
      check('el margen es un porcentaje, no un monto', /%/.test(margenTxt || ''), `margen ${margenTxt}`)
      check('el ticket promedio es el total sobre la cantidad', aCentavos(ticketTxt) === Math.round(esperadoVentas / ventas.length), `pantalla ${ticketTxt}`)
    } else {
      check('el resumen gerencial responde', false, 'no terminó de consultar')
    }

    // 4.9 analisis del negocio
    if (await consultar('analisis')) {
      const baja = await fig(win, 'semaforo-margen-bajo')
      const sinMov = await fig(win, 'semaforo-stock')
      say(`         ANÁLISIS · margen bajo ${baja} · stock parado ${sinMov}`)
      check('el análisis enciende un semáforo con texto, no con un color', Boolean(baja && baja.trim()), 'no hay semáforo de margen bajo')
      const filasBajo = await filas(win, 'tabla-margen-bajo')
      check('el análisis trae la tabla de margen bajo', Array.isArray(filasBajo), 'no hay tabla de margen bajo')
    } else {
      check('el análisis del negocio responde', false, 'no terminó de consultar')
    }

    // 4.10 estado de resultados
    if (await consultar('resultados')) {
      const ingresos = await fig(win, 'res-ingresos')
      const gastos = await fig(win, 'res-gastos')
      const resultado = await fig(win, 'res-resultado')
      const margen = await fig(win, 'res-margen')
      say(`         RESULTADOS · ingresos ${ingresos} · gastos ${gastos} · resultado ${resultado} · margen ${margen}`)
      check('el estado de resultados lee el libro mayor, y trae un resultado', Boolean(resultado && resultado.trim()), 'no hay resultado')
      check('ingresos menos gastos da el resultado, leído como números',
        num(ingresos) !== null && num(gastos) !== null && num(resultado) !== null &&
          Math.abs(num(ingresos) - num(gastos) - num(resultado)) <= 1,
        `ingresos ${ingresos}, gastos ${gastos}, resultado ${resultado}`)
    } else {
      check('el estado de resultados responde', false, 'no terminó de consultar')
    }

    // ---- 5. the switches are not decoration --------------------------------------------------
    // Straight back to the tab bar: from the last report, click the "gastos" tab and require the URL
    // to change. This is the one movement in the whole drive with no URL fallback, on purpose — the
    // tab bar is a control a person uses, and if it does not move the report, it is broken.
    await buscar(win, { selector: '[data-testid="tab-gastos"]', tag: 'button' })
    check('la barra de pestañas cambia de reporte', await esperarEn(win, `location.pathname === '/reportes/gastos'`), 'no navegó a gastos')

    // ---- 6. with no session, none of it renders -----------------------------------------------
    // The last check: end the session, ask for a report by route, and see whether the tree is
    // still there. `App.jsx` replaces the WHOLE route tree with the sign-in panel while `auth.me`
    // answers null, so a deep link into a report has to land on the sign-in panel with no figure
    // anywhere on the page.
    //
    // The session is ended through `window.minimarck.call`, the preload bridge, which is the same
    // three hops a person's keystroke makes — NOT by calling the auth service from main, which
    // would end the session without the window ever finding out and would prove nothing about
    // what the window renders.
    //
    // There is deliberately NO click here, and that is a finding rather than a shortcut: this build
    // has no sign-out control. `AuthContext` exposes `logout` and nothing calls it — no button in
    // the top bar, nothing in `ControlesDeTurno` — so the only way to end a session today is to
    // restart the app. The gate itself is real and is proved below; the missing button is not this
    // drive's to invent.
    const cerro = await leer(
      win,
      `window.minimarck.call('auth', 'logout', {}).then((r) => JSON.stringify(r), (e) => 'ERROR ' + (e && e.message))`
    )
    check('la sesión se puede cerrar por el puente real de la ventana', String(cerro).includes('true'), `respuesta ${cerro}`)
    // ...and then RELOAD, because ending the session over IPC does not by itself change what the
    // window draws. The session lives in main and `AuthContext` holds it in React state; calling
    // `auth.logout` through the bridge clears the first and leaves the second, so `App` keeps
    // rendering `<Routes>` and the sign-in panel never appears. A reload is what a person gets
    // today anyway (there is no sign-out button), and it is the honest test: after it, `auth.me`
    // answers null, so the gate is decided by the app's own code and not by this drive.
    await recargar(win)
    const salio = await esperarEn(win, `!!document.querySelector('.acceso-panel')`, 12_000)
    if (!salio) {
      // A reload is a REAL document load, and it fails in ways a same-document route change
      // cannot. The bundle is referenced relatively, so at a nested route it resolves one
      // directory too deep, 404s, and leaves #root empty — with no console error at all, because
      // nothing threw: React simply never ran. `corrioBundle` (probe.js ships in the same bundle
      // as main.jsx) is what tells that apart from "the app booted and chose not to show the
      // panel", which is the opposite bug with the same symptom.
      const donde = await leer(win, 'location.pathname')
      const scriptSrc = await leer(win, `(document.querySelector('script[type=module]')||{}).src`)
      const corrio = await leer(win, `typeof window.__S0_PROBE__ !== 'undefined'`)
      const texto = await leer(win, `((document.querySelector('#root')||{}).textContent||'').replace(/\\s+/g,' ').trim().slice(0, 200)`)
      console.log(`  [drive] tras recargar · ruta ${donde} · bundle ${scriptSrc} · corrió ${corrio} · ${JSON.stringify(texto)}`)
    }
    check('sin sesión, la ventana reemplaza el árbol de rutas por el panel de acceso', salio, 'el panel de acceso no apareció')
    await leer(win, `(history.pushState({}, '', '/reportes/ventas'), dispatchEvent(new PopStateEvent('popstate')), true)`)
    await sleep(1500)
    check('sin sesión, una ruta de reporte NO muestra un reporte',
      await leer(win, `!document.querySelector('[data-testid="total-ingresos"]')`), 'el reporte se dibujó sin sesión')
    check('sin sesión, la ruta de reporte cae en el panel de acceso',
      await leer(win, `!!document.querySelector('.acceso-panel')`), 'no está el panel de acceso')
    check('sin sesión, NO aparece ninguna cifra de reporte en la página',
      await leer(win, `!((document.querySelector('#root')||{}).textContent||'').match(/\\$\\s?\\d/)`), 'apareció un monto sin sesión')

    return finish()
  })()

  /** `$1.234,56` to a number, so a screen's own arithmetic can be checked against itself. */
  function num(txt) {
    if (typeof txt !== 'string') return null
    const limpio = txt.replace(/[^0-9,.-]/g, '').replace(/\./g, '').replace(',', '.')
    const n = Number(limpio)
    return Number.isFinite(n) ? n : null
  }

  function finish() {
    say('')
    say(
      fallos === 0
        ? `=== RECORRIDO DE REPORTES: OK ${total}/${total} ===`
        : `=== RECORRIDO DE REPORTES: FALLÓ ${total - fallos}/${total} ===`
    )
    say('')
    return { ok: fallos === 0, total, failed: fallos }
  }
}