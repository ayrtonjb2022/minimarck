/**
 * THE ELEVEN SCREENS, and the four helpers every one of them is built from.
 *
 * WHAT THIS FILE IS NOT. It is not a set of components, and it is not ten copies of a table. It
 * is one page, `pages/Reportes.jsx`, that switches on the report the route asked for — because the
 * web's own `Reportes.jsx` did exactly that with eleven tabs, and the shape an operator already
 * knows is the shape they should find on a till.
 *
 * WHY THE NUMBERS ARE FORMATTED HERE AND NOWHERE ELSE. `formatCentavos` and `formatCantidad` are
 * the SAME functions the POS, the receipts and the debtor list use, imported from
 * `shared/money.js` and `shared/qty.js`. A report that formatted its own money with
 * `$${n.toFixed(2)}` would be the fourth implementation of Argentine money in this renderer, and
 * the one nobody would test, because a report is a screen nobody clicks during development.
 *
 * AND WHY EVERY NULL IS CHECKED. `formatCents` THROWS on `null` — that is deliberate, so a missing
 * amount cannot be printed as `$0,00` — which means a report that passed a nullable field straight
 * through would take the whole screen down to a blank page. `dinero()` and `cantidad()` below are
 * the two adapters that make those fields safe, and they are the reason this file is a module
 * rather than JSX pasted ten times.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { toast } from "react-toastify";
import { reportesAPI } from "../api/reportes";
import { mensajeDeError } from "../api/ipc";
import { formatCentavos, formatCantidad, formatPorcentaje, formatDateShort, formatNumber } from "../utils/formatters";
import Loader from "../components/common/Loader";

/**
 * MONEY, with a null that reads as a dash instead of a zero.
 *
 * A margin of zero and a margin that could not be computed are different facts, and `$0,00` claims
 * the first. So `null` is a dash, always: no percentage, no average, no margin before there was a
 * previous period. The web printed `(value ?? 0).toFixed(1)` in several of these cells, which made
 * a shop's first day report a confident 0,0% margin for products it had never sold.
 */
const dinero = (centavos) => (centavos == null ? "—" : formatCentavos(centavos));

/** Same rule for a rate, and for the same reason. */
const porcentaje = (pct) => (pct == null ? "—" : formatPorcentaje(pct));

/** Percentage POINTS for a margin, `%` for everything else. See `metricas.js` for why. */
const variacion = (valor, tipo) => {
  if (valor == null) return "—";
  const signo = valor >= 0 ? "+" : "−";
  return `${signo}${Math.abs(valor).toFixed(1)}${tipo === "pp" ? " pp" : "%"}`;
};

/**
 * A QUANTITY, in the product's own unit, printed in that unit's OWN decimals.
 *
 * `baseDecimals` is the flag, and it is the difference between a report the owner can read and a
 * report that shows the database's storage. 1500 thousandths of a kilo is `1,5 kg` here, not
 * `1 500 g` and certainly not the stored `1500`: this is a screen where an owner compares the same
 * product across four reports and against the POS's own quantity field, and three different
 * spellings of one number is three chances to misread it. See `formatMilli` for why the base form
 * also round-trips through `toMilli` and the grouped form does not.
 */
const cantidad = (milli, unidad) =>
  milli == null ? "—" : formatCantidad(milli, { unidad: unidad || "unidad", baseDecimals: true });

/** A local `YYYY-MM-DD` day, which is what every date input in this app speaks. */
const hoyLocal = () => {
  const d = new Date();
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mes}-${dia}`;
};

const inicioDeMes = () => `${hoyLocal().slice(0, 7)}-01`;

/**
 * THE TEN TABS, in the order an operator reads a shop's day: what did I take, what did I sell, what
 * am I owed, what did I buy, what is on the shelf, what went out, what came in.
 *
 * `rango: false` marks the two reports that take no dates. `caja` is a session, not a period, and
 * `stock` is a moment, not a window; offering a date picker for either would offer a control that
 * does nothing, which is worse than not offering it.
 */
export const TABS = [
  { key: "ventas", op: "sales", nombre: "Ventas", icono: "fa-chart-line", grupo: "Operativos" },
  { key: "productos", op: "topProducts", nombre: "Productos", icono: "fa-crown", grupo: "Operativos" },
  { key: "caja", op: "cash", nombre: "Caja", icono: "fa-coins", grupo: "Financieros", rango: false },
  { key: "deudores", op: "debtors", nombre: "Deudores", icono: "fa-hand-holding-dollar", grupo: "Financieros" },
  { key: "compras", op: "purchases", nombre: "Compras", icono: "fa-truck-ramp-box", grupo: "Operativos" },
  { key: "stock", op: "stock", nombre: "Stock", icono: "fa-boxes-stacked", grupo: "Operativos", rango: false },
  { key: "gastos", op: "expenses", nombre: "Gastos", icono: "fa-file-invoice-dollar", grupo: "Financieros" },
  { key: "gerencial", op: "managerial", nombre: "Resumen gerencial", icono: "fa-chart-pie", grupo: "Diagnóstico" },
  { key: "analisis", op: "businessAnalysis", nombre: "Análisis del negocio", icono: "fa-scale-balanced", grupo: "Diagnóstico" },
  { key: "resultados", op: "incomeStatement", nombre: "Estado de resultados", icono: "fa-money-bill-trend-up", grupo: "Financieros" }
];

const TAB_POR_CLAVE = Object.freeze(Object.fromEntries(TABS.map((t) => [t.key, t])));

const GRUPOS = ["Diagnóstico", "Operativos", "Financieros"];

/** The method of payment, spelled the way a customer would say it. */
const METODO = { efectivo: "Efectivo", tarjeta: "Tarjeta", credito: "Crédito", transferencia: "Transferencia" };
const metodo = (m) => METODO[m] ?? m ?? "—";

/** One table. `columnas` are `{ titulo, celda, alinear }` and the cell is a function of the row. */
const Tabla = ({ columnas, filas, vacio, testid }) => {
  if (filas.length === 0) {
    return (
      <div className="card" data-testid={`${testid}-vacio`}>
        <p style={{ color: "var(--kanagawa-fg-muted)", fontSize: 14, margin: 0 }}>{vacio}</p>
      </div>
    );
  }
  return (
    <div className="table-container" data-testid={testid}>
      <table>
        <thead>
          <tr>
            {columnas.map((c) => (
              <th key={c.titulo} style={{ textAlign: c.alinear === "der" ? "right" : "left" }}>{c.titulo}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filas.map((fila, i) => (
            <tr key={fila.id ?? `${i}`} className="table-row">
              {columnas.map((c) => (
                <td key={c.titulo} className="td" style={{ textAlign: c.alinear === "der" ? "right" : "left" }}>
                  {c.celda(fila, i)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/**
 * A figure, in one of the app's existing card shapes.
 *
 * `nota` CARRIES ITS OWN TESTID (`<testid>-nota`) because it is a claim the screen makes in its
 * own words — "Sin caja abierta", "3 ventas" — and a test can only hold a claim to account if it
 * can name the node that makes it. Asserting it through the `value` node instead would be an
 * assertion about a DIFFERENT string that happens to sit in the same card, which is precisely the
 * kind of check that stays green while the claim goes missing.
 */
const Tarjeta = ({ etiqueta, valor, color, nota, testid }) => (
  <div className="stat-card">
    <p className="label">{etiqueta}</p>
    <p className="value" style={color ? { color } : undefined} data-testid={testid}>{valor}</p>
    {nota ? (
      <p style={{ fontSize: 12, color: "var(--kanagawa-fg-muted)", margin: "4px 0 0" }} data-testid={`${testid}-nota`}>
        {nota}
      </p>
    ) : null}
  </div>
);

/** The traffic light. The dot is the finding; the number is beside it. */
const Semaforo = ({ color }) => {
  const color_ = { verde: "var(--kanagawa-green)", amarillo: "var(--kanagawa-orange)", rojo: "var(--kanagawa-red)" };
  return (
    <span
      aria-label={color === "verde" ? "en regla" : color === "amarillo" ? "para revisar" : "en problema"}
      style={{ color: color_[color] ?? "var(--kanagawa-fg-muted)" }}
    >
      <i className={`fa-solid fa-circle${color === "verde" ? "" : color === "amarillo" ? "-half-stroke" : ""}`} aria-hidden="true"></i>
    </span>
  );
};

/**
 * THE TEN BODIES. Each one takes the report's own answer and renders it. None of them computes a
 * total: every figure on these screens comes out of the repository, so a number the owner reads
 * here is the number the database would give them, and the screen cannot disagree with a second
 * implementation of the same subtraction.
 */
const CUERPOS = {
  // ---- 1. Ventas -------------------------------------------------------------------------
  ventas: (d) => (
    <>
      <div className="stats-grid">
        <Tarjeta etiqueta="Ventas del período" valor={dinero(d.resumen.totalIngresosCentavos)} testid="total-ingresos" />
        <Tarjeta etiqueta="Cantidad de ventas" valor={formatNumber(d.resumen.cantidadVentas)} testid="cantidad-ventas" />
        <Tarjeta etiqueta="Ticket promedio" valor={dinero(d.resumen.promedioVentaCentavos)} />
        <Tarjeta etiqueta="Costo de mercadería" valor={dinero(d.resumen.costoMercaderiaCentavos)} />
        <Tarjeta
          etiqueta="Ganancia bruta"
          valor={dinero(d.resumen.gananciaBrutaCentavos)}
          color={d.resumen.gananciaBrutaCentavos >= 0 ? "var(--kanagawa-green)" : "var(--kanagawa-red)"}
          testid="ganancia-bruta"
        />
      </div>
      <h3 className="mm-sub">Detalle de ventas</h3>
      <Tabla
        testid="tabla-ventas"
        vacio="No hubo ventas en el período consultado."
        columnas={[
          { titulo: "Folio", celda: (v) => v.folio || `V${v.id}` },
          { titulo: "Fecha", celda: (v) => formatDateShort(v.fecha) },
          { titulo: "Método", celda: (v) => metodo(v.metodoPago) },
          { titulo: "Cliente", celda: (v) => v.clienteNombre || "Mostrador" },
          { titulo: "Vendedor", celda: (v) => v.usuarioNombre || "—" },
          { titulo: "Subtotal", celda: (v) => dinero(v.subtotalCentavos), alinear: "der" },
          { titulo: "IVA", celda: (v) => dinero(v.ivaCentavos), alinear: "der" },
          { titulo: "Total", celda: (v) => dinero(v.totalCentavos), alinear: "der" }
        ]}
        filas={d.detalle}
      />
    </>
  ),

  // ---- 2. Productos -----------------------------------------------------------------------
  productos: (d) => (
    <>
      <div className="stats-grid">
        <Tarjeta etiqueta="Productos vendidos" valor={formatNumber(d.resumen.cantidadProductos)} testid="cantidad-productos" />
        <Tarjeta etiqueta="Ingresos del período" valor={dinero(d.resumen.totalIngresosCentavos)} testid="ingresos-productos" />
      </div>
      <h3 className="mm-sub">Lo que más se vendió</h3>
      <Tabla
        testid="tabla-productos"
        vacio="No se vendió ningún producto en el período consultado."
        columnas={[
          { titulo: "Producto", celda: (p) => p.nombre },
          { titulo: "Cantidad", celda: (p) => cantidad(p.cantidadVendidaMilli, p.unidadMedida), alinear: "der" },
          { titulo: "Ingresos", celda: (p) => dinero(p.totalIngresosCentavos), alinear: "der" }
        ]}
        filas={d.detalle}
      />
    </>
  ),

  // ---- 3. Caja ---------------------------------------------------------------------------
  caja: (d) => (
    <>
      <div className="stats-grid">
        <Tarjeta etiqueta="Entradas de caja" valor={dinero(d.resumen.totalIngresosCentavos)} />
        <Tarjeta etiqueta="Salidas de caja" valor={dinero(d.resumen.totalEgresosCentavos)} />
        <Tarjeta etiqueta="Saldo final" valor={dinero(d.resumen.saldoFinalCentavos)} testid="saldo-final" />
        <Tarjeta
          etiqueta="Caja en el cajón"
          valor={dinero(d.resumen.saldoCajaCentavos)}
          nota={d.caja ? `Caja ${d.caja.id} · ${d.caja.estado}` : "Sin caja abierta"}
          testid="saldo-cajon"
        />
        <Tarjeta etiqueta="En la cuenta 1.1.01" valor={dinero(d.resumen.cuentaCajaCentavos)} testid="saldo-cuenta" />
        <Tarjeta
          etiqueta="El cajón y la cuenta"
          valor={d.resumen.coincide ? "Coinciden" : "No coinciden"}
          color={d.resumen.coincide ? "var(--kanagawa-green)" : "var(--kanagawa-red)"}
          nota={d.resumen.coincide ? undefined : "El cajón y la cuenta 1.1.01 están distintos"}
          testid="caja-coincide"
        />
      </div>
      <h3 className="mm-sub">Movimientos de la caja</h3>
      <Tabla
        testid="tabla-caja"
        vacio="Esta caja todavía no tiene movimientos."
        columnas={[
          { titulo: "Tipo", celda: (m) => (m.tipo === "ingreso" ? "Ingreso" : "Egreso") },
          { titulo: "Concepto", celda: (m) => m.concepto },
          {
            titulo: "Monto",
            celda: (m) => `${m.tipo === "ingreso" ? "+" : "−"}${dinero(m.montoCentavos)}`,
            alinear: "der"
          },
          { titulo: "Saldo después", celda: (m) => dinero(m.saldoNuevoCentavos), alinear: "der" },
          { titulo: "Fecha", celda: (m) => formatDateShort(m.fecha) },
          { titulo: "Usuario", celda: (m) => m.usuarioNombre || "—" }
        ]}
        filas={d.movimientos}
      />
    </>
  ),

  // ---- 4. Deudores ------------------------------------------------------------------------
  deudores: (d) => (
    <>
      <div className="stats-grid">
        <Tarjeta etiqueta="Clientes que deben" valor={formatNumber(d.resumen.cantidadDeudores)} testid="cantidad-deudores" />
        <Tarjeta
          etiqueta="Total pendiente"
          valor={dinero(d.resumen.totalPendienteCentavos)}
          color="var(--kanagawa-red)"
          testid="total-pendiente"
        />
        <Tarjeta etiqueta="Cobrado en el período" valor={dinero(d.resumen.cobradoPeriodoCentavos)} testid="cobrado-periodo" />
        <Tarjeta etiqueta="Cobros del período" valor={formatNumber(d.resumen.cantidadCobros)} />
      </div>
      <h3 className="mm-sub">Quién debe</h3>
      <Tabla
        testid="tabla-deudores"
        vacio="Ningún cliente debe nada."
        columnas={[
          { titulo: "Cliente", celda: (x) => x.nombre },
          { titulo: "Documento", celda: (x) => x.documento || "—" },
          { titulo: "Límite", celda: (x) => (x.limiteCreditoCentavos == null ? "sin límite" : dinero(x.limiteCreditoCentavos)), alinear: "der" },
          { titulo: "Deuda total", celda: (x) => dinero(x.deudaTotalCentavos), alinear: "der" },
          { titulo: "Debe", celda: (x) => dinero(x.deudaPendienteCentavos), alinear: "der" }
        ]}
        filas={d.detalle}
      />
      <h3 className="mm-sub">Cobros del período</h3>
      <Tabla
        testid="tabla-cobros"
        vacio="No se cobró nada en el período consultado."
        columnas={[
          { titulo: "Cliente", celda: (c) => c.deudor },
          { titulo: "Monto", celda: (c) => dinero(c.montoCentavos), alinear: "der" },
          { titulo: "Método", celda: (c) => metodo(c.metodoPago) },
          { titulo: "Fecha", celda: (c) => formatDateShort(c.fecha) }
        ]}
        filas={d.cobrosPeriodo}
      />
    </>
  ),

  // ---- 5. Compras ------------------------------------------------------------------------
  compras: (d) => (
    <>
      <div className="stats-grid">
        <Tarjeta etiqueta="Compras del período" valor={dinero(d.resumen.totalComprasCentavos)} testid="total-compras" />
        <Tarjeta etiqueta="Cantidad de compras" valor={formatNumber(d.resumen.cantidadCompras)} testid="cantidad-compras" />
        <Tarjeta etiqueta="Compra promedio" valor={dinero(d.resumen.promedioCentavos)} />
      </div>
      <h3 className="mm-sub">Por proveedor</h3>
      <Tabla
        testid="tabla-compras-proveedor"
        vacio="No se registró ninguna compra en el período."
        columnas={[
          { titulo: "Proveedor", celda: (p) => p.proveedor },
          { titulo: "Total", celda: (p) => dinero(p.totalCentavos), alinear: "der" }
        ]}
        filas={d.porProveedor}
      />
      <h3 className="mm-sub">Detalle de compras</h3>
      <Tabla
        testid="tabla-compras"
        vacio="No se registró ninguna compra en el período consultado."
        columnas={[
          { titulo: "Folio", celda: (c) => c.folio || `C${c.id}` },
          { titulo: "Fecha", celda: (c) => formatDateShort(c.fecha) },
          { titulo: "Proveedor", celda: (c) => c.proveedor || "Sin proveedor" },
          { titulo: "Subtotal", celda: (c) => dinero(c.subtotalCentavos), alinear: "der" },
          { titulo: "IVA", celda: (c) => dinero(c.ivaCentavos), alinear: "der" },
          { titulo: "Total", celda: (c) => dinero(c.totalCentavos), alinear: "der" }
        ]}
        filas={d.detalle}
      />
    </>
  ),

  // ---- 6. Stock --------------------------------------------------------------------------
  stock: (d) => (
    <>
      <div className="stats-grid">
        <Tarjeta etiqueta="Productos" valor={formatNumber(d.resumen.totalProductos)} testid="total-productos-stock" />
        <Tarjeta etiqueta="Activos" valor={formatNumber(d.resumen.activos)} />
        <Tarjeta
          etiqueta="Stock bajo"
          valor={formatNumber(d.resumen.stockBajo)}
          color={d.resumen.stockBajo > 0 ? "var(--kanagawa-orange)" : undefined}
          testid="stock-bajo"
        />
        <Tarjeta
          etiqueta="Sin stock"
          valor={formatNumber(d.resumen.sinStock)}
          color={d.resumen.sinStock > 0 ? "var(--kanagawa-red)" : undefined}
          testid="sin-stock"
        />
        <Tarjeta etiqueta="Valor del inventario" valor={dinero(d.resumen.valorInventarioCentavos)} testid="valor-inventario" />
      </div>
      <h3 className="mm-sub">Productos para recargar</h3>
      <Tabla
        testid="tabla-stock-bajo"
        vacio="Ningún producto está por debajo de su mínimo."
        columnas={[
          { titulo: "Producto", celda: (p) => p.nombre },
          { titulo: "Código", celda: (p) => p.codigo || "—" },
          { titulo: "Stock", celda: (p) => cantidad(p.stockMilli, p.unidadMedida), alinear: "der" },
          { titulo: "Mínimo", celda: (p) => cantidad(p.stockMinimoMilli, p.unidadMedida), alinear: "der" }
        ]}
        filas={d.stockBajo}
      />
      <h3 className="mm-sub">Todos los productos</h3>
      <Tabla
        testid="tabla-stock"
        vacio="Todavía no cargaste productos."
        columnas={[
          { titulo: "Producto", celda: (p) => p.nombre },
          { titulo: "Código", celda: (p) => p.codigo || "—" },
          { titulo: "Stock", celda: (p) => cantidad(p.stockMilli, p.unidadMedida), alinear: "der" },
          { titulo: "Precio de venta", celda: (p) => dinero(p.precioCentavos), alinear: "der" },
          { titulo: "Precio de costo", celda: (p) => dinero(p.precioCompraCentavos), alinear: "der" }
        ]}
        filas={d.list}
      />
    </>
  ),

  // ---- 7. Gastos -------------------------------------------------------------------------
  gastos: (d) => (
    <>
      <div className="stats-grid">
        <Tarjeta etiqueta="Gastos del período" valor={dinero(d.resumen.totalGastosCentavos)} testid="total-gastos" />
        <Tarjeta etiqueta="Cantidad de gastos" valor={formatNumber(d.resumen.cantidadMovimientos)} testid="cantidad-gastos" />
        <Tarjeta etiqueta="Gasto promedio" valor={dinero(d.resumen.promedioGastoCentavos)} />
      </div>
      <h3 className="mm-sub">Detalle de gastos</h3>
      <Tabla
        testid="tabla-gastos"
        vacio="No se registró ningún gasto propio en el período."
        columnas={[
          { titulo: "Concepto", celda: (g) => g.concepto },
          { titulo: "Monto", celda: (g) => dinero(g.montoCentavos), alinear: "der" },
          { titulo: "Fecha", celda: (g) => formatDateShort(g.fecha) },
          { titulo: "Usuario", celda: (g) => g.usuarioNombre || "—" }
        ]}
        filas={d.detalle}
      />
    </>
  ),

  // ---- 8. Resumen gerencial --------------------------------------------------------------
  gerencial: (d) => {
    const r = d.resumen;
    return (
      <>
        <div className="stats-grid">
          <Tarjeta etiqueta="Ventas del período" valor={dinero(r.totalVentasCentavos)} testid="ger-ventas" />
          <Tarjeta etiqueta="Costo de mercadería" valor={dinero(r.costoMercaderiaCentavos)} />
          <Tarjeta
            etiqueta="Ganancia bruta"
            valor={dinero(r.gananciaBrutaCentavos)}
            color={r.gananciaBrutaCentavos >= 0 ? "var(--kanagawa-green)" : "var(--kanagawa-red)"}
            testid="ger-ganancia-bruta"
          />
          <Tarjeta etiqueta="Margen bruto" valor={porcentaje(r.margenBrutoPct)} testid="ger-margen" />
          <Tarjeta etiqueta="Gastos operativos" valor={dinero(r.gastosOperativosCentavos)} testid="ger-gastos" />
          <Tarjeta
            etiqueta="Ganancia neta"
            valor={dinero(r.gananciaNetaCentavos)}
            color={r.gananciaNetaCentavos >= 0 ? "var(--kanagawa-green)" : "var(--kanagawa-red)"}
            testid="ger-ganancia-neta"
          />
          <Tarjeta etiqueta="Margen neto" valor={porcentaje(r.margenNetoPct)} />
          <Tarjeta etiqueta="Ticket promedio" valor={dinero(r.ticketPromedioCentavos)} testid="ger-ticket" />
        </div>

        <div className="card">
          <div className="card-header"><h3>Contra el período anterior</h3></div>
          <p style={{ fontSize: 12, color: "var(--kanagawa-fg-muted)", margin: "0 0 14px" }}>
            {formatDateShort(d.periodoAnterior.fechaInicio)} al {formatDateShort(d.periodoAnterior.fechaFin)}
          </p>
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Indicador</th>
                  <th style={{ textAlign: "right" }}>Período actual</th>
                  <th style={{ textAlign: "right" }}>Período anterior</th>
                  <th style={{ textAlign: "right" }}>Variación</th>
                </tr>
              </thead>
              <tbody>
                {d.comparativo.map((f) => (
                  <tr key={f.indicador} className="table-row" data-testid={`comparativo-${f.indicador}`}>
                    <td className="td">{f.indicador}</td>
                    <td className="td" style={{ textAlign: "right" }}>
                      {f.formato === "moneda" ? dinero(f.actual) : f.formato === "porcentaje" ? porcentaje(f.actual) : f.formato === "cantidad" ? cantidad(f.actual, "unidad") : formatNumber(f.actual ?? 0)}
                    </td>
                    <td className="td" style={{ textAlign: "right", color: "var(--kanagawa-fg-muted)" }}>
                      {f.formato === "moneda" ? dinero(f.anterior) : f.formato === "porcentaje" ? porcentaje(f.anterior) : f.formato === "cantidad" ? cantidad(f.anterior, "unidad") : formatNumber(f.anterior ?? 0)}
                    </td>
                    <td
                      className="td"
                      style={{ textAlign: "right", fontWeight: 600, color: f.variacion == null ? "var(--kanagawa-fg-muted)" : f.variacion >= 0 ? "var(--kanagawa-green)" : "var(--kanagawa-red)" }}
                    >
                      {variacion(f.variacion, f.tipo)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </>
    );
  },

  // ---- 9. Análisis del negocio -----------------------------------------------------------
  analisis: (d) => {
    const s = d.semaforo;
    return (
      <>
        <div className="card">
          <div className="card-header"><h3>Cómo viene el negocio</h3></div>
          <div className="table-container">
            <table>
              <tbody>
                <tr className="table-row" data-testid="semaforo-margen">
                  <td className="td"><Semaforo color={s.margenBruto.color} /> Margen bruto del período</td>
                  <td className="td" style={{ textAlign: "right" }}>{porcentaje(s.margenBruto.valorPct)}</td>
                </tr>
                <tr className="table-row" data-testid="semaforo-ventas">
                  <td className="td"><Semaforo color={s.variacionVentas.color} /> Ventas contra el período anterior</td>
                  <td className="td" style={{ textAlign: "right" }}>{variacion(s.variacionVentas.variacionPct, "pct")}</td>
                </tr>
                <tr className="table-row" data-testid="semaforo-gastos">
                  <td className="td"><Semaforo color={s.variacionGastos.color} /> Gastos operativos</td>
                  <td className="td" style={{ textAlign: "right" }}>{variacion(s.variacionGastos.variacionPct, "pct")}</td>
                </tr>
                <tr className="table-row" data-testid="semaforo-ticket">
                  <td className="td"><Semaforo color={s.variacionTicket.color} /> Ticket promedio</td>
                  <td className="td" style={{ textAlign: "right" }}>{variacion(s.variacionTicket.variacionPct, "pct")}</td>
                </tr>
                <tr className="table-row" data-testid="semaforo-stock">
                  <td className="td"><Semaforo color={s.productosSinMovimiento.color} /> Productos sin movimiento</td>
                  <td className="td" style={{ textAlign: "right" }}>{formatNumber(s.productosSinMovimiento.cantidad)}</td>
                </tr>
                <tr className="table-row" data-testid="semaforo-deudores">
                  <td className="td"><Semaforo color={s.deudoresPendientes.color} /> Clientes con saldo pendiente</td>
                  <td className="td" style={{ textAlign: "right" }}>{formatNumber(s.deudoresPendientes.cantidad)}</td>
                </tr>
                <tr className="table-row" data-testid="semaforo-margen-bajo">
                  <td className="td"><Semaforo color={s.productosMargenBajo.color} /> Productos con margen bajo</td>
                  <td className="td" style={{ textAlign: "right" }}>{formatNumber(s.productosMargenBajo.cantidad)}</td>
                </tr>
                <tr className="table-row" data-testid="semaforo-no-positivos">
                  <td className="td"><Semaforo color={s.productosMargenNoPositivo.color} /> Productos que no dan ganancia</td>
                  <td className="td" style={{ textAlign: "right" }}>{formatNumber(s.productosMargenNoPositivo.cantidad)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: 12, color: "var(--kanagawa-fg-muted)", marginTop: 12 }}>
            Verde a partir de {d.umbrales.margenVerdePct}% de margen, amarillo desde {d.umbrales.margenAmarilloPct}%.
          </p>
        </div>

        <h3 className="mm-sub">Productos con margen bajo</h3>
        <Tabla
          testid="tabla-margen-bajo"
          vacio="Ningún producto vendido tiene margen bajo."
          columnas={[
            { titulo: "Producto", celda: (p) => p.nombre },
            { titulo: "Vendidas", celda: (p) => cantidad(p.unidadesMilli, p.unidadMedida), alinear: "der" },
            { titulo: "Margen", celda: (p) => porcentaje(p.margenPct), alinear: "der" },
            { titulo: "Ganancia", celda: (p) => dinero(p.gananciaCentavos), alinear: "der" }
          ]}
          filas={d.detalle.productosMargenBajo}
        />

        <h3 className="mm-sub">Productos que no dan ganancia</h3>
        <Tabla
          testid="tabla-no-positivos"
          vacio="Todos los productos vendidos dan ganancia."
          columnas={[
            { titulo: "Producto", celda: (p) => p.nombre },
            { titulo: "Vendidas", celda: (p) => cantidad(p.unidadesMilli, p.unidadMedida), alinear: "der" },
            { titulo: "Margen", celda: (p) => (p.margenPct == null ? "sin costo cargado" : porcentaje(p.margenPct)), alinear: "der" },
            { titulo: "Ganancia", celda: (p) => dinero(p.gananciaCentavos), alinear: "der" }
          ]}
          filas={d.detalle.productosNoPositivos}
        />

        <h3 className="mm-sub">Productos que no se movieron</h3>
        <Tabla
          testid="tabla-sin-movimiento"
          vacio="Todos los productos activos se vendieron en el período."
          columnas={[{ titulo: "Producto", celda: (p) => p.nombre }]}
          filas={d.detalle.productosSinMovimiento}
        />
      </>
    );
  },

  // ---- 10. Estado de resultados ----------------------------------------------------------
  resultados: (d) => (
    <>
      <div className="stats-grid">
        <Tarjeta etiqueta="Ingresos" valor={dinero(d.resumen.ingresosCentavos)} color="var(--kanagawa-green)" testid="res-ingresos" />
        <Tarjeta etiqueta="Gastos" valor={dinero(d.resumen.gastosCentavos)} color="var(--kanagawa-red)" testid="res-gastos" />
        <Tarjeta
          etiqueta="Resultado"
          valor={dinero(d.resumen.resultadoCentavos)}
          color={d.resumen.resultadoCentavos >= 0 ? "var(--kanagawa-green)" : "var(--kanagawa-red)"}
          testid="res-resultado"
        />
        <Tarjeta etiqueta="Margen" valor={porcentaje(d.resumen.margenPct)} testid="res-margen" />
      </div>
      <h3 className="mm-sub">Cuentas del período</h3>
      <Tabla
        testid="tabla-cuentas"
        vacio="No se registraron movimientos en el período."
        columnas={[
          { titulo: "Código", celda: (c) => c.codigo },
          { titulo: "Cuenta", celda: (c) => c.nombre },
          { titulo: "Tipo", celda: (c) => c.tipo },
          { titulo: "Debe", celda: (c) => dinero(c.debeCentavos), alinear: "der" },
          { titulo: "Haber", celda: (c) => dinero(c.haberCentavos), alinear: "der" },
          { titulo: "Saldo", celda: (c) => dinero(c.saldoCentavos), alinear: "der" }
        ]}
        filas={d.cuentas}
      />
      <h3 className="mm-sub">Día por día</h3>
      <Tabla
        testid="tabla-diario"
        vacio="No se registraron movimientos en el período."
        columnas={[
          { titulo: "Día", celda: (x) => formatDateShort(x.fecha) },
          { titulo: "Ingresos", celda: (x) => dinero(x.ingresosCentavos), alinear: "der" },
          { titulo: "Egresos", celda: (x) => dinero(x.egresosCentavos), alinear: "der" },
          { titulo: "Resultado", celda: (x) => dinero(x.resultadoCentavos), alinear: "der" }
        ]}
        filas={d.diario}
      />
    </>
  )
};

/**
 * THE SCREEN.
 *
 * A tab key from the route (`/reportes/ventas`) decides the report, and the route is the only
 * thing that decides it. A deep link straight into `/reportes/ventas` therefore lands on the
 * sales report, and the tab strip agrees with it — one source of truth, so the URL an operator
 * bookmarks and the screen they see cannot be two different things.
 */
const Reportes = () => {
  const { reporte } = useParams();
  const navegar = useNavigate();
  const tab = TAB_POR_CLAVE[reporte] ? reporte : "ventas";
  const conRango = TAB_POR_CLAVE[tab].rango !== false;

  const [desde, setDesde] = useState(inicioDeMes());
  const [hasta, setHasta] = useState(hoyLocal());
  const [datos, setDatos] = useState(null);
  const [consultando, setConsultando] = useState(false);

  const consultar = useCallback(async () => {
    setConsultando(true);
    try {
      const r = conRango ? { fechaInicio: desde, fechaFin: hasta } : {};
      switch (tab) {
        case "ventas": setDatos(await reportesAPI.ventas(r)); break;
        case "productos": setDatos(await reportesAPI.productosMasVendidos(r, 50)); break;
        case "caja": setDatos(await reportesAPI.caja()); break;
        case "deudores": setDatos(await reportesAPI.deudores(r)); break;
        case "compras": setDatos(await reportesAPI.compras(r)); break;
        case "stock": setDatos(await reportesAPI.stock()); break;
        case "gastos": setDatos(await reportesAPI.gastos(r)); break;
        case "gerencial": setDatos(await reportesAPI.gerencial(r)); break;
        case "analisis": setDatos(await reportesAPI.analisisNegocio(r)); break;
        case "resultados": setDatos(await reportesAPI.estadoResultados(r)); break;
        default: setDatos(null);
      }
    } catch (err) {
      setDatos(null);
      toast.error(mensajeDeError(err, "No se pudo consultar el reporte"));
    } finally {
      setConsultando(false);
    }
  }, [tab, desde, hasta, conRango]);

  // The range belongs to the REPORT, not to the screen: switching from Ventas to Gastos keeps the
  // dates an operator already typed instead of resetting them under their fingers, and each
  // screen's Consultar is explicit. A report that refetched on every keystroke would also re-query
  // while somebody is still choosing the month.
  useEffect(() => { setDatos(null); }, [tab]);

  const Cuerpo = CUERPOS[tab];
  const periodo = conRango
    ? datos?.periodo
      ? `${formatDateShort(datos.periodo.fechaInicio)} al ${formatDateShort(datos.periodo.fechaFin)}`
      : "Elegí el período y presioná Consultar"
    : "Este reporte no usa fechas";

  return (
    <div>
      <div className="bar">
        <h2>Reportes</h2>
      </div>

      {/* The tab strip, grouped the way the web grouped it. The user said the visual design comes
          later; a screen with no navigation is not a design question, it is a missing feature. */}
      <div className="mm-reportes-tabs" role="tablist" aria-label="Reportes">
        {GRUPOS.map((grupo) => (
          <div key={grupo} className="mm-reportes-grupo">
            <span className="mm-reportes-grupo-titulo">{grupo}</span>
            {TABS.filter((t) => t.grupo === grupo).map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={t.key === tab}
                className={`mm-reportes-tab${t.key === tab ? " activa" : ""}`}
                onClick={() => navegar(`/reportes/${t.key}`)}
                data-testid={`tab-${t.key}`}
              >
                <i className={`fa-solid ${t.icono}`} aria-hidden="true"></i> {t.nombre}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          {conRango ? (
            <>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label htmlFor="rep-desde">Desde</label>
                <input id="rep-desde" type="date" value={desde} onChange={(e) => setDesde(e.target.value)} data-testid="fecha-desde" />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label htmlFor="rep-hasta">Hasta</label>
                <input id="rep-hasta" type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} data-testid="fecha-hasta" />
              </div>
            </>
          ) : null}
          <button type="button" className="btn-primary" onClick={consultar} disabled={consultando} data-testid="consultar">
            <i className={`fa-solid ${consultando ? "fa-spinner fa-spin" : TAB_POR_CLAVE[tab].icono}`} aria-hidden="true"></i>{" "}
            {consultando ? "Consultando..." : "Consultar"}
          </button>
          <span style={{ fontSize: 13, color: "var(--kanagawa-fg-muted)" }} data-testid="periodo">{periodo}</span>
        </div>
      </div>

      {consultando && !datos ? <Loader /> : null}
      {!consultando && !datos ? (
        <div className="card" data-testid="sin-consultar">
          <p style={{ margin: 0, color: "var(--kanagawa-fg-muted)", fontSize: 14 }}>
            Todavía no consultaste este reporte. Elegí el período y presioná <strong>Consultar</strong>.
          </p>
        </div>
      ) : null}
      {/* The report IS the props. `CUERPOS[tab]` is a plain function of the report object, so its
          first argument is the props bag and `d.resumen` reads `props.resumen`. Passing the report
          as a `datos` prop instead would hand every body `{ datos: {...} }`, and the first
          `d.resumen.totalIngresosCentavos` would be `undefined` on ten screens at once — a blank
          page per tab, from a line that looks correct. */}
      {datos ? <Cuerpo {...datos} /> : null}
    </div>
  );
};

export default Reportes;
