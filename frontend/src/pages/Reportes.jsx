import React, { useState, useEffect } from "react";
import { reportesAPI } from "../api/reportes";
import { negocioAPI } from "../api/negocio";
import { useCaja } from "../context/CajaContext";
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
  // Diagnóstico
  { key: "gerencial", label: "Resumen gerencial", icon: "fa-solid fa-chart-pie" },
  { key: "analisis", label: "Análisis del negocio", icon: "fa-solid fa-brain" },
  // Operativos
  { key: "ventas", label: "Ventas", icon: "fa-solid fa-chart-line" },
  { key: "productos", label: "Productos", icon: "fa-solid fa-crown" },
  { key: "compras", label: "Compras", icon: "fa-solid fa-truck-ramp-box" },
  { key: "stock", label: "Stock", icon: "fa-solid fa-boxes-stacked" },
  { key: "gastos", label: "Gastos", icon: "fa-solid fa-file-invoice-dollar" },
  { key: "deudores", label: "Deudores", icon: "fa-solid fa-hand-holding-dollar" },
  // Financieros
  { key: "general", label: "General", icon: "fa-solid fa-chart-pie" },
  { key: "ganancias", label: "Ganancias", icon: "fa-solid fa-money-bill-trend-up" },
  { key: "caja", label: "Caja", icon: "fa-solid fa-coins" },
];

// Agrupación del menú con encabezados de sección
const tabGroups = [
  { label: "Diagnóstico", keys: ["gerencial", "analisis"] },
  { label: "Operativos", keys: ["ventas", "productos", "compras", "stock", "gastos", "deudores"] },
  { label: "Financieros", keys: ["general", "ganancias", "caja"] },
];

// Busca el tab por clave (para el botón Consultar y la barra agrupada)
const tabByKey = (key) => tabs.find((t) => t.key === key);

const columnsGerencial = [
  { key: "indicador", header: "Indicador" },
  { key: "actual", header: "Período actual" },
  { key: "anterior", header: "Período anterior" },
  { key: "variacion", header: "Variación" },
];

// Valor plano (string) para exportación: depende del formato declarado por la API
const fmtValorGerencial = (row, value) => {
  if (row.formato === "numero") return String(value ?? 0);
  if (row.formato === "porcentaje") return `${(value ?? 0).toFixed(1)}%`;
  return fmt(value ?? 0); // moneda
};

const fmtVariacionGerencial = (row) => {
  const v = row.variacion;
  if (v == null) return "—";
  const signo = v >= 0 ? "+" : "";
  return `${signo}${v.toFixed(1)}${row.tipo === "pp" ? " pp" : "%"}`;
};

// Filas planas para Excel y PDF (un solo array compartido)
const gerencialExportRows = (comparativo) =>
  comparativo.map((row) => ({
    indicador: row.indicador,
    actual: fmtValorGerencial(row, row.actual),
    anterior: fmtValorGerencial(row, row.anterior),
    variacion: fmtVariacionGerencial(row),
  }));

// Celdas con color para la tabla en pantalla
const cellVariacionGerencial = (row) => {
  const v = row.variacion;
  if (v == null) {
    return <span style={{ color: "#94a3b8", fontStyle: "italic" }}>—</span>;
  }
  const color = v >= 0 ? "#16a34a" : "#dc2626";
  const signo = v >= 0 ? "+" : "";
  return (
    <span style={{ color, fontWeight: 600 }}>
      {signo}
      {v.toFixed(1)}
      {row.tipo === "pp" ? " pp" : "%"}
    </span>
  );
};

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

// ===== Stock =====
const columnsStock = [
  { key: "nombre", header: "Producto", cell: (r) => r.nombre },
  { key: "codigo", header: "Código", cell: (r) => r.codigo || "-" },
  { key: "precio", header: "Precio", cell: (r) => fmt(r.precio) },
  { key: "precioCompra", header: "Precio costo", cell: (r) => fmt(r.precioCompra) },
  { key: "stock", header: "Stock", cell: (r) => String(r.stock) },
];

const columnsStockBajo = [
  { key: "nombre", header: "Producto", cell: (r) => r.nombre },
  { key: "codigo", header: "Código", cell: (r) => r.codigo || "-" },
  { key: "stock", header: "Stock", cell: (r) => (
    <span style={{ color: r.stock <= 0 ? "#dc2626" : "#d97706", fontWeight: 600 }}>{r.stock}</span>
  )},
  { key: "stockMinimo", header: "Stock mín.", cell: (r) => r.stockMinimo ?? "-" },
];
const columnsStockBajoExport = [
  { key: "nombre", header: "Producto", cell: (r) => r.nombre },
  { key: "codigo", header: "Código", cell: (r) => r.codigo || "-" },
  { key: "stock", header: "Stock", cell: (r) => String(r.stock) },
  { key: "stockMinimo", header: "Stock mín.", cell: (r) => r.stockMinimo ?? "-" },
];

// ===== Gastos =====
const columnsGastos = [
  { key: "#", header: "#", cell: (_, i) => String(i + 1) },
  { key: "concepto", header: "Concepto", cell: (r) => r.concepto },
  { key: "monto", header: "Monto", cell: (r) => <span style={{ color: "#dc2626", fontWeight: 600 }}>{fmt(r.monto)}</span> },
  { key: "referencia", header: "Referencia", cell: (r) => r.referencia || "-" },
  { key: "fecha", header: "Fecha", cell: (r) => formatDateShort(r.fecha) },
  { key: "usuario", header: "Usuario", cell: (r) => r.usuario?.nombre || "-" },
];
const columnsGastosExport = [
  { key: "#", header: "#", cell: (_, i) => String(i + 1) },
  { key: "concepto", header: "Concepto", cell: (r) => r.concepto },
  { key: "monto", header: "Monto", cell: (r) => fmt(r.monto) },
  { key: "referencia", header: "Referencia", cell: (r) => r.referencia || "-" },
  { key: "fecha", header: "Fecha", cell: (r) => formatDateShort(r.fecha) },
  { key: "usuario", header: "Usuario", cell: (r) => r.usuario?.nombre || "-" },
];

// ===== Compras =====
const columnsCompras = [
  { key: "folio", header: "Folio", cell: (r) => r.folio || r.id },
  { key: "fecha", header: "Fecha", cell: (r) => formatDateShort(r.fecha) },
  { key: "total", header: "Total", cell: (r) => fmt(r.total) },
  { key: "proveedor", header: "Proveedor", cell: (r) => r.proveedor?.nombre || "-" },
  { key: "estado", header: "Estado", cell: (r) => r.estado },
];

// ===== Deudores =====
const columnsDeudoresReporte = [
  { key: "nombre", header: "Deudor", cell: (r) => r.nombre },
  { key: "deudaPendiente", header: "Saldo pendiente", cell: (r) => <span style={{ color: "#dc2626", fontWeight: 600 }}>{fmt(r.deudaPendiente)}</span> },
];
const columnsDeudoresReporteExport = [
  { key: "nombre", header: "Deudor", cell: (r) => r.nombre },
  { key: "deudaPendiente", header: "Saldo pendiente", cell: (r) => fmt(r.deudaPendiente) },
];

const columnsCobros = [
  { key: "deudor", header: "Deudor", cell: (r) => r.deudor },
  { key: "monto", header: "Monto", cell: (r) => fmt(r.monto) },
  { key: "fecha", header: "Fecha", cell: (r) => formatDateShort(r.fecha) },
];

// ===== Caja (movimientos de la caja abierta) =====
const fmtNum = (n) => `$${parseFloat(n ?? 0).toFixed(2)}`;
const columnsCaja = [
  { key: "tipo", header: "Tipo", cell: (r) => (r.tipo === "ingreso" ? "Ingreso" : "Egreso") },
  { key: "concepto", header: "Concepto", cell: (r) => r.concepto },
  { key: "monto", header: "Monto", cell: (r) => (
    <span style={{ color: r.tipo === "ingreso" ? "#16a34a" : "#dc2626", fontWeight: 600 }}>
      {r.tipo === "ingreso" ? "+" : "-"}{fmtNum(r.monto)}
    </span>
  )},
  { key: "fecha", header: "Fecha", cell: (r) => formatDateShort(r.createdAt) },
  { key: "usuario", header: "Usuario", cell: (r) => r.usuario?.nombre || "-" },
];
const columnsCajaExport = [
  { key: "tipo", header: "Tipo", cell: (r) => (r.tipo === "ingreso" ? "Ingreso" : "Egreso") },
  { key: "concepto", header: "Concepto", cell: (r) => r.concepto },
  { key: "monto", header: "Monto", cell: (r) => (r.tipo === "ingreso" ? "+" : "-") + fmtNum(r.monto) },
  { key: "fecha", header: "Fecha", cell: (r) => formatDateShort(r.createdAt) },
  { key: "usuario", header: "Usuario", cell: (r) => r.usuario?.nombre || "-" },
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

// Variante plana para exportación (PDF/Excel) — las celdas de columnsGanancias
// devuelven JSX con colores, que autoTable y XLSX no pueden serializar.
const columnsGananciasExport = [
  { key: "producto", header: "Producto", cell: (r) => r.producto || "-" },
  { key: "cantidad", header: "Cantidad", cell: (r) => String(r.cantidad) },
  { key: "precioVenta", header: "Precio Venta", cell: (r) => `$${r.precioVenta.toFixed(2)}` },
  { key: "precioCompra", header: "Precio Costo", cell: (r) => (sinCosto(r.precioCompra) ? "—" : `$${r.precioCompra.toFixed(2)}`) },
  { key: "totalVenta", header: "Total Venta", cell: (r) => `$${r.totalVenta.toFixed(2)}` },
  { key: "costoTotal", header: "Costo Total", cell: (r) => (sinCosto(r.costoTotal) ? "—" : `$${r.costoTotal.toFixed(2)}`) },
  { key: "ganancia", header: "Ganancia", cell: (r) => (sinCosto(r.precioCompra) ? "—" : `$${r.ganancia.toFixed(2)}`) },
  { key: "margen", header: "Margen", cell: (r) => (sinCosto(r.precioCompra) ? "—" : `${r.margen.toFixed(1)}%`) },
];

// Filas planas para Excel — XLSX usa las claves del objeto como encabezados,
// así que usamos claves legibles en vez de las keys internas.
const gananciasExcelRows = (items) =>
  items.map((i) => ({
    Producto: i.producto || "-",
    Cantidad: i.cantidad,
    "Precio Venta": `$${i.precioVenta.toFixed(2)}`,
    "Precio Costo": sinCosto(i.precioCompra) ? "—" : `$${i.precioCompra.toFixed(2)}`,
    "Total Venta": `$${i.totalVenta.toFixed(2)}`,
    "Costo Total": sinCosto(i.costoTotal) ? "—" : `$${i.costoTotal.toFixed(2)}`,
    Ganancia: sinCosto(i.precioCompra) ? "—" : `$${i.ganancia.toFixed(2)}`,
    Margen: sinCosto(i.precioCompra) ? "—" : `${i.margen.toFixed(1)}%`,
  }));

// ===== Análisis del negocio (semáforo) =====
const semaforoColor = (color) =>
  ({ verde: "#16a34a", amarillo: "#d97706", rojo: "#dc2626" }[color] || "#64748b");

const fmtVarPct = (v) => {
  if (v == null) return "—";
  const signo = v >= 0 ? "+" : "";
  return `${signo}${v.toFixed(1)}%`;
};

// Filas del semáforo: dot de color + etiqueta + valor (texto en Argentina)
const semaforoRows = (r) => {
  const s = r.semaforo || {};
  const u = r.umbrales || {};
  return [
    { key: "margenBruto", color: s.margenBruto?.color, label: "Margen bruto del período", value: `${s.margenBruto?.valor?.toFixed(1) ?? 0}%` },
    { key: "productosMargenBajo", color: s.productosMargenBajo15?.color, label: `Productos con margen entre 0% y ${u.margenAmarillo ?? 15}%`, value: `${s.productosMargenBajo15?.cantidad ?? 0} producto(s)` },
    { key: "productosNoPositivos", color: s.productosMargenNoPositivo?.color, label: "Productos con margen 0% o negativo (incluye sin precio de costo)", value: `${s.productosMargenNoPositivo?.cantidad ?? 0} producto(s)` },
    { key: "ventas", color: s.variacionVentas?.color, label: "Ventas vs. período anterior", value: s.variacionVentas?.variacionPct == null ? "sin datos" : fmtVarPct(s.variacionVentas.variacionPct) },
    { key: "gastos", color: s.variacionGastos?.color, label: "Gastos operativos vs. período anterior", value: s.variacionGastos?.variacionPct == null ? "sin datos" : fmtVarPct(s.variacionGastos.variacionPct) },
    { key: "ticket", color: s.variacionTicket?.color, label: "Ticket promedio vs. período anterior", value: s.variacionTicket?.variacionPct == null ? "sin datos" : fmtVarPct(s.variacionTicket.variacionPct) },
    { key: "sinMovimiento", color: s.productosSinMovimiento?.color, label: "Productos sin movimiento en el período", value: `${s.productosSinMovimiento?.cantidad ?? 0}` },
    { key: "clientes", color: s.deudoresPendientes?.color, label: "Clientes con saldo pendiente", value: `${s.deudoresPendientes?.cantidad ?? 0}` },
  ].filter((row) => row.color != null);
};

// Columnas de las tablas de detalle (pantalla con color / exportación plana)
const columnsMargenBajo = [
  { key: "nombre", header: "Producto", cell: (r) => r.nombre },
  { key: "margenPct", header: "Margen", cell: (r) => <span style={{ color: "#d97706", fontWeight: 600 }}>{r.margenPct?.toFixed(1)}%</span> },
  { key: "ganancia", header: "Ganancia", cell: (r) => fmt(r.ganancia) },
];
const columnsMargenBajoExport = [
  { key: "nombre", header: "Producto", cell: (r) => r.nombre },
  { key: "margenPct", header: "Margen", cell: (r) => (r.margenPct == null ? "—" : `${r.margenPct.toFixed(1)}%`) },
  { key: "ganancia", header: "Ganancia", cell: (r) => (r.ganancia == null ? "—" : fmt(r.ganancia)) },
];
const margenBajoExcelRows = (items) => items.map((i) => ({
  Producto: i.nombre,
  Margen: i.margenPct == null ? "—" : `${i.margenPct.toFixed(1)}%`,
  Ganancia: i.ganancia == null ? "—" : fmt(i.ganancia),
}));

const columnsNoPositivos = [
  { key: "nombre", header: "Producto", cell: (r) => r.nombre },
  { key: "margenPct", header: "Margen", cell: (r) => (r.margenPct == null
    ? <span style={{ color: "#94a3b8", fontStyle: "italic" }}>— sin costo</span>
    : <span style={{ color: "#dc2626", fontWeight: 600 }}>{r.margenPct.toFixed(1)}%</span>) },
  { key: "ganancia", header: "Ganancia", cell: (r) => cellSinCosto(r.ganancia, fmt) },
];
const columnsNoPositivosExport = [
  { key: "nombre", header: "Producto", cell: (r) => r.nombre },
  { key: "margenPct", header: "Margen", cell: (r) => (r.margenPct == null ? "— sin costo" : `${r.margenPct.toFixed(1)}%`) },
  { key: "ganancia", header: "Ganancia", cell: (r) => (r.ganancia == null ? "—" : fmt(r.ganancia)) },
];
const noPositivosExcelRows = (items) => items.map((i) => ({
  Producto: i.nombre,
  Margen: i.margenPct == null ? "— sin costo" : `${i.margenPct.toFixed(1)}%`,
  Ganancia: i.ganancia == null ? "—" : fmt(i.ganancia),
}));

const columnsSinMovimiento = [
  { key: "producto", header: "Productos", cell: (r) => r },
];
const sinMovimientoExcelRows = (items) => items.map((nombre) => ({ Productos: nombre }));

const columnsDeudores = [
  { key: "deudor", header: "Deudor", cell: (r) => r.deudor },
  { key: "montoPendiente", header: "Saldo pendiente", cell: (r) => <span style={{ color: "#dc2626", fontWeight: 600 }}>{fmt(r.montoPendiente)}</span> },
];
const columnsDeudoresExport = [
  { key: "deudor", header: "Deudor", cell: (r) => r.deudor },
  { key: "montoPendiente", header: "Saldo pendiente", cell: (r) => fmt(r.montoPendiente) },
];
const deudoresExcelRows = (items) => items.map((i) => ({
  Deudor: i.deudor,
  "Saldo pendiente": fmt(i.montoPendiente),
}));

// Sección de detalle reutilizable: tabla + botones Excel/PDF (mismo patrón del resto de pestañas).
// columns = celdas con color para pantalla; columnsExport = celdas planas para PDF (autoTable no
// serializa JSX, mismo criterio que columnsGananciasExport); renderExcel = filas con claves
// legibles para Excel (XLSX usa las claves como encabezados).
const DetalleReporte = ({ titulo, columns, columnsExport, rows, renderExcel, filename, negocio }) => (
  <div className="card">
    <h3 style={{ margin: "0 0 16px", fontSize: 15 }}>{titulo}</h3>
    <div className="table-container">
      <table>
        <thead>
          <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e9edf2" }}>
            {columns.map((c) => (
              <th key={c.key} style={{ padding: "10px 12px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "#64748b" }}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="table-row">
              {columns.map((c) => (
                <td key={c.key} className="td">{c.cell ? c.cell(r, i) : r[c.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
      <button onClick={() => exportExcel(renderExcel(rows), columns, filename)} className="btn-secondary" style={{ fontSize: 13 }}>
        <i className="fa-solid fa-file-excel"></i> Excel
      </button>
      <button onClick={() => exportPDF(titulo, columnsExport, rows, filename, negocio)} className="btn-secondary" style={{ fontSize: 13 }}>
        <i className="fa-solid fa-file-pdf"></i> PDF
      </button>
    </div>
  </div>
);

export default function Reportes() {
  const [tab, setTab] = useState("gerencial");
  const [negocio, setNegocio] = useState(null);
  const [loading, setLoading] = useState({
    gerencial: false, general: false, ganancias: false, analisis: false, ventas: false,
    productos: false, stock: false, gastos: false, compras: false, deudores: false, caja: false,
  });
  const { cajaActiva } = useCaja();

  useEffect(() => {
    negocioAPI.obtener().then((r) => setNegocio(r.data?.data || r.data)).catch(() => {});
  }, []);
  const [dates, setDates] = useState({
    gerencial: { fechaInicio: monthStart(), fechaFin: today() },
    general: { fechaInicio: monthStart(), fechaFin: today() },
    ganancias: { fechaInicio: monthStart(), fechaFin: today() },
    analisis: { fechaInicio: monthStart(), fechaFin: today() },
    ventas: { fechaInicio: monthStart(), fechaFin: today() },
    productos: { fechaInicio: monthStart(), fechaFin: today() },
    stock: { fechaInicio: monthStart(), fechaFin: today() },
    gastos: { fechaInicio: monthStart(), fechaFin: today() },
    compras: { fechaInicio: monthStart(), fechaFin: today() },
    deudores: { fechaInicio: monthStart(), fechaFin: today() },
    caja: { fechaInicio: monthStart(), fechaFin: today() },
  });
  const [gerencialResult, setGerencialResult] = useState(null);
  const [generalResult, setGeneralResult] = useState(null);
  const [gananciasResult, setGananciasResult] = useState(null);
  const [analisisResult, setAnalisisResult] = useState(null);
  const [ventasResult, setVentasResult] = useState(null);
  const [productosResult, setProductosResult] = useState(null);
  const [stockResult, setStockResult] = useState(null);
  const [gastosResult, setGastosResult] = useState(null);
  const [comprasResult, setComprasResult] = useState(null);
  const [deudoresResult, setDeudoresResult] = useState(null);
  const [cajaResult, setCajaResult] = useState(null);

  const handleConsultarGerencial = async () => {
    const { fechaInicio, fechaFin } = dates.gerencial;
    if (!fechaInicio || !fechaFin) { toast.error("Seleccioná fecha de inicio y fin"); return; }
    try {
      setLoading((p) => ({ ...p, gerencial: true }));
      const res = await reportesAPI.gerencial(cleanParams({ fechaInicio, fechaFin }));
      setGerencialResult(res.data.data);
    } catch { toast.error("Error al consultar resumen gerencial"); }
    finally { setLoading((p) => ({ ...p, gerencial: false })); }
  };

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

  const handleConsultarAnalisis = async () => {
    const { fechaInicio, fechaFin } = dates.analisis;
    if (!fechaInicio || !fechaFin) { toast.error("Seleccioná fecha de inicio y fin"); return; }
    try {
      setLoading((p) => ({ ...p, analisis: true }));
      const res = await reportesAPI.analisisNegocio(cleanParams({ fechaInicio, fechaFin }));
      setAnalisisResult(res.data.data);
    } catch { toast.error("Error al consultar análisis del negocio"); }
    finally { setLoading((p) => ({ ...p, analisis: false })); }
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

  // Stock: no depende de fechas (es el estado ACTUAL del inventario)
  const handleConsultarStock = async () => {
    try {
      setLoading((p) => ({ ...p, stock: true }));
      const res = await reportesAPI.stock();
      setStockResult(res.data.data);
    } catch { toast.error("Error al consultar reporte de stock"); }
    finally { setLoading((p) => ({ ...p, stock: false })); }
  };

  const handleConsultarGastos = async () => {
    const { fechaInicio, fechaFin } = dates.gastos;
    if (!fechaInicio || !fechaFin) { toast.error("Seleccioná fecha de inicio y fin"); return; }
    try {
      setLoading((p) => ({ ...p, gastos: true }));
      const res = await reportesAPI.gastos(cleanParams({ fechaInicio, fechaFin }));
      setGastosResult(res.data.data);
    } catch { toast.error("Error al consultar reporte de gastos"); }
    finally { setLoading((p) => ({ ...p, gastos: false })); }
  };

  const handleConsultarCompras = async () => {
    const { fechaInicio, fechaFin } = dates.compras;
    if (!fechaInicio || !fechaFin) { toast.error("Seleccioná fecha de inicio y fin"); return; }
    try {
      setLoading((p) => ({ ...p, compras: true }));
      const res = await reportesAPI.compras(cleanParams({ fechaInicio, fechaFin }));
      setComprasResult(res.data.data);
    } catch { toast.error("Error al consultar reporte de compras"); }
    finally { setLoading((p) => ({ ...p, compras: false })); }
  };

  const handleConsultarDeudores = async () => {
    const { fechaInicio, fechaFin } = dates.deudores;
    if (!fechaInicio || !fechaFin) { toast.error("Seleccioná fecha de inicio y fin"); return; }
    try {
      setLoading((p) => ({ ...p, deudores: true }));
      const res = await reportesAPI.deudores(cleanParams({ fechaInicio, fechaFin }));
      setDeudoresResult(res.data.data);
    } catch { toast.error("Error al consultar reporte de deudores"); }
    finally { setLoading((p) => ({ ...p, deudores: false })); }
  };

  // Caja: usa la caja abierta actual vía CajaContext; si no hay, avisa al usuario
  const handleConsultarCaja = async () => {
    if (!cajaActiva) { toast.error("Necesitás tener una caja abierta (ver menú Caja)"); return; }
    try {
      setLoading((p) => ({ ...p, caja: true }));
      const res = await reportesAPI.caja(cajaActiva.id);
      setCajaResult(res.data.data);
    } catch { toast.error("Error al consultar reporte de caja"); }
    finally { setLoading((p) => ({ ...p, caja: false })); }
  };

  // Mapeo clave de pestaña -> handler de consulta (reemplaza la cadena de ternarios)
  const actionForTab = {
    gerencial: handleConsultarGerencial,
    general: handleConsultarGeneral,
    ganancias: handleConsultarGanancias,
    analisis: handleConsultarAnalisis,
    ventas: handleConsultarVentas,
    productos: handleTopProductos,
    stock: handleConsultarStock,
    gastos: handleConsultarGastos,
    compras: handleConsultarCompras,
    deudores: handleConsultarDeudores,
    caja: handleConsultarCaja,
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
      {/* Tabs agrupados por sección */}
      <div style={{ marginBottom: 20, borderBottom: "1px solid #e2e8f0" }}>
        {tabGroups.map((group) => (
          <div key={group.label} style={{ marginBottom: 2 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.06em", padding: "10px 4px 4px" }}>
              {group.label}
            </div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {group.keys.map((key) => {
                const t = tabByKey(key);
                if (!t) return null;
                return (
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
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Date filters + action button */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 12 }}>
          {/* Stock y Caja no usan fechas: oculto los inputs para no confundir */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            {tab !== "stock" && tab !== "caja" && (
              <>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label>Fecha Inicio</label>
                  <input type="date" value={currentDates.fechaInicio} onChange={(e) => setCurrentDates((prev) => ({ ...prev, fechaInicio: e.target.value }))} />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label>Fecha Fin</label>
                  <input type="date" value={currentDates.fechaFin} onChange={(e) => setCurrentDates((prev) => ({ ...prev, fechaFin: e.target.value }))} />
                </div>
              </>
            )}
          </div>
          <button
            onClick={() => actionForTab[tab]?.()}
            disabled={loading[tab]}
            className="btn-primary"
          >
            <i className={tabByKey(tab)?.icon}></i> {loading[tab] ? "Consultando..." : "Consultar"}
          </button>
        </div>
      </div>

      {/* Gerencial tab */}
      {tab === "gerencial" && gerencialResult && (
        <>
          <div className="stats-grid" style={{ marginBottom: 20 }}>
            <div className="stat-card" style={{ borderTop: "3px solid #22c55e" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Ventas del período</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#16a34a" }}>{fmt(gerencialResult.resumen.ventasTotales)}</p>
            </div>
            <div className="stat-card" style={{ borderTop: "3px solid #94a3b8" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Costo de mercadería</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#475569" }}>{fmt(gerencialResult.resumen.costoMercaderia)}</p>
            </div>
            <div className="stat-card" style={{ borderTop: "3px solid #3b82f6" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Ganancia bruta</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#2563eb" }}>{fmt(gerencialResult.resumen.gananciaBruta)}</p>
            </div>
            <div className="stat-card" style={{ borderTop: "3px solid #a855f7" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Margen bruto</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#a855f7" }}>{gerencialResult.resumen.margenBrutoPct.toFixed(1)}%</p>
            </div>
          </div>

          <div className="stats-grid" style={{ marginBottom: 20 }}>
            <div className="stat-card" style={{ borderTop: "3px solid #ef4444" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Gastos operativos</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#dc2626" }}>{fmt(gerencialResult.resumen.gastosOperativos)}</p>
            </div>
            <div className="stat-card" style={{ borderTop: `3px solid ${gerencialResult.resumen.gananciaNeta >= 0 ? "#22c55e" : "#ef4444"}` }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Ganancia neta</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: gerencialResult.resumen.gananciaNeta >= 0 ? "#16a34a" : "#dc2626" }}>{fmt(gerencialResult.resumen.gananciaNeta)}</p>
            </div>
            <div className="stat-card" style={{ borderTop: "3px solid #a855f7" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Margen neto</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#a855f7" }}>{gerencialResult.resumen.margenNetoPct.toFixed(1)}%</p>
            </div>
            <div className="stat-card" style={{ borderTop: "3px solid #3b82f6" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Ticket promedio</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#2563eb" }}>{fmt(gerencialResult.resumen.ticketPromedio)}</p>
            </div>
          </div>

          {/* Indicadores secundarios */}
          <div className="card" style={{ marginBottom: 20 }}>
            <h3 style={{ margin: "0 0 14px", fontSize: 15 }}>Indicadores del período</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
              {[
                { label: "Cantidad de ventas", value: String(gerencialResult.resumen.cantidadVentas), color: "#0f172a" },
                { label: "Unidades vendidas", value: String(gerencialResult.resumen.unidadesVendidas), color: "#0f172a" },
                { label: "Día mayor venta", value: gerencialResult.indicadores?.diaMayorVenta ? `${formatDateShort(gerencialResult.indicadores.diaMayorVenta.fecha)} · ${fmt(gerencialResult.indicadores.diaMayorVenta.total)}` : "—", color: "#16a34a" },
                { label: "Día menor venta", value: gerencialResult.indicadores?.diaMenorVenta ? `${formatDateShort(gerencialResult.indicadores.diaMenorVenta.fecha)} · ${fmt(gerencialResult.indicadores.diaMenorVenta.total)}` : "—", color: "#dc2626" },
                { label: "Total comprado", value: fmt(gerencialResult.resumen.totalComprometidoCompras), color: "#2563eb" },
                { label: "Total cobrado deudores", value: fmt(gerencialResult.resumen.totalCobradoDeudores), color: "#2563eb" },
                { label: "Producto más vendido", value: gerencialResult.indicadores?.topProductoCantidad ? `${gerencialResult.indicadores.topProductoCantidad.producto} (${gerencialResult.indicadores.topProductoCantidad.cantidad})` : "—", color: "#a855f7" },
                { label: "Producto con más ingresos", value: gerencialResult.indicadores?.topProductoIngresos ? `${gerencialResult.indicadores.topProductoIngresos.producto} · ${fmt(gerencialResult.indicadores.topProductoIngresos.ingresos)}` : "—", color: "#a855f7" },
              ].map((s) => (
                <div key={s.label} className="stat-card">
                  <p style={{ fontSize: 12, color: "#64748b", margin: 0 }}>{s.label}</p>
                  <p style={{ fontSize: 15, fontWeight: 600, margin: "4px 0 0", color: s.color, wordBreak: "break-word" }}>{s.value}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Comparativo con el período anterior */}
          <div className="card">
            <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>
              Comparación con período anterior{" "}
              <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 400 }}>
                ({formatDateShort(gerencialResult.periodoAnterior.fechaInicio)} a {formatDateShort(gerencialResult.periodoAnterior.fechaFin)})
              </span>
            </h3>
            <div className="table-container">
              <table>
                <thead>
                  <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e9edf2" }}>
                    <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "#64748b" }}>Indicador</th>
                    <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "#64748b" }}>Período actual</th>
                    <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "#64748b" }}>Período anterior</th>
                    <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "#64748b" }}>Variación</th>
                  </tr>
                </thead>
                <tbody>
                  {gerencialResult.comparativo.map((row, i) => (
                    <tr key={i} className="table-row">
                      <td className="td">{row.indicador}</td>
                      <td className="td">{fmtValorGerencial(row, row.actual)}</td>
                      <td className="td">{fmtValorGerencial(row, row.anterior)}</td>
                      <td className="td">{cellVariacionGerencial(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button
                onClick={() => exportExcel(
                  gerencialExportRows(gerencialResult.comparativo),
                  columnsGerencial,
                  `resumen-gerencial-${dates.gerencial.fechaInicio}-${dates.gerencial.fechaFin}`
                )}
                className="btn-secondary" style={{ fontSize: 13 }}
              >
                <i className="fa-solid fa-file-excel"></i> Excel
              </button>
              <button
                onClick={() => exportPDF(
                  "Resumen Gerencial",
                  columnsGerencial,
                  gerencialExportRows(gerencialResult.comparativo),
                  `resumen-gerencial-${dates.gerencial.fechaInicio}-${dates.gerencial.fechaFin}`,
                  negocio
                )}
                className="btn-secondary" style={{ fontSize: 13 }}
              >
                <i className="fa-solid fa-file-pdf"></i> PDF
              </button>
            </div>
          </div>
        </>
      )}

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
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button
              onClick={() => exportExcel(
                gananciasExcelRows(gananciasResult.items),
                columnsGananciasExport,
                `ganancias-${dates.ganancias.fechaInicio}-${dates.ganancias.fechaFin}`
              )}
              className="btn-secondary" style={{ fontSize: 13 }}
            >
              <i className="fa-solid fa-file-excel"></i> Excel
            </button>
            <button
              onClick={() => exportPDF(
                "Reporte de Ganancias",
                columnsGananciasExport,
                gananciasResult.items,
                `ganancias-${dates.ganancias.fechaInicio}-${dates.ganancias.fechaFin}`,
                negocio
              )}
              className="btn-secondary" style={{ fontSize: 13 }}
            >
              <i className="fa-solid fa-file-pdf"></i> PDF
            </button>
          </div>
        </>
      )}

      {/* Análisis del negocio tab */}
      {tab === "analisis" && analisisResult && (
        <>
          <div className="card" style={{ marginBottom: 20 }}>
            <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>
              Diagnóstico automático del negocio
            </h3>
            <p style={{ fontSize: 12, color: "#94a3b8", margin: "0 0 10px" }}>
              Período anterior: {formatDateShort(analisisResult.periodoAnterior?.fechaInicio)} a {formatDateShort(analisisResult.periodoAnterior?.fechaFin)}.
            </p>
            <div>
              {semaforoRows(analisisResult).map((row) => (
                <div key={row.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 2px", borderBottom: "1px solid #f1f5f9" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                    <span style={{ width: 12, height: 12, borderRadius: "50%", background: semaforoColor(row.color), display: "inline-block", flexShrink: 0 }} />
                    <span style={{ fontSize: 14, color: "#334155" }}>{row.label}</span>
                  </div>
                  <span style={{ fontWeight: 700, fontSize: 14, color: semaforoColor(row.color), whiteSpace: "nowrap" }}>{row.value}</span>
                </div>
              ))}
            </div>
          </div>

          {analisisResult.detalle?.productosMargenBajo?.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <DetalleReporte
                titulo="Análisis del negocio — Productos con margen bajo"
                columns={columnsMargenBajo}
                columnsExport={columnsMargenBajoExport}
                rows={analisisResult.detalle.productosMargenBajo}
                renderExcel={margenBajoExcelRows}
                filename={`analisis-negocio-margen-bajo-${dates.analisis.fechaInicio}-${dates.analisis.fechaFin}`}
                negocio={negocio}
              />
            </div>
          )}

          {analisisResult.detalle?.productosNoPositivos?.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <DetalleReporte
                titulo="Análisis del negocio — Productos con margen 0% o negativo"
                columns={columnsNoPositivos}
                columnsExport={columnsNoPositivosExport}
                rows={analisisResult.detalle.productosNoPositivos}
                renderExcel={noPositivosExcelRows}
                filename={`analisis-negocio-margen-no-positivo-${dates.analisis.fechaInicio}-${dates.analisis.fechaFin}`}
                negocio={negocio}
              />
            </div>
          )}

          {analisisResult.detalle?.productosSinMovimiento?.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <DetalleReporte
                titulo="Análisis del negocio — Productos sin movimiento"
                columns={columnsSinMovimiento}
                columnsExport={columnsSinMovimiento}
                rows={analisisResult.detalle.productosSinMovimiento}
                renderExcel={sinMovimientoExcelRows}
                filename={`analisis-negocio-sin-movimiento-${dates.analisis.fechaInicio}-${dates.analisis.fechaFin}`}
                negocio={negocio}
              />
            </div>
          )}

          {analisisResult.detalle?.deudoresPendientes?.length > 0 && (
            <DetalleReporte
              titulo="Análisis del negocio — Clientes con saldo pendiente"
              columns={columnsDeudores}
              columnsExport={columnsDeudoresExport}
              rows={analisisResult.detalle.deudoresPendientes}
              renderExcel={deudoresExcelRows}
              filename={`analisis-negocio-deudores-${dates.analisis.fechaInicio}-${dates.analisis.fechaFin}`}
              negocio={negocio}
            />
          )}
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

      {/* Stock tab */}
      {tab === "stock" && stockResult && (
        <>
          <div className="stats-grid" style={{ marginBottom: 20 }}>
            <div className="stat-card" style={{ borderTop: "3px solid #3b82f6" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Total de productos</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#2563eb" }}>{stockResult.resumen?.totalProductos ?? 0}</p>
            </div>
            <div className="stat-card" style={{ borderTop: "3px solid #22c55e" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Activos</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#16a34a" }}>{stockResult.resumen?.activos ?? 0}</p>
            </div>
            <div className="stat-card" style={{ borderTop: "3px solid #d97706" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Stock bajo</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#d97706" }}>{stockResult.resumen?.stockBajo ?? 0}</p>
            </div>
            <div className="stat-card" style={{ borderTop: "3px solid #ef4444" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Sin stock</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#dc2626" }}>{stockResult.resumen?.sinStock ?? 0}</p>
            </div>
          </div>

          {stockResult.stockBajo?.length > 0 && (
            <div className="card" style={{ marginBottom: 20 }}>
              <h3 style={{ margin: "0 0 16px", fontSize: 15 }}>Productos con stock bajo o sin stock</h3>
              <div className="table-container">
                <table>
                  <thead>
                    <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e9edf2" }}>
                      {columnsStockBajo.map((c) => (<th key={c.key} style={{ padding: "10px 12px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "#64748b" }}>{c.header}</th>))}
                    </tr>
                  </thead>
                  <tbody>
                    {stockResult.stockBajo.map((p) => (
                      <tr key={p.id} className="table-row">
                        {columnsStockBajo.map((c) => (<td key={c.key} className="td">{c.cell(p)}</td>))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button onClick={() => exportExcel(stockResult.stockBajo, columnsStockBajoExport, `stock-bajo`)}
                  className="btn-secondary" style={{ fontSize: 13 }}>
                  <i className="fa-solid fa-file-excel"></i> Excel
                </button>
                <button onClick={() => exportPDF("Reporte de Stock (bajo)", columnsStockBajoExport, stockResult.stockBajo, "stock-bajo", negocio)}
                  className="btn-secondary" style={{ fontSize: 13 }}>
                  <i className="fa-solid fa-file-pdf"></i> PDF
                </button>
              </div>
            </div>
          )}

          <div className="card">
            <h3 style={{ margin: "0 0 16px", fontSize: 15 }}>Inventario completo</h3>
            <div className="table-container">
              <table>
                <thead>
                  <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e9edf2" }}>
                    {columnsStock.map((c) => (<th key={c.key} style={{ padding: "10px 12px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "#64748b" }}>{c.header}</th>))}
                  </tr>
                </thead>
                <tbody>
                  {stockResult.list.map((p) => (
                    <tr key={p.id} className="table-row">
                      {columnsStock.map((c) => (<td key={c.key} className="td">{c.cell(p)}</td>))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button onClick={() => exportExcel(stockResult.list.map((p) => ({ ...p, activo: p.activo ? "Sí" : "No" })), [...columnsStock, { key: "activo", header: "Activo", cell: (r) => r.activo }], `stock-completo`)}
                className="btn-secondary" style={{ fontSize: 13 }}>
                <i className="fa-solid fa-file-excel"></i> Excel
              </button>
              <button onClick={() => exportPDF("Reporte de Stock", [...columnsStock, { key: "activo", header: "Activo", cell: (r) => (r.activo ? "Sí" : "No") }], stockResult.list.map((p) => ({ ...p, activo: p.activo ? "Sí" : "No" })), "reporte-de-stock", negocio)}
                className="btn-secondary" style={{ fontSize: 13 }}>
                <i className="fa-solid fa-file-pdf"></i> PDF
              </button>
            </div>
          </div>
        </>
      )}

      {/* Gastos tab */}
      {tab === "gastos" && gastosResult && (
        <>
          <div className="stats-grid" style={{ marginBottom: 20 }}>
            <div className="stat-card" style={{ borderTop: "3px solid #ef4444" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Total de gastos</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#dc2626" }}>{fmt(gastosResult.resumen?.totalGastos ?? 0)}</p>
            </div>
            <div className="stat-card" style={{ borderTop: "3px solid #94a3b8" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Cantidad de movimientos</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#475569" }}>{gastosResult.resumen?.cantidadMovimientos ?? 0}</p>
            </div>
          </div>

          <div className="card">
            <h3 style={{ margin: "0 0 16px", fontSize: 15 }}>Detalle de gastos (egresos manuales)</h3>
            {gastosResult.detalle?.length > 0 ? (
              <>
                <div className="table-container">
                  <table>
                    <thead>
                      <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e9edf2" }}>
                        {columnsGastos.map((c) => (<th key={c.key} style={{ padding: "10px 12px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "#64748b" }}>{c.header}</th>))}
                      </tr>
                    </thead>
                    <tbody>
                      {gastosResult.detalle.map((m, i) => (
                        <tr key={m.id} className="table-row">
                          {columnsGastos.map((c) => (<td key={c.key} className="td">{c.cell(m, i)}</td>))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                  <button onClick={() => exportExcel(gastosResult.detalle.map((m, i) => ({ "#": i + 1, Concepto: m.concepto, Monto: fmt(m.monto), Referencia: m.referencia || "-", Fecha: formatDateShort(m.fecha), Usuario: m.usuario?.nombre || "-" })), columnsGastosExport, `gastos-${dates.gastos.fechaInicio}-${dates.gastos.fechaFin}`)}
                    className="btn-secondary" style={{ fontSize: 13 }}>
                    <i className="fa-solid fa-file-excel"></i> Excel
                  </button>
                  <button onClick={() => exportPDF("Reporte de Gastos", columnsGastosExport, gastosResult.detalle, `gastos-${dates.gastos.fechaInicio}-${dates.gastos.fechaFin}`, negocio)}
                    className="btn-secondary" style={{ fontSize: 13 }}>
                    <i className="fa-solid fa-file-pdf"></i> PDF
                  </button>
                </div>
              </>
            ) : (
              <div style={{ textAlign: "center", padding: "32px", color: "#94a3b8" }}>No hay gastos registrados en el período</div>
            )}
          </div>
        </>
      )}

      {/* Compras tab */}
      {tab === "compras" && comprasResult && (
        <>
          <div className="stats-grid" style={{ marginBottom: 20 }}>
            <div className="stat-card" style={{ borderTop: "3px solid #3b82f6" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Total compras</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#2563eb" }}>{fmt(comprasResult.resumen?.totalCompras ?? 0)}</p>
            </div>
            <div className="stat-card" style={{ borderTop: "3px solid #94a3b8" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Cantidad de compras</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#475569" }}>{comprasResult.resumen?.cantidadCompras ?? 0}</p>
            </div>
            <div className="stat-card" style={{ borderTop: "3px solid #a855f7" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Promedio por compra</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#a855f7" }}>{fmt(comprasResult.resumen?.promedio ?? 0)}</p>
            </div>
          </div>

          <div className="card">
            <h3 style={{ margin: "0 0 16px", fontSize: 15 }}>Compras completadas</h3>
            {comprasResult.detalle?.length > 0 ? (
              <>
                <div className="table-container">
                  <table>
                    <thead>
                      <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e9edf2" }}>
                        {columnsCompras.map((c) => (<th key={c.key} style={{ padding: "10px 12px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "#64748b" }}>{c.header}</th>))}
                      </tr>
                    </thead>
                    <tbody>
                      {comprasResult.detalle.map((c) => (
                        <tr key={c.id} className="table-row">
                          {columnsCompras.map((col) => (<td key={col.key} className="td">{col.cell(c)}</td>))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                  <button onClick={() => exportExcel(comprasResult.detalle.map((c) => ({ Folio: c.folio || c.id, Fecha: formatDateShort(c.fecha), Total: fmt(c.total), Proveedor: c.proveedor?.nombre || "-", Estado: c.estado })), columnsCompras, `compras-${dates.compras.fechaInicio}-${dates.compras.fechaFin}`)}
                    className="btn-secondary" style={{ fontSize: 13 }}>
                    <i className="fa-solid fa-file-excel"></i> Excel
                  </button>
                  <button onClick={() => exportPDF("Reporte de Compras", columnsCompras, comprasResult.detalle, `compras-${dates.compras.fechaInicio}-${dates.compras.fechaFin}`, negocio)}
                    className="btn-secondary" style={{ fontSize: 13 }}>
                    <i className="fa-solid fa-file-pdf"></i> PDF
                  </button>
                </div>
              </>
            ) : (
              <div style={{ textAlign: "center", padding: "32px", color: "#94a3b8" }}>No hay compras completadas en el período</div>
            )}
          </div>
        </>
      )}

      {/* Deudores tab */}
      {tab === "deudores" && deudoresResult && (
        <>
          <div className="stats-grid" style={{ marginBottom: 20 }}>
            <div className="stat-card" style={{ borderTop: "3px solid #ef4444" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Total pendiente</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#dc2626" }}>{fmt(deudoresResult.resumen?.totalPendiente ?? 0)}</p>
            </div>
            <div className="stat-card" style={{ borderTop: "3px solid #94a3b8" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Cantidad de deudores</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#475569" }}>{deudoresResult.resumen?.cantidadDeudores ?? 0}</p>
            </div>
            <div className="stat-card" style={{ borderTop: "3px solid #22c55e" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Cobrado en el período</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#16a34a" }}>{fmt(deudoresResult.resumen?.cobradoPeriodo ?? 0)}</p>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 20 }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 15 }}>Clientes con saldo pendiente</h3>
            {deudoresResult.detalle?.length > 0 ? (
              <>
                <div className="table-container">
                  <table>
                    <thead>
                      <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e9edf2" }}>
                        {columnsDeudoresReporte.map((c) => (<th key={c.key} style={{ padding: "10px 12px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "#64748b" }}>{c.header}</th>))}
                      </tr>
                    </thead>
                    <tbody>
                      {deudoresResult.detalle.map((d, i) => (
                        <tr key={i} className="table-row">
                          {columnsDeudoresReporte.map((c) => (<td key={c.key} className="td">{c.cell(d)}</td>))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                  <button onClick={() => exportExcel(deudoresResult.detalle.map((d) => ({ Deudor: d.nombre, "Saldo pendiente": fmt(d.deudaPendiente) })), columnsDeudoresReporteExport, `deudores-${dates.deudores.fechaInicio}-${dates.deudores.fechaFin}`)}
                    className="btn-secondary" style={{ fontSize: 13 }}>
                    <i className="fa-solid fa-file-excel"></i> Excel
                  </button>
                  <button onClick={() => exportPDF("Reporte de Deudores", columnsDeudoresReporteExport, deudoresResult.detalle, `deudores-${dates.deudores.fechaInicio}-${dates.deudores.fechaFin}`, negocio)}
                    className="btn-secondary" style={{ fontSize: 13 }}>
                    <i className="fa-solid fa-file-pdf"></i> PDF
                  </button>
                </div>
              </>
            ) : (
              <div style={{ textAlign: "center", padding: "32px", color: "#94a3b8" }}>No hay deudores con saldo pendiente</div>
            )}
          </div>

          <div className="card">
            <h3 style={{ margin: "0 0 16px", fontSize: 15 }}>Cobros del período</h3>
            {deudoresResult.cobrosPeriodo?.length > 0 ? (
              <>
                <div className="table-container">
                  <table>
                    <thead>
                      <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e9edf2" }}>
                        {columnsCobros.map((c) => (<th key={c.key} style={{ padding: "10px 12px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "#64748b" }}>{c.header}</th>))}
                      </tr>
                    </thead>
                    <tbody>
                      {deudoresResult.cobrosPeriodo.map((p, i) => (
                        <tr key={i} className="table-row">
                          {columnsCobros.map((c) => (<td key={c.key} className="td">{c.cell(p)}</td>))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                  <button onClick={() => exportExcel(deudoresResult.cobrosPeriodo.map((p) => ({ Deudor: p.deudor, Monto: fmt(p.monto), Fecha: formatDateShort(p.fecha) })), columnsCobros, `deudores-cobros-${dates.deudores.fechaInicio}-${dates.deudores.fechaFin}`)}
                    className="btn-secondary" style={{ fontSize: 13 }}>
                    <i className="fa-solid fa-file-excel"></i> Excel
                  </button>
                  <button onClick={() => exportPDF("Reporte de Deudores — Cobros", columnsCobros, deudoresResult.cobrosPeriodo, `deudores-cobros-${dates.deudores.fechaInicio}-${dates.deudores.fechaFin}`, negocio)}
                    className="btn-secondary" style={{ fontSize: 13 }}>
                    <i className="fa-solid fa-file-pdf"></i> PDF
                  </button>
                </div>
              </>
            ) : (
              <div style={{ textAlign: "center", padding: "32px", color: "#94a3b8" }}>No hay cobros registrados en el período</div>
            )}
          </div>
        </>
      )}

      {/* Caja tab */}
      {tab === "caja" && !cajaActiva && (
        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "24px", color: "#854d0e", background: "#fef9c3", border: "1px solid #fde047", borderRadius: 12 }}>
            <i className="fa-solid fa-triangle-exclamation" style={{ fontSize: 18 }}></i>
            <span>Necesitás tener una caja abierta para ver este reporte. Andá al menú <strong>Caja</strong> y abrí una.</span>
          </div>
        </div>
      )}

      {tab === "caja" && cajaActiva && cajaResult && (
        <>
          <div className="stats-grid" style={{ marginBottom: 20 }}>
            <div className="stat-card" style={{ borderTop: "3px solid #22c55e" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Total ingresos</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#16a34a" }}>{fmt(cajaResult.resumen?.totalIngresos ?? 0)}</p>
            </div>
            <div className="stat-card" style={{ borderTop: "3px solid #ef4444" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Total egresos</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#dc2626" }}>{fmt(cajaResult.resumen?.totalEgresos ?? 0)}</p>
            </div>
            <div className="stat-card" style={{ borderTop: `3px solid ${(cajaResult.resumen?.saldoFinal ?? 0) >= 0 ? "#3b82f6" : "#ef4444"}` }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Saldo final</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: (cajaResult.resumen?.saldoFinal ?? 0) >= 0 ? "#2563eb" : "#dc2626" }}>{fmt(cajaResult.resumen?.saldoFinal ?? 0)}</p>
            </div>
            <div className="stat-card" style={{ borderTop: "3px solid #94a3b8" }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Caja Nº</p>
              <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#475569" }}>#{cajaActiva.id}</p>
            </div>
          </div>

          <div className="card">
            <h3 style={{ margin: "0 0 16px", fontSize: 15 }}>
              Movimientos de la caja abierta{" "}
              <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 400 }}>
                (apertura: {formatDateShort(cajaActiva.fechaApertura)})
              </span>
            </h3>
            {cajaResult.movimientos?.length > 0 ? (
              <>
                <div className="table-container">
                  <table>
                    <thead>
                      <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e9edf2" }}>
                        {columnsCaja.map((c) => (<th key={c.key} style={{ padding: "10px 12px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "#64748b" }}>{c.header}</th>))}
                      </tr>
                    </thead>
                    <tbody>
                      {cajaResult.movimientos.map((m) => (
                        <tr key={m.id} className="table-row">
                          {columnsCaja.map((c) => (<td key={c.key} className="td">{c.cell(m)}</td>))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                  <button onClick={() => exportExcel(cajaResult.movimientos.map((m) => ({ Tipo: m.tipo === "ingreso" ? "Ingreso" : "Egreso", Concepto: m.concepto, Monto: (m.tipo === "ingreso" ? "+" : "-") + parseFloat(m.monto ?? 0).toFixed(2), Fecha: formatDateShort(m.createdAt), Usuario: m.usuario?.nombre || "-" })), columnsCajaExport, `caja-${cajaActiva.id}`)}
                    className="btn-secondary" style={{ fontSize: 13 }}>
                    <i className="fa-solid fa-file-excel"></i> Excel
                  </button>
                  <button onClick={() => exportPDF("Reporte de Caja", columnsCajaExport, cajaResult.movimientos, `caja-${cajaActiva.id}`, negocio)}
                    className="btn-secondary" style={{ fontSize: 13 }}>
                    <i className="fa-solid fa-file-pdf"></i> PDF
                  </button>
                </div>
              </>
            ) : (
              <div style={{ textAlign: "center", padding: "32px", color: "#94a3b8" }}>La caja abierta no tiene movimientos</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
