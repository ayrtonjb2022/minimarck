import React from "react";

const secciones = [
  {
    icon: "fa-solid fa-store",
    titulo: "Dashboard",
    desc: "Vista principal con resumen de ventas, ingresos, productos con bajo stock y top productos del mes.",
  },
  {
    icon: "fa-solid fa-cash-register",
    titulo: "Punto de Venta (POS)",
    desc: "Registrá ventas rápidas. Seleccioná productos, definí cantidad y procesá el cobro. Las ventas se descuentan automáticamente del stock.",
    atajos: "Ctrl+2",
  },
  {
    icon: "fa-solid fa-box",
    titulo: "Productos",
    desc: "Gestioná tu catálogo: alta, edición y baja de productos. Cada producto tiene nombre, código, precio de venta y compra, stock y stock mínimo para alertas. El plan Básico permite hasta 500 productos.",
    atajos: "Ctrl+3",
  },
  {
    icon: "fa-solid fa-tags",
    titulo: "Categorías",
    desc: "Organizá productos por categorías para filtrar y ordenar mejor tu catálogo.",
  },
  {
    icon: "fa-solid fa-truck",
    titulo: "Proveedores",
    desc: "Registrá tus proveedores con datos de contacto. Al hacer una compra, seleccionás el proveedor.",
  },
  {
    icon: "fa-solid fa-cart-shopping",
    titulo: "Compras",
    desc: "Registrá las compras a proveedores. Cada compra incrementa el stock de los productos automáticamente.",
    atajos: "Ctrl+7",
  },
  {
    icon: "fa-solid fa-receipt",
    titulo: "Ventas",
    desc: "Historial completo de todas las ventas realizadas. Podés ver detalle, estado y método de pago de cada una.",
    atajos: "Ctrl+4",
  },
  {
    icon: "fa-solid fa-wallet",
    titulo: "Caja",
    desc: "Abrí y cerrá la caja diaria. Registrá ingresos y egresos manuales. El saldo general muestra la suma de todas las cajas cerradas más la actual.",
    atajos: "Ctrl+5",
  },
  {
    icon: "fa-solid fa-arrow-right-arrow-left",
    titulo: "Movimientos",
    desc: "Historial detallado de todos los movimientos de caja con saldos anterior y nuevo.",
  },
  {
    icon: "fa-solid fa-users",
    titulo: "Clientes / Deudores",
    desc: "Gestioná clientes con cuenta corriente. Registrá deudas, pagos parciales y seguimiento de saldos pendientes.",
    atajos: "Ctrl+6",
  },
  {
    icon: "fa-solid fa-chart-bar",
    titulo: "Reportes",
    desc: "Tres pestañas de análisis: General (ingresos vs gastos con gráfico de barras), Ventas (detalle con exportación), Productos (top más vendidos).",
    atajos: "Ctrl+8",
  },
  {
    icon: "fa-solid fa-bell",
    titulo: "Notificaciones",
    desc: "La campana en la barra superior muestra alertas de productos con stock bajo y saldo de caja fuera de los rangos configurados (Configuración > Alertas). Se actualiza automáticamente cada 60 segundos.",
  },
];

const atajos = [
  { tecla: "Ctrl+1", pagina: "Dashboard" },
  { tecla: "Ctrl+2", pagina: "Punto de Venta" },
  { tecla: "Ctrl+3", pagina: "Productos" },
  { tecla: "Ctrl+4", pagina: "Ventas" },
  { tecla: "Ctrl+5", pagina: "Caja" },
  { tecla: "Ctrl+6", pagina: "Clientes" },
  { tecla: "Ctrl+7", pagina: "Compras" },
  { tecla: "Ctrl+8", pagina: "Reportes" },
  { tecla: "Ctrl+9", pagina: "Configuración" },
];

export default function HelpModal({ onClose }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ width: "100%", maxWidth: 720, maxHeight: "90vh", background: "var(--kanagawa-bg)", borderRadius: 16, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "20px 24px", borderBottom: "1px solid var(--kanagawa-border)" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "var(--kanagawa-fg)" }}>Ayuda</h2>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--kanagawa-fg-muted)" }}>Cómo usar MiniMarck</p>
          </div>
          <button onClick={onClose} className="btn-secondary" style={{ padding: "6px 12px", fontSize: 14 }}><i className="fa-solid fa-times"></i></button>
        </div>

        <div style={{ padding: "16px 24px", overflowY: "auto", flex: 1 }}>
          {/* Secciones */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {secciones.map((s, i) => (
              <div key={i} style={{ background: "var(--kanagawa-bg-alt)", borderRadius: 12, padding: "14px 16px", border: "1px solid var(--kanagawa-border)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <i className={s.icon} style={{ color: "var(--kanagawa-blue)", fontSize: 16, width: 20 }}></i>
                  <span style={{ fontWeight: 600, fontSize: 14, color: "var(--kanagawa-fg)" }}>{s.titulo}</span>
                  {s.atajos && <span style={{ marginLeft: "auto", fontSize: 10, background: "var(--kanagawa-surface0)", padding: "2px 6px", borderRadius: 4, color: "var(--kanagawa-subtext0)", fontFamily: "monospace" }}>{s.atajos}</span>}
                </div>
                <p style={{ fontSize: 12, color: "var(--kanagawa-fg-muted)", lineHeight: 1.5, margin: 0 }}>{s.desc}</p>
              </div>
            ))}
          </div>

          {/* Atajos de teclado */}
          <div style={{ marginTop: 20, padding: "16px 20px", background: "var(--ctp-surface0)", borderRadius: 12, border: "1px solid var(--ctp-overlay0)" }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 10px", color: "var(--ctp-blue)" }}>
              <i className="fa-solid fa-keyboard" style={{ marginRight: 8 }}></i>Atajos de teclado
            </h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 6 }}>
              {atajos.map((a, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <kbd style={{ background: "var(--kanagawa-bg)", border: "1px solid var(--kanagawa-border)", borderRadius: 4, padding: "2px 8px", fontSize: 11, fontFamily: "monospace", fontWeight: 600, color: "var(--kanagawa-fg)" }}>{a.tecla}</kbd>
                  <span style={{ color: "var(--kanagawa-fg-muted)" }}>{a.pagina}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ padding: "14px 24px", borderTop: "1px solid var(--kanagawa-border)", display: "flex", justifyContent: "flex-end" }}>
          <button onClick={onClose} className="btn-primary" style={{ fontSize: 13 }}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}
