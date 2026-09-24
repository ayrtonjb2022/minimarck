import React, { useState } from "react";
import ContabilidadDashboard from "./contabilidad/ContabilidadDashboard";
import CuentasContables from "./contabilidad/CuentasContables";
import AsientosContables from "./contabilidad/AsientosContables";
import DeudasContabilidad from "./contabilidad/DeudasContabilidad";
import BalanceGeneral from "./contabilidad/BalanceGeneral";

const tabs = [
  { key: "dashboard", label: "Resumen", icon: "fa-solid fa-chart-pie" },
  { key: "cuentas", label: "Cuentas", icon: "fa-solid fa-book" },
  { key: "asientos", label: "Asientos", icon: "fa-solid fa-file-invoice" },
  { key: "deudas", label: "Deudas", icon: "fa-solid fa-hand-holding-dollar" },
  { key: "balance", label: "Balance", icon: "fa-solid fa-scale-balanced" },
];

const Contabilidad = () => {
  const [tab, setTab] = useState("dashboard");

  const renderTab = () => {
    switch (tab) {
      case "dashboard": return <ContabilidadDashboard onTabChange={setTab} />;
      case "cuentas": return <CuentasContables />;
      case "asientos": return <AsientosContables />;
      case "deudas": return <DeudasContabilidad />;
      case "balance": return <BalanceGeneral />;
      default: return null;
    }
  };

  return (
    <div>
      {/* Tab bar */}
      <div style={{ marginBottom: 20, borderBottom: "1px solid #e2e8f0" }}>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
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
      </div>

      {renderTab()}
    </div>
  );
};

export default Contabilidad;
