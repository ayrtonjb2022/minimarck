import React from "react";
import { Routes, Route, Navigate, useLocation, NavLink } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import { useTheme } from "./context/ThemeContext";
import CajaGuard from "./components/common/CajaGuard";
import PuntoDeVenta from "./pages/puntoDeVenta";
import Ventas from "./pages/Ventas";

/**
 * The route tree, cut down to what this build can actually do.
 *
 * The web app's App.jsx imported fifteen pages: Landing, Login, Register, Dashboard,
 * Productos, Categorias, Caja, Deudores, Proveedores, Compras, Reportes, Configuracion,
 * Contabilidad, NotFound, ScannerSync. One by one those are not "not finished yet" — most
 * of them cannot work here at all. Login and Register need a server that does not exist.
 * ScannerSync is the phone-side half of the socket.io/QR flow, and the socket is gone
 * because there is no network. Proveedores, Compras, Reportes and Contabilidad depend on
 * IPC operations that the frozen 88-op contract does not contain, and the contract is
 * frozen on purpose.
 *
 * Importing them anyway would have produced a bundle that fails to resolve at startup, so
 * the operator would get a white screen on a build whose tests all pass. Instead the app
 * mounts two real routes, and everything else lands on a page that says plainly what is
 * and is not there. A missing screen the operator can read is better than a stack trace
 * they cannot.
 */

const PANTALLAS_FALTANTES = [
  { ruta: "/dashboard", nombre: "Panel", motivo: "sin resumen agregado en esta build" },
  { ruta: "/productos", nombre: "Productos", motivo: "el catalogo se carga, la edicion todavia no" },
  { ruta: "/categorias", nombre: "Categorías", motivo: "el filtro del POS ya las usa" },
  { ruta: "/caja", nombre: "Caja", motivo: "se abre al vender, el arqueo manual no" },
  { ruta: "/clientes", nombre: "Clientes", motivo: "los deudores se eligen al cobrar" },
  { ruta: "/proveedores", nombre: "Proveedores", motivo: "no esta en el contrato de 88 operaciones" },
  { ruta: "/compras", nombre: "Compras", motivo: "no esta en el contrato de 88 operaciones" },
  { ruta: "/reportes", nombre: "Reportes", motivo: "no esta en el contrato de 88 operaciones" },
  { ruta: "/contabilidad", nombre: "Contabilidad", motivo: "no esta en el contrato de 88 operaciones" },
  { ruta: "/configuracion", nombre: "Configuracion", motivo: "no esta en el contrato de 88 operaciones" },
];

/**
 * The top strip. Not the web's Navbar: that one carried a shop switcher, a notification bell
 * polling an op that answers 501, and a logout button for a session that does not exist.
 * This says who is on the till and gets out of the way.
 */
const TopBar = ({ titulo }) => {
  const { user, negocio } = useAuth();
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="mm-topbar">
      <div className="mm-topbar-brand">
        <i className="fa-solid fa-cash-register" aria-hidden="true"></i>
        <strong>MiniMarck</strong>
        {negocio?.nombre ? <span className="mm-topbar-shop">{negocio.nombre}</span> : null}
      </div>

      <div className="mm-topbar-title">{titulo}</div>

      <nav className="mm-topbar-nav" aria-label="Secciones">
        <NavLink to="/pos" className={({ isActive }) => (isActive ? "active" : "")}>
          <i className="fa-solid fa-cash-register" aria-hidden="true"></i> Vender
        </NavLink>
        <NavLink to="/ventas" className={({ isActive }) => (isActive ? "active" : "")}>
          <i className="fa-solid fa-receipt" aria-hidden="true"></i> Ventas
        </NavLink>
      </nav>

      <div className="mm-topbar-right">
        {user?.nombre ? (
          <span className="mm-topbar-user" title={`Rol: ${user.rol}`}>
            {user.nombre}
          </span>
        ) : null}
        <button
          type="button"
          className="theme-toggle"
          onClick={toggleTheme}
          title={theme === "light" ? "Modo oscuro" : "Modo claro"}
          aria-label={theme === "light" ? "Cambiar a modo oscuro" : "Cambiar a modo claro"}
        >
          <i className={`fa-solid ${theme === "light" ? "fa-moon" : "fa-sun"}`} aria-hidden="true"></i>
        </button>
      </div>
    </header>
  );
};

/** The screen for a route this build does not have, instead of a 404 from nowhere. */
const NoDisponible = () => {
  const location = useLocation();

  return (
    <div className="app-layout">
      <main className="main">
        <TopBar titulo="No disponible" />
        <div className="card" style={{ maxWidth: 720 }}>
          <div className="card-header">
            <h3>
              <i className="fa-solid fa-triangle-exclamation" style={{ color: "var(--kanagawa-orange)", marginRight: 8 }} aria-hidden="true"></i>
              Esta pantalla todavia no existe en la version de escritorio
            </h3>
          </div>
          <p style={{ color: "var(--kanagawa-fg-muted)", fontSize: 14, marginBottom: 16 }}>
            Pediste <code>{location.pathname}</code>. La app de escritorio hoy vende y muestra el
            historial; el resto de las secciones todavia no.
          </p>
          <ul className="mm-missing-list">
            {PANTALLAS_FALTANTES.map((p) => (
              <li key={p.ruta}>
                <code>{p.ruta}</code>
                <strong>{p.nombre}</strong>
                <span>{p.motivo}</span>
              </li>
            ))}
          </ul>
          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <NavLink to="/pos" className="btn-primary">
              <i className="fa-solid fa-cash-register" aria-hidden="true"></i> Ir a vender
            </NavLink>
            <NavLink to="/ventas" className="btn-secondary">
              <i className="fa-solid fa-receipt" aria-hidden="true"></i> Ver ventas
            </NavLink>
          </div>
        </div>
      </main>
    </div>
  );
};

/**
 * The desktop has no login, so there is no ProtectedRoute and no gate: whoever opens the
 * file IS the operator on duty. What IS gated is the till — a sale with no open caja
 * records no movement, so CajaGuard stands in front of the POS instead.
 */
const App = () => {
  return (
    <Routes>
      {/* A till app opens on the till, not on a menu. */}
      <Route path="/" element={<Navigate to="/pos" replace />} />
      <Route
        path="/pos"
        element={
          <CajaGuard>
            <PuntoDeVenta />
          </CajaGuard>
        }
      />
      <Route
        path="/ventas"
        element={
          <div className="app-layout">
            <main className="main">
              <TopBar titulo="Ventas" />
              <Ventas />
            </main>
          </div>
        }
      />
      <Route path="*" element={<NoDisponible />} />
    </Routes>
  );
};

export default App;
