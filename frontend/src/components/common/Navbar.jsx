import React, { useState, useRef, useEffect } from "react";
import { useAuth } from "../../context/AuthContext";
import { useNotificaciones } from "../../context/NotificacionContext";
import HelpModal from "./HelpModal";

const PAGE_TITLES = {
  dashboard: "Dashboard", pos: "Punto de Venta", productos: "Productos",
  categorias: "Categorías", ventas: "Ventas", caja: "Caja",
  clientes: "Clientes / Deudores", proveedores: "Proveedores",
  compras: "Compras", reportes: "Reportes",

  configuracion: "Configuración",
};

const ICONOS = {
  stock_bajo: <i className="fa-solid fa-boxes-stacked" style={{ color: "#f59e0b" }}></i>,
  caja_baja: <i className="fa-solid fa-triangle-exclamation" style={{ color: "#ef4444" }}></i>,
  caja_alta: <i className="fa-solid fa-circle-exclamation" style={{ color: "#7e9cd8" }}></i>,
};

const Navbar = ({ currentPage, onToggleSidebar, onNavigate }) => {
  const { user, logout } = useAuth();
  const { notificaciones, count, refresh } = useNotificaciones();
  const [open, setOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const ref = useRef(null);
  const title = PAGE_TITLES[currentPage] || "Dashboard";

  useEffect(() => {
    const handleClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div className="topbar">
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      <div className="topbar-left">
        <h1>{title}</h1>
        <div className="breadcrumb">Inicio / <span>{title}</span></div>
      </div>
      <div className="topbar-right">
        <span className="badge-store"><i className="fa-solid fa-circle"></i> Tienda Principal</span>
        <div ref={ref} style={{ position: "relative" }}>
          <button className="btn-header" title="Notificaciones" onClick={() => { setOpen(!open); if (!open) refresh(); }}>
            <i className="fa-regular fa-bell"></i>
            {count > 0 && <span className="notif-badge">{count > 9 ? "9+" : count}</span>}
          </button>
          {open && (
            <div style={{ position: "absolute", top: "calc(100% + 8px)", right: 0, width: 360, maxWidth: "calc(100vw - 32px)", background: "var(--kanagawa-bg)", borderRadius: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.4)", border: "1px solid var(--kanagawa-border)", zIndex: 100, maxHeight: 400, overflowY: "auto" }}>
              <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--kanagawa-border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 600, fontSize: 14, color: "var(--kanagawa-fg)" }}>Notificaciones</span>
                <button onClick={refresh} className="btn-secondary" style={{ padding: "4px 8px", fontSize: 12 }}><i className="fa-solid fa-rotate"></i></button>
              </div>
              {notificaciones.length === 0 ? (
                <div style={{ padding: "32px 18px", textAlign: "center", color: "var(--kanagawa-comment)", fontSize: 13 }}>
                  <i className="fa-regular fa-bell-slash" style={{ fontSize: 24, marginBottom: 8, display: "block" }}></i>
                  No hay notificaciones
                </div>
              ) : notificaciones.map((n, i) => {
                const destino = n.tipo === "stock_bajo" ? "compras" : "caja";
                const estado = n.data ? { stockBajo: n.data } : undefined;
                return (
                  <div key={i} onClick={() => { onNavigate(destino, estado); setOpen(false); }}
                    style={{ padding: "14px 18px", borderBottom: "1px solid var(--kanagawa-border)", display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer", transition: "background 0.15s" }}
                    onMouseEnter={(e) => e.currentTarget.style.background = "var(--kanagawa-bg-alt)"}
                    onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                    <div style={{ marginTop: 2, flexShrink: 0, fontSize: 16 }}>{ICONOS[n.tipo] || <i className="fa-solid fa-circle-info" style={{ color: "var(--kanagawa-blue)" }}></i>}</div>
                    <div style={{ fontSize: 13, color: "var(--kanagawa-fg)", lineHeight: 1.4 }}>{n.mensaje}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <button className="btn-header" title="Ayuda" onClick={() => setHelpOpen(true)}><i className="fa-regular fa-circle-question"></i></button>
        <div className="avatar-main" title={user?.nombre} onClick={() => onNavigate("perfil")}>
          {(user?.nombre || "U")[0]}
        </div>
        <i className="fa-solid fa-right-from-bracket" style={{ cursor: "pointer", color: "#475569", fontSize: 20 }} onClick={logout} title="Cerrar sesión"></i>
      </div>
    </div>
  );
};

export default Navbar;
