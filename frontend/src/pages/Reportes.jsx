import React, { useState, useEffect } from "react";
import { reportesAPI } from "../api/reportes";
import { negocioAPI } from "../api/negocio";
import { exportExcel, exportPDF } from "../utils/export";
import { toast } from "react-toastify";
import { formatDateShort } from "../utils/formatters";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => { const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10); };

const fmt = (n) => `$${(n ?? 0).toFixed(2)}`;

const cleanParams = (params) => Object.fromEntries(Object.entries(params).filter(([, v]) => v !== "" && v != null));

const tabs = [
  { key: "general", label: "General", icon: "fa-solid fa-chart-pie" },
  { key: "ganancias", label: "Ganancias", icon: "fa-solid fa-money-bill-trend-up" },
  { key: "ventas", label: "Ventas", icon: "fa-solid fa-chart-line" },
  { key: "productos", label: "Productos", icon: "fa-solid fa-crown" },
];

const columnsVentas = [
  { key: "folio", header: "Folio", cell: (r) => r.folio },
  { key: "fecha", header: "Fecha", cell: (r) => formatDateShort(r.fecha) },
  { key: "total", header: "Total", cell: (r) => `$${parseFloat(r.total).toFixed(2)}` },
  { key: "metodoPago", header: "Método Pago", cell: (r) => r.metodoPago },
  { key: "usuario", header: "Usuario", cell: (r) => r.usuario?.nombre || "-" },
];

const columnsProductos = [
  { key: "#", header: "#", cell: (_, i) => String(i + 1) },
  { key: "producto", header: "Producto", cell: (r) => r.producto?.nombre || "-" },
  { key: "codigo", header: "Código", cell: (r) => r.producto?.codigo || "-" },
  { key: "totalVendido", header: "Total Vendido", cell: (r) => String(r.totalVendido) },
  { key: "ingresos", header: "Ingresos", cell: (r) => `$${parseFloat(r.totalIngresos).toFixed(2)}` },
];

const sinCosto = (pc) => pc == null || pc === 0;
const cellSinCosto = (val, fmtFn) => (val == null || val === 0)
  ? <span style={{color: "#94a3b8", fontStyle: "italic"}}>—</span>
  : fmtFn(val);

const columnsGanancias = [
  { key: "producto", header: "Producto", cell: (r) => r.producto || "-" },
  { key: "cantidad", header: "Cant.", cell: (r) => String(r.cantidad) },
  { key: "precioVenta", header: "Precio Venta", cell: (r) => `$${r.precioVenta.toFixed(2)}` },
  { key: "precioCompra", header: "Precio Costo", cell: (r) => cellSinCosto(r.precioCompra, (v) => `$${v.toFixed(2)}`) },
  { key: "totalVenta", header: "Total Venta", cell: (r) => `$${r.totalVenta.toFixed(2)}` },
  { key: "costoTotal", header: "Costo Total", cell: (r) => cellSinCosto(r.costoTotal, (v) => `$${v.toFixed(2)}`) },
  { key: "ganancia", header: "Ganancia", cell: (r) => (
    sinCosto(r.precioCompra)
      ? <span style={{color: "#94a3b8", fontStyle: "italic"}}>—</span>
      : <span style={{color: r.ganancia >= 0 ? "#16a34a" : "#dc2626", fontWeight: 700}}>${r.ganancia.toFixed(2)}</span>
  )},
  { key: "margen", header: "Margen", cell: (r) => (
    sinCosto(r.precioCompra)
      ? <span style={{color: "#94a3b8", fontStyle: "italic"}}>—</span>
      : <span style={{color: r.margen >= 0 ? "#16a34a" : "#dc2626", fontWeight: 600}}>{r.margen.toFixed(1)}%</span>
  )},
];

export default function Reportes() {
  const [tab, setTab] = useState("general");
  const [negocio, setNegocio] = useState(null);
  const [loading, setLoading] = useState({ general: false, ganancias: false, ventas: false, productos: false });

  useEffect(() => {
    negocioAPI.obtener().then((r) => setNegocio(r.data?.data || r.data)).catch(() => {});
  }, []);
  const [dates, setDates] = useState({
    general: { fechaInicio: monthStart(), fechaFin: today() },
    ganancias: { fechaInicio: monthStart(), fechaFin: today() },
    ventas: { fechaInicio: monthStart(), fechaFin: today() },
    productos: { fechaInicio: monthStart(), fechaFin: today() },
  });
  const [generalResult, setGeneralResult] = useState(null);
  const [gananciasResult, setGananciasResult] = useState(null);
  const [ventasResult, setVentasResult] = useState(null);
  const [productosResult, setProductosResult] = useState(null);

  const handleConsultarGeneral = async () => {
    const { fechaInicio, fechaFin } = dates.general;
    if (!fechaInicio || !fechaFin) { toast.error("Seleccioná fecha de inicio y fin"); return; }
    try {
      setLoading((p) => ({ ...p, general: true }));
      const res = await reportesAPI.estadoResultados(cleanParams({ fechaInicio, fechaFin }));
      setGeneralResult(res.data.data);
    } catch { toast.error("Error al consultar estado de resultados"); }
    finally { setLoading((p) => ({ ...p, general: false })); }
  };

  const handleConsultarGanancias = async () => {
    const { fechaInicio, fechaFin } = dates.ganancias;
    if (!fechaInicio || !fechaFin) { toast.error("Seleccioná fecha de inicio y fin"); return; }
    try {
      setLoading((p) => ({ ...p, ganancias: true }));
      const res = await reportesAPI.ventas(cleanParams({ fechaInicio, fechaFin }));
      const data = res.data.data;
      const items = [];

      for (const venta of data.detalle || []) {
        for (const det of venta.detalles || []) {
          const pv = parseFloat(det.precioUnitario) || 0;
          const pc = parseFloat(det.producto?.precioCompra) || 0;
          const cant = det.cantidad || 0;
          const totalVenta = pv * cant;
          const costoTotal = pc * cant;
          const ganancia = totalVenta - costoTotal;
          items.push({
            producto: det.producto?.nombre || det.nombreProducto || "Producto",
            cantidad: cant,
            precioVenta: pv,
            precioCompra: pc,
            totalVenta,
            costoTotal,
            ganancia,
            margen: totalVenta > 0 ? (ganancia / totalVenta) * 100 : 0,
          });
        }
      }

      const totalVenta = items.reduce((s, i) => s + i.totalVenta, 0);
      const totalCosto = items.reduce((s, i) => s + i.costoTotal, 0);
      const totalGanancia = items.reduce((s, i) => s + i.ganancia, 0);

      setGananciasResult({ items, totalVenta, totalCosto, totalGanancia });
    } catch { toast.error("Error al consultar ganancias"); }
    finally { setLoading((p) => ({ ...p, ganancias: false })); }
  };

  const handleConsultarVentas = async () => {
    const { fechaInicio, fechaFin } = dates.ventas;
    if (!fechaInicio || !fechaFin) { toast.error("Seleccioná fecha de inicio y fin"); return; }
    try {
      setLoading((p) => ({ ...p, ventas: true }));
      const res = await reportesAPI.ventas(cleanParams({ fechaInicio, fechaFin }));
      setVentasResult(res.data.data);
    } catch { toast.error("Error al consultar reporte de ventas"); }
    finally { setLoading((p) => ({ ...p, ventas: false })); }
  };

  const handleTopProductos = async () => {
    const { fechaInicio, fechaFin } = dates.productos;
    if (!fechaInicio || !fechaFin) { toast.error("Seleccioná fecha de inicio y fin"); return; }
    try {
      setLoading((p) => ({ ...p, productos: true }));
      const res = await reportesAPI.productosMasVendidos(cleanParams({ limit: 10, fechaInicio, fechaFin }));
      setProductosResult(res.data.data);
    } catch { toast.error("Error al consultar top productos"); }
    finally { setLoading((p) => ({ ...p, productos: false })); }
  };

  const currentDates = dates[tab];
  const setCurrentDates = (updater) => setDates((prev) => ({ ...prev, [tab]: updater(prev[tab]) }));

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload) return null;
    return (
      <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "12px 16px", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}>
        <p style={{ fontSize: 13, fontWeight: 600, margin: "0 0 8px", color: "#475569" }}>{label}</p>
        {payload.map((p, i) => (
          <p key={i} style={{ fontSize: 13, margin: "2px 0", color: p.color }}>{p.name}: {fmt(p.value)}</p>
        ))}
      </div>
    );
  };

  const formatXAxis = (dateStr) => {
    const d = new Date(dateStr + "T12:00:00");
    return d.toLocaleDateString(import.meta.env.VITE_CURRENCY_LOCALE || "es-CL", { day: "2-digit", month: "2-digit" });
  };

  return (
    <div>
      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "1px solid #e2e8f0", paddingBottom: 0 }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: "10px 20px",
              border: "none",
              borderBottom: tab === t.key ? "2px solid #3b82f6" : "2px solid transparent",
              background: "transparent",
              color: tab === t.key ? "#2563eb" : "#64748b",
              fontWeight: tab === t.key ? 600 : 400,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            <i className={t.icon} style={{ marginRight: 6 }}></i>{t.label}
          </button>
        ))}
      </div>

      {/* Date filters + action button */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 12 }}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Fecha Inicio</label>
              <input type="date" value={currentDates.fechaInicio} onChange={(e) => setCurrentDates((prev) => ({ ...prev, fechaInicio: e.target.value }))} />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Fecha Fin</label>
              <input type="date" value={currentDates.fechaFin} onChange={(e) => setCurrentDates((prev) => ({ ...prev, fechaFin: e.target.value }))} />
            </div>
          </div>
          <button
            onClick={tab === "general" ? handleConsultarGeneral : tab === "ganancias" ? handleConsultarGanancias : tab === "ventas" ? handleConsultarVentas : handleTopProductos}
            disabled={loading[tab]}
            className="btn-primary"
          >
            <i className={tabs.find((t) => t.key === tab)?.icon}></i> {loading[tab] ? "Consultando..." : "Consultar"}
          </button>
        </div>
      </div>

      {/* General tab */}
      {tab === "general" && generalResult && (
        <>
          <div className="stats-grid" style={{ marginBottom: 20 }}>
            <div className="stat-card" style={{ borderTop: "3px solid #22c55e" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Ingresos</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#16a34a" }}>{fmt(generalResult.resumen.totalIngresos)}</p>
            </div>
            <div className="stat-card" style={{ borderTop: "3px solid #ef4444" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Gastos</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#dc2626" }}>{fmt(generalResult.resumen.totalEgresos)}</p>
            </div>
            <div className="stat-card" style={{ borderTop: `3px solid ${generalResult.resumen.gananciaNeta >= 0 ? "#3b82f6" : "#ef4444"}` }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Ganancia Neta</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: generalResult.resumen.gananciaNeta >= 0 ? "#2563eb" : "#dc2626" }}>{fmt(generalResult.resumen.gananciaNeta)}</p>
            </div>
            <div className="stat-card" style={{ borderTop: `3px solid ${generalResult.resumen.margen >= 0 ? "#a855f7" : "#ef4444"}` }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Margen</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#a855f7" }}>{generalResult.resumen.margen.toFixed(1)}%</p>
            </div>
          </div>

          <div className="card">
            <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>Ingresos vs Gastos diarios</h3>
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={generalResult.diario} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="fecha" tickFormatter={formatXAxis} tick={{ fontSize: 12, fill: "#94a3b8" }} />
                <YAxis tick={{ fontSize: 12, fill: "#94a3b8" }} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                <Tooltip content={<CustomTooltip />} />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 13, paddingTop: 8 }} />
                <Bar dataKey="ingresos" name="Ingresos" fill="#22c55e" radius={[4, 4, 0, 0]} maxBarSize={32} />
                <Bar dataKey="egresos" name="Gastos" fill="#ef4444" radius={[4, 4, 0, 0]} maxBarSize={32} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      {/* Ganancias tab */}
      {tab === "ganancias" && gananciasResult && (
        <>
          <div className="stats-grid" style={{ marginBottom: 20 }}>
            <div className="stat-card" style={{ borderTop: "3px solid #3b82f6" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Total Vendido</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#2563eb" }}>{fmt(gananciasResult.totalVenta)}</p>
            </div>
            <div className="stat-card" style={{ borderTop: "3px solid #f59e0b" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Costo Total</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#d97706" }}>
                {gananciasResult.totalCosto > 0 ? fmt(gananciasResult.totalCosto) : <span style={{color: "#94a3b8", fontStyle: "italic"}}>— sin datos</span>}
              </p>
            </div>
            <div className="stat-card" style={{ borderTop: "3px solid #22c55e" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Ganancia Total</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#16a34a" }}>
                {gananciasResult.totalCosto > 0 ? fmt(gananciasResult.totalGanancia) : <span style={{color: "#94a3b8", fontStyle: "italic"}}>— sin datos</span>}
              </p>
            </div>
            <div className="stat-card" style={{ borderTop: `3px solid ${gananciasResult.totalCosto > 0 ? "#a855f7" : "#94a3b8"}` }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Margen</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: gananciasResult.totalCosto > 0 ? "#a855f7" : "#94a3b8" }}>
                {gananciasResult.totalCosto > 0
                  ? ((gananciasResult.totalGanancia / gananciasResult.totalVenta) * 100).toFixed(1) + "%"
                  : <span style={{fontStyle: "italic", fontSize: 16}}>sin costo configurado</span>}
              </p>
            </div>
          </div>

          {gananciasResult.items.every((i) => !i.precioCompra) && (
            <div style={{background: "#fef9c3", border: "1px solid #fde047", borderRadius: 12, padding: "14px 18px", marginBottom: 20, fontSize: 13, color: "#854d0e"}}>
              <i className="fa-solid fa-triangle-exclamation" style={{marginRight: 6}}></i>
              <strong>Sin precios de costo.</strong> Los productos no tienen <strong>Precio Costo</strong> configurado.
              Andá a <strong>Productos</strong>, editá cada producto y completá el campo <strong>Precio Costo</strong> para ver ganancias reales.
            </div>
          )}

          <div className="table-container">
            <table>
              <thead>
                <tr>
                  {columnsGanancias.map((c) => (
                    <th key={c.key} style={{ padding: "10px 12px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "#64748b" }}>{c.header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {gananciasResult.items.map((item, i) => (
                  <tr key={i} className="table-row">
                    {columnsGanancias.map((c) => (
                      <td key={c.key} className="td">{c.cell(item)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Ventas tab */}
      {tab === "ventas" && ventasResult && (
        <div className="card">
          <div className="stats-grid" style={{ marginBottom: 20 }}>
            <div className="stat-card">
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Total Ventas</p>
              <p style={{ fontSize: 22, fontWeight: 700, margin: "4px 0 0", color: "#0f172a" }}>{ventasResult.resumen?.totalVentas ?? 0}</p>
            </div>
            <div className="stat-card">
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Total Ingresos</p>
              <p style={{ fontSize: 22, fontWeight: 700, margin: "4px 0 0", color: "#16a34a" }}>{fmt(ventasResult.resumen?.totalIngresos ?? 0)}</p>
            </div>
            <div className="stat-card">
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Promedio Venta</p>
              <p style={{ fontSize: 22, fontWeight: 700, margin: "4px 0 0", color: "#2563eb" }}>{fmt(ventasResult.resumen?.promedioVenta ?? 0)}</p>
            </div>
            <div className="stat-card">
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Período</p>
              <p style={{ fontSize: 14, fontWeight: 600, margin: "4px 0 0", color: "#64748b" }}>{ventasResult.resumen?.periodo?.fechaInicio ?? "-"} / {ventasResult.resumen?.periodo?.fechaFin ?? "-"}</p>
            </div>
          </div>

          {ventasResult.detalle?.length > 0 && (
            <>
              <div className="table-container">
                <table>
                  <thead>
                    <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e9edf2" }}>
                      {columnsVentas.map((c) => (<th key={c.key} style={{ padding: "10px 12px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "#64748b" }}>{c.header}</th>))}
                    </tr>
                  </thead>
                  <tbody>
                    {ventasResult.detalle.map((v) => (
                      <tr key={v.id} className="table-row">
                        {columnsVentas.map((c) => (<td key={c.key} className="td">{c.cell(v)}</td>))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button onClick={() => exportExcel(ventasResult.detalle, columnsVentas, `ventas-${dates.ventas.fechaInicio}-${dates.ventas.fechaFin}`)}
                  className="btn-secondary" style={{ fontSize: 13 }}>
                  <i className="fa-solid fa-file-excel"></i> Excel
                </button>
                <button onClick={() => exportPDF("Reporte de Ventas", columnsVentas, ventasResult.detalle, `ventas-${dates.ventas.fechaInicio}-${dates.ventas.fechaFin}`, negocio)}
                  className="btn-secondary" style={{ fontSize: 13 }}>
                  <i className="fa-solid fa-file-pdf"></i> PDF
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Productos tab */}
      {tab === "productos" && productosResult && productosResult.length > 0 && (
        <div className="card">
          <div className="table-container">
            <table>
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e9edf2" }}>
                  {columnsProductos.map((c) => (<th key={c.key} style={{ padding: "10px 12px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "#64748b" }}>{c.header}</th>))}
                </tr>
              </thead>
              <tbody>
                {productosResult.map((p, i) => (
                  <tr key={p.productoId} className="table-row">
                    {columnsProductos.map((c) => (<td key={c.key} className="td">{c.cell(p, i)}</td>))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button onClick={() => exportExcel(productosResult, columnsProductos, `top-productos-${dates.productos.fechaInicio}-${dates.productos.fechaFin}`)}
              className="btn-secondary" style={{ fontSize: 13 }}>
              <i className="fa-solid fa-file-excel"></i> Excel
            </button>
            <button onClick={() => exportPDF("Top Productos Más Vendidos", columnsProductos, productosResult, `top-productos-${dates.productos.fechaInicio}-${dates.productos.fechaFin}`, negocio)}
              className="btn-secondary" style={{ fontSize: 13 }}>
              <i className="fa-solid fa-file-pdf"></i> PDF
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
