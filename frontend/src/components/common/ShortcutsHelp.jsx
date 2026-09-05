import React from "react";

const categories = [
  {
    title: "Navegación",
    icon: "fa-solid fa-arrows-up-down-left-right",
    shortcuts: [
      { keys: ["/", "Ctrl+F"], action: "Buscar producto" },
      { keys: ["↑"], action: "Seleccionar item anterior en carrito" },
      { keys: ["↓"], action: "Seleccionar item siguiente en carrito" },
      { keys: ["Esc"], action: "Cerrar modal / limpiar búsqueda" },
    ],
  },
  {
    title: "Carrito",
    icon: "fa-solid fa-cart-shopping",
    shortcuts: [
      { keys: ["+"], action: "Sumar 1 al item seleccionado" },
      { keys: ["-"], action: "Restar 1 al item seleccionado" },
      { keys: ["←"], action: "Restar 1 (atajo alternativo)" },
      { keys: ["→"], action: "Sumar 1 (atajo alternativo)" },
      { keys: ["Supr"], action: "Eliminar item seleccionado" },
    ],
  },
  {
    title: "Venta",
    icon: "fa-solid fa-cash-register",
    shortcuts: [
      { keys: ["Enter"], action: "Confirmar venta" },
      { keys: ["F2"], action: "Venta rápida — Efectivo" },
      { keys: ["F3"], action: "Venta rápida — Tarjeta" },
    ],
  },
  {
    title: "General",
    icon: "fa-solid fa-keyboard",
    shortcuts: [
      { keys: ["F1"], action: "Ayuda de atajos de teclado" },
      { keys: ["?"], action: "Ayuda de atajos de teclado" },
    ],
  },
];

export default function ShortcutsHelp({ onClose }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        backdropFilter: "blur(4px)",
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 560,
          maxHeight: "90vh",
          background: "var(--kanagawa-bg)",
          borderRadius: 16,
          border: "1px solid var(--kanagawa-border)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "20px 24px",
            borderBottom: "1px solid var(--kanagawa-border)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <i
              className="fa-solid fa-keyboard"
              style={{ fontSize: 20, color: "var(--kanagawa-blue)" }}
            ></i>
            <div>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "var(--kanagawa-fg)" }}>
                Atajos de Teclado
              </h2>
              <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--kanagawa-fg-muted)" }}>
                Punto de Venta — uso con teclado
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="btn-secondary"
            style={{ padding: "6px 12px", fontSize: 14 }}
          >
            <i className="fa-solid fa-times"></i>
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "20px 24px", overflowY: "auto", flex: 1 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {categories.map((cat, ci) => (
              <div
                key={ci}
                style={{
                  background: "var(--kanagawa-bg-alt)",
                  borderRadius: 12,
                  padding: "16px",
                  border: "1px solid var(--kanagawa-border)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <i
                    className={cat.icon}
                    style={{ color: "var(--kanagawa-blue)", fontSize: 15 }}
                  ></i>
                  <span style={{ fontWeight: 700, fontSize: 14, color: "var(--kanagawa-fg)" }}>
                    {cat.title}
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {cat.shortcuts.map((s, si) => (
                    <div
                      key={si}
                      style={{ display: "flex", alignItems: "center", gap: 10 }}
                    >
                      <div style={{ display: "flex", gap: 4, minWidth: 60 }}>
                        {s.keys.map((k, ki) => (
                          <kbd
                            key={ki}
                            style={{
                              background: "var(--kanagawa-bg)",
                              border: "1px solid var(--kanagawa-border)",
                              borderRadius: 5,
                              padding: "3px 8px",
                              fontSize: 12,
                              fontFamily: "monospace",
                              fontWeight: 600,
                              color: "var(--kanagawa-fg)",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {k}
                          </kbd>
                        ))}
                      </div>
                      <span style={{ fontSize: 13, color: "var(--kanagawa-fg-muted)" }}>
                        {s.action}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Nota mobile */}
          <div
            style={{
              marginTop: 16,
              background: "var(--kanagawa-bg-alt)",
              border: "1px solid var(--kanagawa-border)",
              borderRadius: 10,
              padding: "10px 14px",
              fontSize: 12,
              color: "var(--kanagawa-fg-muted)",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <i className="fa-solid fa-mobile-screen" style={{ fontSize: 14 }}></i>
            Los atajos de teclado no están disponibles en dispositivos táctiles.
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "14px 24px",
            borderTop: "1px solid var(--kanagawa-border)",
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <button onClick={onClose} className="btn-primary" style={{ fontSize: 13 }}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
