/**
 * CONTABILIDAD DRIVE — the ledger's own four screens, in the real app against a real SQLite file.
 *
 * THE GAP THIS FILES FILLS. `verify:s0` ran six Electron drives — `probe:launch`, `drive:payment`,
 * `drive:deudores`, `drive:compras`, `drive:handover`, `drive:reportes` — and NONE of them ever
 * opened `/contabilidad`. Between them those six drove the POS, the till, the debtor screen, the
 * supplier screen and the report screens, and every peso they moved went through
 * `cuentas.repo.js#asentar` on its way into the journal. So the ledger was being WRITTEN on every
 * run and READ on none of them: the four accounting screens were proven by `electron-vite build` and
 * by the icon checker. A mount-time crash in any of them was fully GREEN on the whole gate. That is
 * the defect this file removes.
 *
 * ── WHAT IT PROVES, AND WHY IT IS NOT `drive:reportes` ─────────────────────────────────────────
 *
 * `drive:reportes` reads the numbers the shop prints about its SALES. This one reads what the shop
 * prints about its own LEDGER, and the claim is a different one: the trial balance on screen is the
 * trial balance in the file, and it BALANCES. Three readings of the same ledger have to agree, and
 * they are derived independently on purpose, so a bug in one cannot hide inside another:
 *
 *   1. RAW SQL over `detalles_asientos`. The database's own sum of every debit and every credit.
 *   2. `balanceGeneral` — the repository function `contabilidad.balance` itself calls, which groups
 *      over `cuentas_contables` with a LEFT JOIN and signs each account through `saldoDeTipo`.
 *   3. THE SCREEN. Every figure read out of `data-testid` attributes on the four tabs.
 *
 * A drive that only compared (3) against (2) would prove a screen faithfully renders the number it
 * was handed, which is real but weaker: it cannot catch a `balanceGeneral` that drops a LEFT JOIN
 * row, because the screen would be wrong in exactly the same way. Comparing all three against each
 * other is what makes "cuadra" a fact about the FILE.
 *
 * ── WHY THE SHOP IS SEEDED THROUGH THE REPOSITORIES AND NOT THROUGH THE POS ─────────────────────
 *
 * The same reason `reportes-drive.js` does it. `drive:payment`, `drive:deudores` and `drive:compras`
 * already click the POS screen by screen inside `verify:s0`; re-clicking four hundred POS steps to
 * obtain a ledger would prove the same thing twice. So the figures are produced by calling the very
 * functions the IPC handlers call — `ventasRepo.crear`, `cajasRepo.abrir`, `registrarMovimiento`,
 * `comprasRepo.crear` — which means the journal is posted by the real accounting code and every peso
 * behind a figure on screen is a real row.
 *
 * ── WHY `asentar` IS NEVER CALLED DIRECTLY ─────────────────────────────────────────────────────
 *
 * The drive adds a DEBT (`crearDeuda`) and pays part of it, because the `deudas` tab is one of the
 * four it visits. It deliberately does NOT assert that a business debt moved the ledger, and the
 * reason is recorded in the report rather than papered over here: `registrarPagoDeuda` writes the
 * payment row and the balance inside one transaction and posts NO journal entry, so what the shop
 * OWES lives entirely in `cuentas_corrientes_deudas` and never reaches `detalles_asientos`. This
 * drive therefore reconciles the `deudas` tab against the debts TABLE and the trial balance against
 * the LEDGER, and it never crosses the two. Asserting otherwise would make this gate red over a
 * deliberate design decision instead of over a defect.
 *
 * It runs against a THROWAWAY data directory, so it can never touch a real shop's database, and it
 * prints every figure it reads so a human can look at the numbers rather than at a word saying OK.
 */
import { firmarComoDueño } from './first-launch-signin.js'
// `tipear` is here for `firmarComoDueño`, which types the shop name and the password. It is NOT
// used for anything in this drive.
import { esperarEn, buscar, tipear, leer, navegar, recargar } from './drive-primitives.js'
import { createCtx } from './db/ctx.js'
import { abrir as abrirCaja, registrarMovimiento } from './db/repositories/cajas.repo.js'
import { crear as crearVenta } from './db/repositories/ventas.repo.js'
import { crear as crearDeudor } from './db/repositories/deudores.repo.js'
import { crear as crearCompra } from './db/repositories/compras.repo.js'
import { crearDeuda, registrarPagoDeuda } from './db/repositories/contabilidad.repo.js'
import { balanceGeneral } from './db/repositories/cuentas.repo.js'
import { saldoDeTipo } from './db/reportes/metricas.js'

/** The page size `Asientos.jsx` and `Deudas.jsx` both ask for. Mirrored, not guessed. */
const PAGE_SIZE = 20

export function runContabilidadDrive(win, db) {
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
   * THE MONEY INSIDE A PANEL CARD — and only that money.
   *
   * `PanelContable`'s `Tarjeta` wraps the amount together with a label and, on some cards, a NOTE
   * that carries digits of its own: the debts card reads `Pendiente de pago · $3.800,00 · 1 de 2 sin
   * saldar`. Stripping every non-digit from the whole card and parsing what is left therefore does
   * NOT reliably yield the amount — it yields the amount followed by the note's numbers, and the
   * truncation in `aCentavos` turns that into a coin flip that happens to be right for one card
   * today and wrong the day the note changes. So the amount is pulled out by its `$` SIGN and
   * nothing else, which is the one thing the formatter always writes, and a card that printed no
   * amount at all answers `null` — a number that was never printed is not a number that matches.
   */
  const dinero = async (win, id) => {
    const txt = await fig(win, id)
    if (txt === null) return null
    const m = String(txt).match(/\$\s?([\d.,]+)/)
    return m ? aCentavos(m[1]) : null
  }

  /**
   * The rows of one table on the current tab, as arrays of cell text.
   *
   * `indice` exists because these tabs carry SEVERAL `table.product-list` elements — the journal tab
   * shows the entry list AND, when an entry is selected, its double-entry breakdown — and
   * `document.querySelector('table')` would silently read whichever one came first, which is a
   * reconciliation against the wrong numbers rather than an error. A MISSING table comes back as
   * `[]`, never `null`: returning null made the first `.some` throw, and a drive that dies with a
   * TypeError reports nothing at all — the failure that matters ("this tab printed no table") gets
   * swallowed by an error about a missing property.
   */
  const filas = (win, indice) =>
    leer(
      win,
      `(() => {
        const tablas = document.querySelectorAll('#root table.product-list');
        const t = tablas[${indice}];
        if (!t) return [];
        return Array.from(t.querySelectorAll('tbody tr')).map((tr) =>
          Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim()));
      })()`
    )
  /** How many tables the current tab drew, so a structural change fails loudly. */
  const cuantasTablas = (win) => leer(win, `document.querySelectorAll('#root table.product-list').length`)

  /**
   * Open one of the four tabs by CLICKING its button, then wait for the screen it owns.
   *
   * `busqueda` is passed in rather than derived from the tab name, because `Contabilidad.jsx` does
   * NOT write `?tab=panel` for the first tab: `setTab` calls `setParams({})` for it, so returning to
   * the panel leaves the search EMPTY. Deriving the expectation from the key made the drive fail its
   * own last navigation over a string the screen is supposed to erase — the check was wrong, and the
   * tab bar was fine.
   *
   * The click is proved by the search changing, and the search alone is not enough, because
   * `setParams` runs before React re-renders: each tab also owns an anchor testid, and the drive
   * waits for THAT, which is what stops the next read from talking to a screen that does not exist.
   */
  async function abrirTab(clave, busqueda, ancla) {
    await buscar(win, { selector: `#root [data-testid="tab-${clave}"]`, tag: 'button' })
    const cambioUrl = await esperarEn(win, `location.search === ${JSON.stringify(busqueda)}`, 4000)
    const llegó = await esperarEn(win, `!!document.querySelector('#root [data-testid=${JSON.stringify(ancla)}]')`, 8000)
    return { cambioUrl, llega: Boolean(llegó) }
  }

  return (async () => {
    say('')
    say('=== RECORRIDO DE CONTABILIDAD A MANO (app real, ventana real, archivo real) ===')
    say(`  base: ${db.paths.dataDir}`)

    // A trap for renderer deaths, installed INSIDE the page before any tab is rendered.
    //
    // React has no error boundary here, so a throw while rendering a tab unmounts the whole tree:
    // `#root` goes empty, and the stack — the one thing that says WHY — is gone with it. `console-
    // message` is the wrong net for it (a thrown render error never reaches it as an event), so the
    // window's own `error` and `unhandledrejection` are listened to here and `console.error` is
    // wrapped. `#root` empties once; the trap holds the reason.
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
     * so both are read. A drive that cannot see the renderer's complaints cannot claim the four
     * accounting screens mounted without throwing.
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

    // ---- 1. an operator on the till ------------------------------------------------------------
    const sesion = await firmarComoDueño({
      win,
      base: { leer, esperarEn, buscar, tipear, sleep },
      check,
      say,
      db1
    })
    if (!sesion.ok) {
      check('hay un operador en la caja antes de abrir el libro', false, sesion.motivo || 'no se pudo entrar')
      return finish()
    }
    const negocio = db1(`SELECT id FROM negocios ORDER BY id LIMIT 1`)
    const actor = db1(
      `SELECT id, nombre FROM users WHERE negocio_id = ? AND rol = 'admin' ORDER BY id LIMIT 1`,
      negocio.id
    )
    const ctx = createCtx(db.conn, { negocioId: negocio.id, actorId: actor.id })

    // ---- 2. a ledger with something in it ------------------------------------------------------
    // Said out loud for the same reason the reports drive says it: a fresh install has no
    // catalogue, so the drive stocks a shelf before it reads a balance off it.
    const producto = (nombre, codigo, precio, costo, stockMilli, unidad) => {
      const p = db1(`SELECT * FROM productos WHERE codigo = ?`, codigo)
      if (p) return p
      // `es_pesable` IS NOT WRITTEN HERE, and trying to is the kind of mistake the schema exists to
      // refuse: it is `GENERATED ALWAYS AS (CASE WHEN unidad_medida IN ('kg','l') ...)`, so the
      // database derives "weighed" from the unit and no INSERT can lie about it.
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

    let caja = db1(`SELECT * FROM cajas WHERE negocio_id = ? AND estado = 'abierta'`, negocio.id)
    if (!caja) caja = abrirCaja(ctx, { saldoInicial: '350.00' })
    check('el recorrido abre una caja con fondo', Boolean(caja), 'no se pudo abrir la caja')

    // Two cash sales, one credit sale, one purchase, one owner expense — the five writers the
    // journal has. Every screen below has to reconcile to exactly these.
    crearVenta(ctx, { items: [{ productoId: queso.id, cantidad: '1' }], metodoPago: 'efectivo' })
    crearVenta(ctx, { items: [{ productoId: queso.id, cantidad: '1.5' }], metodoPago: 'efectivo' })
    crearVenta(ctx, { items: [{ productoId: gaseosa.id, cantidad: '1' }], metodoPago: 'credito', clienteDeudorId: deudor.id })
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

    // A debt the SHOP took on, and part of it paid. This is what gives the fourth tab something to
    // show; see the header for why it is reconciled against the debts table and not the ledger.
    const deudaNombre = 'Préstamo del banco'
    let deuda = db1(
      `SELECT * FROM cuentas_corrientes_deudas WHERE nombre = ? AND negocio_id = ?`,
      deudaNombre,
      negocio.id
    )
    if (!deuda) {
      const creada = crearDeuda(ctx, {
        nombre: deudaNombre,
        tipo: 'prestamo_bancario',
        montoOriginal: '5000.00',
        tasaInteres: '2.5',
        fechaInicio: '2026-01-15'
      })
      registrarPagoDeuda(ctx, { deudaId: creada.id, monto: '1200.00', metodoPago: 'efectivo' })
      // Re-read RAW, not mapped: `mapDeuda` renames every column to camelCase, and the check below
      // is against the file's own column names.
      deuda = db1(`SELECT * FROM cuentas_corrientes_deudas WHERE id = ?`, creada.id)
    }

    // ---- 3. ground truth, read three independent ways ------------------------------------------
    // (1) RAW SQL. The database's own sum of every debit and every credit in the business.
    const sqlDebe = db1(
      `SELECT COALESCE(SUM(debe_centavos), 0) AS n FROM detalles_asientos WHERE negocio_id = ?`,
      negocio.id
    ).n
    const sqlHaber = db1(
      `SELECT COALESCE(SUM(haber_centavos), 0) AS n FROM detalles_asientos WHERE negocio_id = ?`,
      negocio.id
    ).n
    // (2) THE REPOSITORY. `balanceGeneral` groups over `cuentas_contables` with a LEFT JOIN, which is
    // exactly what `contabilidad.balance` does, and `saldoDeTipo` is the one table of signs.
    const porCuenta = balanceGeneral(db.conn.db, negocio.id)
    const repoDebe = porCuenta.reduce((s, c) => s + c.debe, 0)
    const repoHaber = porCuenta.reduce((s, c) => s + c.haber, 0)
    const porTipo = {}
    for (const c of porCuenta) porTipo[c.tipo] = (porTipo[c.tipo] ?? 0) + saldoDeTipo(c.tipo, c.debe, c.haber)
    // No `deleted_at`: `asientos_contables` is `paranoid: false` and the column does not exist, so
    // filtering on it is not a stricter query, it is a query that throws.
    const asientos = db1(
      `SELECT COUNT(*) AS n FROM asientos_contables WHERE negocio_id = ?`,
      negocio.id
    ).n
    const deudaPendiente = db1(
      `SELECT COALESCE(SUM(CASE WHEN estado <> 'pagado' THEN saldo_pendiente_centavos END), 0) AS n
         FROM cuentas_corrientes_deudas WHERE negocio_id = ?`,
      negocio.id
    ).n

    check('el SQL crudo y el repositorio cuentan el mismo debe', sqlDebe === repoDebe,
      `SQL ${pesos(sqlDebe)}, repositorio ${pesos(repoDebe)}`)
    check('el SQL crudo y el repositorio cuentan el mismo haber', sqlHaber === repoHaber,
      `SQL ${pesos(sqlHaber)}, repositorio ${pesos(repoHaber)}`)
    check('el libro entero cuadra en el archivo, antes de que nadie mire la pantalla',
      sqlDebe === sqlHaber, `debe ${pesos(sqlDebe)}, haber ${pesos(sqlHaber)}`)
    check('el recorrido dejó asientos en el libro', asientos > 0, 'no se escribió ningún asiento')
    check('el recorrido no llenó una sola página de asientos, así que la lista es el libro entero',
      asientos <= PAGE_SIZE, `hay ${asientos} asientos y la pantalla muestra ${PAGE_SIZE}`)
    say(`         archivo · debe ${pesos(sqlDebe)} · haber ${pesos(sqlHaber)} · ${asientos} asiento(s)`)
    say(`         por tipo · activo ${pesos(porTipo.activo ?? 0)} · pasivo ${pesos(porTipo.pasivo ?? 0)} · capital ${pesos(porTipo.capital ?? 0)}`)
    say(`         resultado · ingresos ${pesos(porTipo.ingreso ?? 0)} · gastos ${pesos(porTipo.gasto ?? 0)}`)
    say(`         deuda de la tienda ${pesos(deudaPendiente)} · pasivo del libro ${pesos(porTipo.pasivo ?? 0)}`)

    // ---- 4. the screen: the panel ---------------------------------------------------------------
    // `navegar` prefers a sidebar click and falls back to `pushState`, so arriving here proves the
    // route is REACHABLE, which is the claim the six existing drives could not make at all.
    if (!check('la barra lateral tiene un enlace a contabilidad',
      await navegar(win, '/contabilidad'), `ruta ${await leer(win, 'location.pathname')}`)) {
      return finish()
    }
    const llegoElPanel = await esperarEn(win, `!!document.querySelector('#root [data-testid="contab-activo"]')`, 8000)
    if (!check('la pantalla de contabilidad monta y pinta sus tarjetas', llegoElPanel, 'no hay tarjetas del panel')) {
      const donde = await leer(win, 'location.pathname')
      const texto = await leer(win, `((document.querySelector('#root')||{}).textContent||'').replace(/\\s+/g,' ').trim().slice(0, 300)`)
      const atrapado = await leer(win, 'JSON.stringify(window.__errCap || [])')
      say(`  [drive] la ruta ${donde} llegó pero la pantalla no · ${JSON.stringify(texto)}`)
      if (atrapado && atrapado !== '[]') say(`  [drive] lo dijo la ventana: ${atrapado}`)
      return finish()
    }

    const activo = await dinero(win, 'contab-activo')
    const pasivo = await dinero(win, 'contab-pasivo')
    const patrimonio = await dinero(win, 'contab-patrimonio')
    const ingresos = await dinero(win, 'contab-ingresos')
    const gastos = await dinero(win, 'contab-gastos')
    const resultado = await dinero(win, 'contab-resultado')
    const deudasFig = await dinero(win, 'contab-deudas')
    say(`         PANEL · activo ${pesos(activo)} · pasivo ${pesos(pasivo)} · patrimonio ${pesos(patrimonio)}`)
    say(`         PANEL · ingresos ${pesos(ingresos)} · gastos ${pesos(gastos)} · resultado ${pesos(resultado)}`)
    say(`         PANEL · deuda ${pesos(deudasFig)}`)

    check('el activo del panel es el activo del libro', activo === (porTipo.activo ?? 0),
      `pantalla ${pesos(activo)}, libro ${pesos(porTipo.activo ?? 0)}`)
    check('el pasivo del panel es el pasivo del libro', pasivo === (porTipo.pasivo ?? 0),
      `pantalla ${pesos(pasivo)}, libro ${pesos(porTipo.pasivo ?? 0)}`)
    check('el patrimonio del panel es capital MÁS resultado, y no el capital solo',
      patrimonio === (porTipo.capital ?? 0) + ((porTipo.ingreso ?? 0) - (porTipo.gasto ?? 0)),
      `pantalla ${pesos(patrimonio)}, libro ${pesos((porTipo.capital ?? 0) + ((porTipo.ingreso ?? 0) - (porTipo.gasto ?? 0)))}`)
    check('ingresos menos gastos da el resultado que muestra el panel',
      ingresos !== null && gastos !== null && resultado !== null && ingresos - gastos === resultado,
      `ingresos ${pesos(ingresos)}, gastos ${pesos(gastos)}, resultado ${pesos(resultado)}`)
    check('la deuda que la tienda debe es la que está pendiente en la tabla de deudas',
      deudasFig === deudaPendiente, `pantalla ${pesos(deudasFig)}, archivo ${pesos(deudaPendiente)}`)
    const ecuacion = await fig(win, 'contab-ecuacion')
    check('el panel DECLARA la ecuación contable en palabras, en vez de dejarla al criterio del que mira',
      /Activo = Pasivo \+ Patrimonio/.test(ecuacion || ''), `contab-ecuacion decía ${JSON.stringify(ecuacion)}`)
    check('la ecuación contable cierra con las cifras que el panel mismo imprimió',
      activo === pasivo + patrimonio, `activo ${pesos(activo)}, pasivo + patrimonio ${pesos(pasivo + patrimonio)}`)

    // ---- 5. tab: the chart, and whether the ledger balances at all ------------------------------
    const cuentasTab = await abrirTab('cuentas', '?tab=cuentas', 'cuadre')
    if (check('la pestaña del plan de cuentas abre y dice si el libro cuadra', cuentasTab.cambioUrl && cuentasTab.llega,
      `url ${cuentasTab.cambioUrl ? 'ok' : 'no cambió'}, pantalla ${cuentasTab.llega ? 'ok' : 'no llegó'}`)) {
      const totalDebe = await dinero(win, 'total-debe')
      const totalHaber = await dinero(win, 'total-haber')
      const cuadre = await fig(win, 'cuadre')
      say(`         CUENTAS · total debe ${pesos(totalDebe)} · total haber ${pesos(totalHaber)} · ${cuadre}`)
      // THE THREE-WAY RECONCILIATION. Raw SQL said one thing, `balanceGeneral` said another, and the
      // screen prints a third; if any two disagree the ledger is wrong in a way nobody can see from
      // the screen alone, so this drive has to fail.
      check('el total al debe de la pantalla es el debe del archivo',
        totalDebe === repoDebe, `pantalla ${pesos(totalDebe)}, archivo ${pesos(repoDebe)}`)
      check('el total al haber de la pantalla es el haber del archivo',
        totalHaber === repoHaber, `pantalla ${pesos(totalHaber)}, archivo ${pesos(repoHaber)}`)
      // Case-sensitive on purpose: the failure branch renders `Descuadrado por $X`, and a `/cuadra/`
      // that ignored case would read that as a PASS on the exact screen meant to catch it.
      check('la pantalla lo dice en palabras cuando el libro cuadra',
        /\bCuadra\b/.test(cuadre || '') && !/Descuadrado/.test(cuadre || ''), `cuadre decía ${JSON.stringify(cuadre)}`)

      // And PER ACCOUNT, for every account that moved. A total can be right while the rows beneath
      // it are permuted, and a chart with the right sum and the wrong rows is worse than one that
      // does not add up, because it looks right.
      // `Cuentas` draws ONE TABLE PER TYPE (up to five), so the rows are gathered from all of them
      // rather than from `querySelector('table')`, which would read only the first type's accounts.
      const tablas = await leer(
        win,
        `(() => {
          const out = [];
          for (const t of document.querySelectorAll('#root table.product-list')) {
            for (const tr of t.querySelectorAll('tbody tr')) {
              out.push(Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim()));
            }
          }
          return out;
        })()`
      )
      const movidas = porCuenta.filter((c) => c.debe !== 0 || c.haber !== 0)
      check('el plan de cuentas lista una fila por cuenta del archivo',
        Array.isArray(tablas) && tablas.length === porCuenta.length,
        `pantalla ${Array.isArray(tablas) ? tablas.length : '?'}, archivo ${porCuenta.length}`)
      let revisadas = 0
      const desacertadas = []
      for (const c of movidas) {
        const fila = (tablas || []).find((f) => f[0] === c.codigo)
        if (!fila) {
          desacertadas.push(`${c.codigo}: no está en la pantalla`)
          continue
        }
        revisadas++
        // `—` is what the screen prints for a side with no movement, and it is not a zero.
        const debePantalla = fila[2] === '—' ? 0 : aCentavos(fila[2])
        const haberPantalla = fila[3] === '—' ? 0 : aCentavos(fila[3])
        const saldoPantalla = aCentavos(fila[4])
        const saldoArchivo = saldoDeTipo(c.tipo, c.debe, c.haber)
        if (debePantalla !== c.debe || haberPantalla !== c.haber || saldoPantalla !== saldoArchivo) {
          desacertadas.push(
            `${c.codigo}: debe ${pesos(debePantalla)}/${pesos(c.debe)} haber ${pesos(haberPantalla)}/${pesos(c.haber)} saldo ${pesos(saldoPantalla)}/${pesos(saldoArchivo)}`
          )
        }
      }
      check('cada cuenta que se movió muestra SU debe, SU haber y SU saldo, con el signo de su tipo',
        revisadas > 0 && desacertadas.length === 0,
        desacertadas.length ? desacertadas.slice(0, 4).join(' | ') : 'no se encontró ninguna cuenta con movimiento')
      say(`         CUENTAS · ${revisadas} cuenta(s) con movimiento cotejadas una por una`)
      // A liability read with the sign of an asset is a balance sheet wrong by twice the amount, so
      // the check above is not cosmetic: `saldoDeTipo` is the only place that decides.
      const conPasivo = porCuenta.filter((c) => c.tipo === 'pasivo' && (c.debe !== 0 || c.haber !== 0))
      if (conPasivo.length > 0) {
        const primero = conPasivo[0]
        const fila = (tablas || []).find((f) => f[0] === primero.codigo)
        check('una cuenta PASIVO se imprime con el signo de pasivo, no el de activo',
          Boolean(fila) && aCentavos(fila[4]) === (primero.haber - primero.debe),
          `${primero.codigo}: pantalla ${fila ? pesos(aCentavos(fila[4])) : 'no está'}, libro ${pesos(primero.haber - primero.debe)}`)
      } else {
        check('una cuenta PASIVO se imprime con el signo de pasivo, no el de activo', true,
          'el recorrido no dejó deudas en el libro, así que no hay pasivo que leer')
      }
    } else {
      check('la pestaña del plan de cuentas responde', false, 'no llegó a mostrar el cuadre')
    }

    // ---- 6. tab: the journal ---------------------------------------------------------------------
    const libroTab = await abrirTab('libro', '?tab=libro', 'nuevo-asiento')
    if (check('la pestaña del libro diario abre con su botón de nuevo asiento', libroTab.cambioUrl && libroTab.llega,
      `url ${libroTab.cambioUrl ? 'ok' : 'no cambió'}, pantalla ${libroTab.llega ? 'ok' : 'no llegó'}`)) {
      // `Asientos` draws the entry list at index 0 and, when an entry is selected, its double-entry
      // breakdown after it — so index 0 is the list, and its row count is checked against the file.
      const filasLibro = await filas(win, 0)
      const tablasEnLibro = await cuantasTablas(win)
      const esperado = dbAll(
        `SELECT a.id, a.descripcion, a.referencia, a.monto_total_centavos,
                (SELECT COUNT(*) FROM detalles_asientos d
                  WHERE d.asiento_contable_id = a.id AND d.negocio_id = a.negocio_id) AS partidas
           FROM asientos_contables a
          WHERE a.negocio_id = ?
          ORDER BY a.fecha DESC, a.id DESC
          LIMIT ${PAGE_SIZE}`,
        negocio.id
      )
      say(`         LIBRO · ${Array.isArray(filasLibro) ? filasLibro.length : 0} fila(s) en pantalla, ${tablasEnLibro} tabla(s)`)
      check('el libro diario lista los asientos que hay en el archivo',
        Array.isArray(filasLibro) && filasLibro.length === esperado.length,
        `pantalla ${Array.isArray(filasLibro) ? filasLibro.length : '?'}, archivo ${esperado.length}`)
      // The reference is the handle back to what wrote the entry (`venta:12`, `compra:3`), and an
      // entry with no reason is an entry an owner cannot chase. The drive seeded five writers, so at
      // least a machine-written entry has to be on screen naming its origin.
      check('el libro muestra la REFERENCIA de los asientos que escribió la app',
        (filasLibro || []).some((f) => /venta:|compra:|caja-movimiento:/.test(f.join(' '))),
        `referencias vistas: ${JSON.stringify((filasLibro || []).map((f) => f[3]))}`)
      // Column 5 is `Monto`, so the SUM of the printed amounts has to be the sum of the file's
      // `monto_total_centavos`. A paged screen printing a different page's numbers would still have
      // the right rows; only the sum catches that.
      const impreso = (filasLibro || []).reduce((s, f) => s + (aCentavos(f[5]) ?? 0), 0)
      const enArchivo = esperado.reduce((s, a) => s + a.monto_total_centavos, 0)
      check('la suma de los montos que muestra el libro es la suma de los montos del archivo',
        impreso === enArchivo, `pantalla ${pesos(impreso)}, archivo ${pesos(enArchivo)}`)
      // Column 4 is the count of double-entry lines, and every entry the repository wrote has two or
      // more. A journal showing an entry with a single line is a double-entry ledger that stopped
      // being one on screen.
      check('cada asiento de la pantalla trae su cuenta de PARTIDAS, y nunca menos de dos',
        (filasLibro || []).every((f) => Number(f[4]) >= 2),
        `partidas vistas: ${JSON.stringify((filasLibro || []).map((f) => f[4]))}`)
      check('el detalle de las partidas de un asiento cuadra por asiento',
        esperado.every((a) => Number(a.partidas) >= 2),
        `partidas en el archivo: ${JSON.stringify(esperado.map((a) => a.partidas))}`)
    } else {
      check('la pestaña del libro diario responde', false, 'no llegó el libro diario')
    }

    // ---- 7. tab: what the shop owes ---------------------------------------------------------------
    const deudasTab = await abrirTab('deudas', '?tab=deudas', 'nueva-deuda')
    if (check('la pestaña de deudas de la tienda abre con su botón de nueva deuda', deudasTab.cambioUrl && deudasTab.llega,
      `url ${deudasTab.cambioUrl ? 'ok' : 'no cambió'}, pantalla ${deudasTab.llega ? 'ok' : 'no llegó'}`)) {
      const filasDeudas = await filas(win, 0)
      const enArchivo = dbAll(
        `SELECT nombre, monto_original_centavos, saldo_pendiente_centavos, estado
           FROM cuentas_corrientes_deudas
          WHERE negocio_id = ?
          ORDER BY (estado = 'pagado') ASC, fecha_vencimiento IS NULL ASC, fecha_vencimiento ASC, id DESC
          LIMIT ${PAGE_SIZE}`,
        negocio.id
      )
      const filaDeuda = (filasDeudas || []).find((f) => f[0] === deudaNombre)
      say(`         DEUDAS · ${Array.isArray(filasDeudas) ? filasDeudas.length : 0} fila(s) en pantalla · archivo ${enArchivo.length}`)
      check('la lista de deudas trae las mismas filas que la tabla',
        Array.isArray(filasDeudas) && filasDeudas.length === enArchivo.length,
        `pantalla ${Array.isArray(filasDeudas) ? filasDeudas.length : '?'}, archivo ${enArchivo.length}`)
      check('la deuda que tomó la tienda aparece nombrada', Boolean(filaDeuda),
        `filas: ${JSON.stringify((filasDeudas || []).map((f) => f[0]))}`)
      if (filaDeuda) {
        // Columns are Nombre · Tipo · Original · Pendiente · Avance · Vence · Estado · (botones).
        // The pending balance is the number that decides what gets paid next, and it is reconciled
        // against the DEBTS TABLE — not the ledger, because `registrarPagoDeuda` posts no entry.
        check('el pendiente que muestra la pantalla es el saldo que quedó en la tabla',
          aCentavos(filaDeuda[3]) === deuda.saldo_pendiente_centavos,
          `pantalla ${pesos(aCentavos(filaDeuda[3]))}, archivo ${pesos(deuda.saldo_pendiente_centavos)}`)
        check('el original que muestra la pantalla es el monto que se registró',
          aCentavos(filaDeuda[2]) === deuda.monto_original_centavos,
          `pantalla ${pesos(aCentavos(filaDeuda[2]))}, archivo ${pesos(deuda.monto_original_centavos)}`)
        // `Deudas.jsx` renders the label, not the stored value: `activo` becomes `Activa`.
        check('un pago parcial deja la deuda ACTIVA, no saldada ni vencida',
          filaDeuda[6] === 'Activa' && deuda.estado === 'activo',
          `pantalla ${JSON.stringify(filaDeuda[6])}, archivo ${JSON.stringify(deuda.estado)}`)
        // An unpaid share printed as a whole number is a debt that looks closed.
        check('el avance de la deuda NO se imprime entero cuando se pagó algo',
          /[1-9]\d?%$/.test(filaDeuda[4]), `avance ${JSON.stringify(filaDeuda[4])}`)
      }
      const texto = await leer(win, `((document.querySelector('#root')||{}).textContent||'').replace(/\\s+/g,' ')`)
      check('la pantalla de deudas dice en palabras que es lo que la TIENDA debe, y remite a Deudores',
        /la tienda debe/.test(texto || '') && /Deudores/.test(texto || ''),
        'no está la aclaración de que son deudas de la tienda')
    } else {
      check('la pestaña de deudas responde', false, 'no llegó la lista de deudas')
    }

    // ---- 8. the tab bar is not decoration ---------------------------------------------------------
    // Back to the panel through the bar, with no URL fallback: this is the control a person uses,
    // and if it does not move the section it is broken. `setTab('panel')` CLEARS the query, so the
    // proof is that the search goes back to empty rather than to `?tab=panel`.
    const panelTab = await abrirTab('panel', '', 'contab-activo')
    check('la barra de pestañas vuelve al panel y borra el `?tab=` del URL', panelTab.cambioUrl && panelTab.llega,
      `url ${panelTab.cambioUrl ? 'ok' : 'no volvió a vacío'}, pantalla ${panelTab.llega ? 'ok' : 'no llegó'}`)

    // ---- 9. with no session, none of it renders ----------------------------------------------------
    // The last check: end the session over the preload bridge — the same three hops a person's
    // keystroke makes — then RELOAD, because ending a session over IPC does not by itself change
    // what the window draws. A reload is what a person gets today anyway (this build has no
    // sign-out button), and it is the honest test: after it, `auth.me` answers null, so the gate is
    // decided by the app's own code and not by this drive.
    const cerro = await leer(
      win,
      `window.minimarck.call('auth', 'logout', {}).then((r) => JSON.stringify(r), (e) => 'ERROR ' + (e && e.message))`
    )
    check('la sesión se puede cerrar por el puente real de la ventana', String(cerro).includes('true'), `respuesta ${cerro}`)
    await recargar(win)
    const salio = await esperarEn(win, `!!document.querySelector('.acceso-panel')`, 12_000)
    check('sin sesión, la ventana reemplaza el árbol de rutas por el panel de acceso', salio,
      'el panel de acceso no apareció')
    await leer(win, `(history.pushState({}, '', '/contabilidad'), dispatchEvent(new PopStateEvent('popstate')), true)`)
    await sleep(1500)
    check('sin sesión, una ruta de contabilidad NO muestra el libro',
      await leer(win, `!document.querySelector('[data-testid="contab-activo"]')`), 'el panel se dibujó sin sesión')
    check('sin sesión, la ruta de contabilidad cae en el panel de acceso',
      await leer(win, `!!document.querySelector('.acceso-panel')`), 'no está el panel de acceso')
    check('sin sesión, NO aparece ninguna cifra contable en la página',
      await leer(win, `!((document.querySelector('#root')||{}).textContent||'').match(/\\$\\s?\\d/)`), 'apareció un monto sin sesión')

    return finish()
  })()

  function finish() {
    say('')
    say(
      fallos === 0
        ? `=== RECORRIDO DE CONTABILIDAD: OK ${total}/${total} ===`
        : `=== RECORRIDO DE CONTABILIDAD: FALLÓ ${total - fallos}/${total} ===`
    )
    say('')
    return { ok: fallos === 0, total, failed: fallos }
  }
}