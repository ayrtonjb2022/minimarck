import React from "react";
import { useAuth } from "../../context/AuthContext";
import { useCaja } from "../../context/CajaContext";

const ICONS = {
  dashboard: "fa-solid fa-chart-pie",
  pos: "fa-solid fa-cash-register",
  productos: "fa-solid fa-boxes",
  categorias: "fa-solid fa-tags",
  ventas: "fa-solid fa-shopping-cart",
  caja: "fa-solid fa-wallet",
  clientes: "fa-solid fa-users",
  usuarios: "fa-solid fa-id-badge",

  proveedores: "fa-solid fa-truck",
  compras: "fa-solid fa-file-invoice",
  contabilidad: "fa-solid fa-calculator",
  reportes: "fa-solid fa-chart-line",
  configuracion: "fa-solid fa-cog",
};

const Sidebar = ({ isOpen, onClose, currentPage, onNavigate, collapsed, onToggleCollapse }) => {
  const { user, logout, puedeAdministrarUsuarios } = useAuth();
  const { cajaActiva } = useCaja();

  const menuItems = [
    { section: "MENÚ PRINCIPAL" },
    { page: "dashboard", label: "Dashboard" },
    { page: "pos", label: "Punto de Venta", badge: cajaActiva ? "success" : null, badgeText: cajaActiva ? "Caja abierta" : null },
    { page: "productos", label: "Productos" },
    { page: "categorias", label: "Categorías" },
    { page: "ventas", label: "Ventas" },
    { page: "caja", label: "Caja" },
    { section: "GESTIÓN" },
    { page: "clientes", label: "Clientes / Deudores" },
    { page: "proveedores", label: "Proveedores" },
    { page: "compras", label: "Compras" },
    // The employees module is reachable from the MENU, not only by typing `/usuarios`. A screen
    // that exists but that nobody can click is a screen that does not exist for the person who
    // has to hire somebody tomorrow. Hidden for a `vendedor` because the route refuses them too:
    // showing a link that answers "you may not" teaches the shop that the menu lies.
    ...(puedeAdministrarUsuarios ? [{ page: "usuarios", label: "Usuarios" }] : []),
    { section: "FINANZAS" },
    { page: "contabilidad", label: "Contabilidad" },
    { section: "REPORTES" },
    { page: "reportes", label: "Reportes" },
    { page: "configuracion", label: "Configuración" },
  ];

  return (
    <>
      {isOpen && <div className="sidebar-overlay active" onClick={onClose} />}
      <aside className={`sidebar ${isOpen ? "open" : ""} ${collapsed ? "collapsed" : ""}`}>
        <div className="sidebar-brand">
          <i className="fa-solid fa-store"></i>
          <span>MiniMarck2</span>
        </div>

        <ul className="sidebar-menu">
          {menuItems.map((item, idx) => {
            if (item.section) {
              return <li key={idx} className="sub-label">{item.section}</li>;
            }
            const isActive = currentPage === item.page;
            return (
              <li key={item.page}
                className={isActive ? "active" : ""}
                onClick={() => onNavigate(item.page)}
              >
                <i className={ICONS[item.page]}></i>
                <span>{item.label}</span>
                {item.badge && item.badgeText && <span className={`badge-count ${item.badge}`}>{item.badgeText}</span>}
              </li>
            );
          })}
        </ul>

        <div className="sidebar-collapse-btn" onClick={onToggleCollapse} title={collapsed ? "Expandir menú" : "Colapsar menú"}>
          <i className={`fa-solid fa-chevron-${collapsed ? "right" : "left"}`}></i>
        </div>
        <div className="sidebar-footer">
          <div className="avatar-mini">{(user?.nombre || "U")[0]}</div>
          <div className="user-info">
            <div className="name">{user?.nombre || "Usuario"}</div>
            {/* The sign-in HANDLE, not `users.email`. For the adopted legacy owner the email is
                `admin@minimarck.local` and the handle is something else entirely; showing the
                email here would print a name the owner cannot type to sign in. */}
            <div className="email">{user?.nombreAcceso || ""}</div>
          </div>
          <i className="fa-solid fa-right-from-bracket" style={{ cursor: "pointer", color: "#64748b", fontSize: 16 }} onClick={logout}></i>
        </div>
      </aside>
    </>
  );
};

export default Sidebar;
