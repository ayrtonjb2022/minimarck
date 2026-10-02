/**
 * THE HOME SCREEN, and the first thing an operator sees after signing in.
 *
 * `dashboard.stats` is the only operation behind it. It answers four figures the web's panel also
 * had — what was taken, what is on the shelf, who owes, what moved — and nothing else, because
 * this build has no accounting screen and no notifications feed to summarise.
 *
 * WHY THE PRESETS AND NOT A DATE PICKER. The panel's window is a PRESET the operator picks —
 * today, this week, this month, this year — and main counts it back from the current LOCAL day.
 * The alternative, a pair of date inputs, would let the renderer choose the window, and a
 * dashboard is exactly the screen where a chosen window is a chosen story. The period selector
 * here names an intent; a date range names a fact someone else picked.
 *
 * THE FIGURES COME STRAIGHT FROM THE REPOSITORY and are formatted by `shared/money.js`, the same
 * two modules the reports and the POS use. There is no arithmetic in this file.
 */

import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "react-toastify";
import { dashboardAPI } from "../api/reportes";
import { mensajeDeError } from "../api/ipc";
import { formatCentavos, formatCantidad, formatNumber, formatDateShort } from "../utils/formatters";
import Loader from "../components/common/Loader";

/** The four windows, named the way an operator asks for them. */
const PERIODOS = [
  { clave: "day", nombre: "Hoy" },
  { clave: "week", nombre: "Esta semana" },
  { clave: "month", nombre: "Este mes" },
  { clave: "year", nombre: "Este año" }
];

/**
 * A number that might not be there. Same rule as the reports: a dash, never a `$0,00` that claims
 * a figure was measured. On the panel this matters most for a shop with no sales yet, which is
 * what a shop looks like on the morning it opens.
 */
const dinero = (centavos) => (centavos == null ? "—" : formatCentavos(centavos));
const entero = (n) => (n == null ? "—" : formatNumber(n));
const cantidad = (milli, unidad) =>
  milli == null ? "—" : formatCantidad(milli, { unidad: unidad || "unidad", baseDecimals: true });

/**
 * A figure, in one of the app's existing card shapes.
 *
 * `nota` carries its own testid, for the same reason `Reportes.jsx` states at length: "3 ventas"
 * is a claim in the screen's own words, and a test that cannot name the node making the claim
 * cannot hold it to account.
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

const Panel = () => {
  const [periodo, setPeriodo] = useState("month");
  const [datos, setDatos] = useState(null);
  const [consultando, setConsultando] = useState(true);

  const consultar = useCallback(async (clave) => {
    setConsultando(true);
    try {
      setDatos(await dashboardAPI.stats(clave));
    } catch (err) {
      setDatos(null);
      toast.error(mensajeDeError(err, "No se pudo cargar el panel"));
    } finally {
      setConsultando(false);
    }
  }, []);

  useEffect(() => { consultar(periodo); }, [periodo, consultar]);

  if (consultando && !datos) return <Loader />;

  if (!datos) {
    return (
      <div className="card" data-testid="panel-error">
        <p style={{ margin: 0, color: "var(--kanagawa-fg-muted)", fontSize: 14 }}>
          No se pudo cargar el panel. Revisá que haya una caja abierta y presioná{" "}
          <button type="button" className="btn-secondary" onClick={() => consultar(periodo)} style={{ padding: "2px 8px" }}>
            Reintentar
          </button>
          .
        </p>
      </div>
    );
  }

  const v = datos.ventas;
  const p = datos.productos;
  const d = datos.deudores;

  return (
    <div>
      <div className="bar">
        <h2>Panel</h2>
        <div className="bar" role="group" aria-label="Período">
          {PERIODOS.map((per) => (
            <button
              key={per.clave}
              type="button"
              className={`btn-${per.clave === periodo ? "primary" : "secondary"}`}
              aria-pressed={per.clave === periodo}
              onClick={() => setPeriodo(per.clave)}
              data-testid={`periodo-${per.clave}`}
              style={{ padding: "6px 12px", fontSize: 13 }}
            >
              {per.nombre}
            </button>
          ))}
        </div>
      </div>

      <p style={{ fontSize: 13, color: "var(--kanagawa-fg-muted)", marginTop: 0 }} data-testid="panel-periodo">
        {formatDateShort(datos.periodo.fechaInicio)} al {formatDateShort(datos.periodo.fechaFin)}
      </p>

      <div className="stats-grid">
        <Tarjeta
          etiqueta="Ventas del período"
          valor={dinero(v.ingresosCentavos)}
          color="var(--kanagawa-green)"
          nota={`${entero(v.total)} ventas`}
          testid="panel-ventas"
        />
        <Tarjeta
          etiqueta="Productos activos"
          valor={entero(p.activos)}
          nota={p.bajoStock > 0 ? `${entero(p.bajoStock)} con stock bajo` : "stock en regla"}
          color={p.bajoStock > 0 ? "var(--kanagawa-orange)" : undefined}
          testid="panel-productos"
        />
        <Tarjeta
          etiqueta="Clientes que deben"
          valor={dinero(d.deudaTotalCentavos)}
          color={d.deudaTotalCentavos > 0 ? "var(--kanagawa-red)" : undefined}
          nota={`${entero(d.total)} en cuentas corrientes`}
          testid="panel-deudores"
        />
        <Tarjeta
          etiqueta="Sin stock"
          valor={entero(p.sinStock)}
          color={p.sinStock > 0 ? "var(--kanagawa-red)" : "var(--kanagawa-green)"}
          testid="panel-sin-stock"
        />
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Últimas ventas</h3>
          <Link className="link" to="/ventas">Ver historial</Link>
        </div>
        {v.recientes.length === 0 ? (
          <p style={{ color: "var(--kanagawa-fg-muted)", fontSize: 14, margin: 0 }} data-testid="panel-sin-ventas">
            Todavía no hay ventas registradas.
          </p>
        ) : (
          <div className="table-container" data-testid="tabla-recientes">
            <table>
              <thead>
                <tr>
                  <th>Folio</th>
                  <th>Cliente</th>
                  <th style={{ textAlign: "right" }}>Total</th>
                  <th>Fecha</th>
                </tr>
              </thead>
              <tbody>
                {v.recientes.map((s) => (
                  <tr key={s.id} className="table-row">
                    <td className="td">{s.folio}</td>
                    <td className="td">{s.clienteNombre}</td>
                    <td className="td" style={{ textAlign: "right" }}>{dinero(s.totalCentavos)}</td>
                    <td className="td">{formatDateShort(s.fecha)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header"><h3>Lo que más se vendió</h3></div>
        {p.topVendidos.length === 0 ? (
          <p style={{ color: "var(--kanagawa-fg-muted)", fontSize: 14, margin: 0 }} data-testid="panel-sin-top">
            Todavía no se vendió nada en este período.
          </p>
        ) : (
          <div className="table-container" data-testid="tabla-top">
            <table>
              <thead>
                <tr>
                  <th>Producto</th>
                  <th style={{ textAlign: "right" }}>Vendidas</th>
                  <th style={{ textAlign: "right" }}>Stock</th>
                  <th style={{ textAlign: "right" }}>Ingresos</th>
                </tr>
              </thead>
              <tbody>
                {p.topVendidos.map((t) => (
                  <tr key={t.productoId ?? t.nombre} className="table-row">
                    <td className="td">{t.nombre}</td>
                    <td className="td" style={{ textAlign: "right" }}>{cantidad(t.cantidadMilli, t.unidadMedida)}</td>
                    <td className="td" style={{ textAlign: "right" }}>{cantidad(t.stockMilli, t.unidadMedida)}</td>
                    <td className="td" style={{ textAlign: "right" }}>{dinero(t.ingresosCentavos)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* The seven-day series, as a list. It is a chart in the web (recharts) and this build has
          no chart library, so it is shown as the numbers themselves — which is what a chart was
          drawing anyway, and it is readable at a till. */}
      <div className="card">
        <div className="card-header"><h3>Ventas de los últimos siete días</h3></div>
        <div className="table-container" data-testid="tabla-siete-dias">
          <table>
            <thead>
              <tr>
                <th>Día</th>
                <th>Fecha</th>
                <th style={{ textAlign: "right" }}>Ventas</th>
              </tr>
            </thead>
            <tbody>
              {v.diarias.map((dia) => (
                <tr key={dia.fecha} className="table-row">
                  <td className="td">{dia.day}</td>
                  <td className="td">{formatDateShort(dia.fecha)}</td>
                  <td className="td" style={{ textAlign: "right" }}>{dinero(dia.valueCentavos)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default Panel;
