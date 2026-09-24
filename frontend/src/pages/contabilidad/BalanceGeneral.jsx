import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { contabilidadAPI } from "../../api/contabilidad";
import { toast } from "react-toastify";
import { formatCurrency, formatDateShort } from "../../utils/formatters";

const tipoLabels = { activo: "Activos", pasivo: "Pasivos", capital: "Capital", ingreso: "Ingresos", gasto: "Gastos" };
const tipoColors = { activo: "#3b82f6", pasivo: "#ef4444", capital: "#a855f7", ingreso: "#22c55e", gasto: "#f59e0b" };

const today = () => new Date().toISOString().slice(0, 10);

const BalanceGeneral = () => {
  const [fechaCorte, setFechaCorte] = useState(today());

  const { data: balanceData, isLoading, refetch } = useQuery({
    queryKey: ["balanceGeneral", fechaCorte],
    queryFn: () => contabilidadAPI.balance({ fecha: fechaCorte }).then((r) => r.data.data),
    enabled: !!fechaCorte,
  });

  if (isLoading) return <div className="card"><p>Cargando balance...</p></div>;
  if (!balanceData) return <div className="card"><p>No hay datos de balance disponibles</p></div>;

  const activos = (balanceData.cuentas || []).filter((c) => c.tipo === "activo" && Math.abs(c.balance) > 0.01);
  const pasivos = (balanceData.cuentas || []).filter((c) => c.tipo === "pasivo" && Math.abs(c.balance) > 0.01);
  const capital = (balanceData.cuentas || []).filter((c) => c.tipo === "capital" && Math.abs(c.balance) > 0.01);
  const ingresos = (balanceData.cuentas || []).filter((c) => c.tipo === "ingreso" && Math.abs(c.balance) > 0.01);
  const gastos = (balanceData.cuentas || []).filter((c) => c.tipo === "gasto" && Math.abs(c.balance) > 0.01);

  const totalPasivosCapital = balanceData.pasivos + balanceData.capital + balanceData.resultado;
  const diff = Math.abs(balanceData.activos - totalPasivosCapital);

  const renderSection = (title, cuentas, total, color) => (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 15, color }}>{title}</h3>
        <span style={{ fontSize: 16, fontWeight: 700, color }}>{formatCurrency(total)}</span>
      </div>
      {cuentas.length === 0 ? (
        <p style={{ color: "#94a3b8", fontStyle: "italic", fontSize: 13 }}>Sin movimientos</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "6px 12px", fontSize: 12, color: "#64748b", borderBottom: "1px solid #e2e8f0" }}>Código</th>
              <th style={{ textAlign: "left", padding: "6px 12px", fontSize: 12, color: "#64748b", borderBottom: "1px solid #e2e8f0" }}>Nombre</th>
              <th style={{ textAlign: "right", padding: "6px 12px", fontSize: 12, color: "#64748b", borderBottom: "1px solid #e2e8f0" }}>Debe</th>
              <th style={{ textAlign: "right", padding: "6px 12px", fontSize: 12, color: "#64748b", borderBottom: "1px solid #e2e8f0" }}>Haber</th>
              <th style={{ textAlign: "right", padding: "6px 12px", fontSize: 12, color: "#64748b", borderBottom: "1px solid #e2e8f0" }}>Saldo</th>
            </tr>
          </thead>
          <tbody>
            {cuentas.map((c) => (
              <tr key={c.id}>
                <td style={{ padding: "8px 12px", fontSize: 13, fontWeight: 600 }}>{c.codigo}</td>
                <td style={{ padding: "8px 12px", fontSize: 13 }}>{c.nombre}</td>
                <td style={{ padding: "8px 12px", fontSize: 13, textAlign: "right" }}>{c.debe > 0 ? formatCurrency(c.debe) : "—"}</td>
                <td style={{ padding: "8px 12px", fontSize: 13, textAlign: "right" }}>{c.haber > 0 ? formatCurrency(c.haber) : "—"}</td>
                <td style={{ padding: "8px 12px", fontSize: 13, textAlign: "right", fontWeight: 600, color: c.balance >= 0 ? "#0f172a" : "#dc2626" }}>
                  {formatCurrency(c.balance)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  return (
    <div>
      {/* Date picker */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 12 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Fecha de corte</label>
            <input type="date" value={fechaCorte} onChange={(e) => setFechaCorte(e.target.value)} />
          </div>
          <button onClick={() => refetch()} className="btn-primary">
            <i className="fa-solid fa-scale-balanced" style={{ marginRight: 6 }}></i>Generar Balance
          </button>
        </div>
      </div>

      {/* Equation check */}
      <div style={{
        padding: "14px 20px",
        borderRadius: 12,
        marginBottom: 20,
        background: diff < 1 ? "#f0fdf4" : "#fef2f2",
        border: `1px solid ${diff < 1 ? "#bbf7d0" : "#fecaca"}`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <i className={`fa-solid ${diff < 1 ? "fa-check-circle" : "fa-exclamation-triangle"}`} style={{ fontSize: 20, color: diff < 1 ? "#16a34a" : "#dc2626" }}></i>
          <div>
            <p style={{ fontSize: 14, fontWeight: 600, margin: 0, color: diff < 1 ? "#166534" : "#991b1b" }}>
              Ecuación contable: Activos = Pasivos + Capital + Resultado
            </p>
            <p style={{ fontSize: 13, color: diff < 1 ? "#15803d" : "#b91c1c", margin: "4px 0 0" }}>
              {formatCurrency(balanceData.activos)} = {formatCurrency(balanceData.pasivos)} + {formatCurrency(balanceData.capital)} + {formatCurrency(balanceData.resultado)}
              {diff < 1 ? " ✓" : ` (diferencia: ${formatCurrency(diff)})`}
            </p>
          </div>
        </div>
      </div>

      {/* Three-column layout: Activos | Pasivos + Capital */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
        <div>
          {renderSection("Activos", activos, balanceData.activos, tipoColors.activo)}
        </div>
        <div>
          {renderSection("Pasivos", pasivos, balanceData.pasivos, tipoColors.pasivo)}
          {renderSection("Capital", capital, balanceData.capital, tipoColors.capital)}
        </div>
      </div>

      {/* Income + Expenses */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {renderSection("Ingresos", ingresos, balanceData.ingresos, tipoColors.ingreso)}
        {renderSection("Gastos", gastos, balanceData.gastos, tipoColors.gasto)}
      </div>

      {/* Result */}
      <div className="card" style={{ marginTop: 20, textAlign: "center" }}>
        <p style={{ fontSize: 14, color: "#64748b", margin: "0 0 4px" }}>Resultado del período</p>
        <p style={{ fontSize: 28, fontWeight: 700, color: balanceData.resultado >= 0 ? "#16a34a" : "#dc2626", margin: 0 }}>
          {formatCurrency(balanceData.resultado)}
        </p>
        <p style={{ fontSize: 13, color: "#94a3b8", margin: "4px 0 0" }}>
          {balanceData.resultado >= 0 ? "Ganancia" : "Pérdida"} = Ingresos ({formatCurrency(balanceData.ingresos)}) - Gastos ({formatCurrency(balanceData.gastos)})
        </p>
      </div>
    </div>
  );
};

export default BalanceGeneral;
