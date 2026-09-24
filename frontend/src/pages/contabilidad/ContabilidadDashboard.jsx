import React, { useEffect, useState } from "react";
import { contabilidadAPI } from "../../api/contabilidad";
import { toast } from "react-toastify";
import { formatCurrency, formatDateShort } from "../../utils/formatters";

const tipoLabels = {
  prestamo_mp: "MercadoPago",
  prestamo_bancario: "Bancario",
  prestamo_personal: "Personal",
  proveedor: "Proveedor",
  otro: "Otro",
};

const tipoBadgeColors = {
  prestamo_mp: "#009ee3",
  prestamo_bancario: "#2563eb",
  prestamo_personal: "#7c3aed",
  proveedor: "#d97706",
  otro: "#64748b",
};

const ContabilidadDashboard = ({ onTabChange }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    contabilidadAPI
      .dashboard()
      .then((r) => setData(r.data.data))
      .catch(() => toast.error("Error al cargar resumen de contabilidad"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="card"><p>Cargando resumen...</p></div>;
  if (!data) return <div className="card"><p>No hay datos disponibles</p></div>;

  const { totalDeudasActivas, deudasPorTipo, proximoPago, balance } = data;
  const porcentajeActivos = balance.activos > 0
    ? ((balance.activos / (balance.activos + balance.pasivos + balance.capital)) * 100).toFixed(0)
    : 0;

  return (
    <div>
      {/* KPI Cards */}
      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <div className="stat-card" style={{ borderTop: "3px solid #ef4444" }}>
          <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Deudas activas</p>
          <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#dc2626" }}>
            {formatCurrency(totalDeudasActivas)}
          </p>
        </div>
        <div className="stat-card" style={{ borderTop: "3px solid #22c55e" }}>
          <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Resultado (Ingresos - Gastos)</p>
          <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: balance.resultado >= 0 ? "#16a34a" : "#dc2626" }}>
            {formatCurrency(balance.resultado)}
          </p>
        </div>
        <div className="stat-card" style={{ borderTop: "3px solid #3b82f6" }}>
          <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Activos</p>
          <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#2563eb" }}>
            {formatCurrency(balance.activos)}
          </p>
        </div>
        <div className="stat-card" style={{ borderTop: "3px solid #a855f7" }}>
          <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Capital</p>
          <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#a855f7" }}>
            {formatCurrency(balance.capital)}
          </p>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(400px, 1fr))", gap: 20 }}>
        {/* Balance General */}
        <div className="card">
          <h3 style={{ margin: "0 0 16px", fontSize: 15 }}>Balance General</h3>
          {[
            { label: "Activos", value: balance.activos, color: "#3b82f6" },
            { label: "Pasivos", value: balance.pasivos, color: "#ef4444" },
            { label: "Capital", value: balance.capital, color: "#a855f7" },
            { label: "Ingresos", value: balance.ingresos, color: "#22c55e" },
            { label: "Gastos", value: balance.gastos, color: "#f59e0b" },
          ].map((item) => (
            <div key={item.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #f1f5f9" }}>
              <span style={{ fontSize: 14, color: "#475569" }}>{item.label}</span>
              <span style={{ fontSize: 14, fontWeight: 600, color: item.color }}>{formatCurrency(item.value)}</span>
            </div>
          ))}
          <div style={{ marginTop: 16, textAlign: "center" }}>
            <button onClick={() => onTabChange("balance")} className="btn-secondary" style={{ fontSize: 13 }}>
              <i className="fa-solid fa-scale-balanced" style={{ marginRight: 6 }}></i>Ver Balance completo
            </button>
          </div>
        </div>

        {/* Deudas por tipo */}
        <div className="card">
          <h3 style={{ margin: "0 0 16px", fontSize: 15 }}>Deudas por tipo</h3>
          {Object.keys(deudasPorTipo).length === 0 ? (
            <p style={{ color: "#94a3b8", fontStyle: "italic" }}>No hay deudas activas</p>
          ) : (
            Object.entries(deudasPorTipo).map(([tipo, monto]) => {
              const pct = totalDeudasActivas > 0 ? (monto / totalDeudasActivas) * 100 : 0;
              return (
                <div key={tipo} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 13, color: "#475569" }}>{tipoLabels[tipo] || tipo}</span>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{formatCurrency(monto)}</span>
                  </div>
                  <div style={{ background: "#e2e8f0", borderRadius: 6, height: 8, overflow: "hidden" }}>
                    <div style={{ background: tipoBadgeColors[tipo] || "#64748b", height: "100%", width: `${pct}%`, borderRadius: 6, transition: "width 0.3s" }} />
                  </div>
                </div>
              );
            })
          )}
          <div style={{ marginTop: 16, textAlign: "center" }}>
            <button onClick={() => onTabChange("deudas")} className="btn-secondary" style={{ fontSize: 13 }}>
              <i className="fa-solid fa-hand-holding-dollar" style={{ marginRight: 6 }}></i>Gestionar deudas
            </button>
          </div>
        </div>
      </div>

      {/* Próximo pago */}
      {proximoPago && (
        <div className="card" style={{ marginTop: 20 }}>
          <h3 style={{ margin: "0 0 12px", fontSize: 15 }}>Próximo pago a vencer</h3>
          <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "12px 16px", background: "#fef9c3", borderRadius: 12 }}>
            <i className="fa-solid fa-clock" style={{ fontSize: 24, color: "#d97706" }}></i>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#854d0e" }}>{proximoPago.nombre}</div>
              <div style={{ fontSize: 13, color: "#92400e" }}>
                Cuota: {formatCurrency(proximoPago.montoCuota)} · Vence: {formatDateShort(proximoPago.fechaVencimiento)}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ContabilidadDashboard;
