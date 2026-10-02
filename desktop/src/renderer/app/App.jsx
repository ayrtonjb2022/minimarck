import React from "react";
import { Routes, Route, Navigate, useLocation, NavLink } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import { useTheme } from "./context/ThemeContext";
import CajaGuard from "./components/common/CajaGuard";
import PuntoDeVenta from "./pages/puntoDeVenta";
import Ventas from "./pages/Ventas";
import Deudores from "./pages/Deudores";
import Proveedores from "./pages/Proveedores";
import Compras from "./pages/Compras";
import Acceso from "./pages/Acceso";
import Usuarios from "./pages/Usuarios";
import Reportes from "./pages/Reportes";
import Panel from "./pages/Panel";
import ControlesDeTurno from "./components/common/ControlesDeTurno";

/**
 * The route tree, cut down to what this build can actually do.
 *
 * The web app's App.jsx imported fifteen pages: Landing, Login, Register, Dashboard,
 * Productos, Categorias, Caja, Deudores, Proveedores, Compras, Reportes, Configuracion,
 * Contabilidad, NotFound, ScannerSync. One by one those are not "not finished yet" — most
 * of them cannot work here at all. Login and Register need a server that does not exist.
 * ScannerSync is the phone-side half of the socket.io/QR flow, and the socket is gone
 * because there is no network. Reportes, Contabilidad and Configuracion depend on IPC
 * operations that the frozen 89-op contract does not contain, and the contract is frozen
 * on purpose.
 *
 * Importing them anyway would have produced a bundle that fails to resolve at startup, so
 * the operator would get a white screen on a build whose tests all pass. Instead the app
 * mounts five real routes, and everything else lands on a page that says plainly what is
 * and is not there. A missing screen the operator can read is better than a stack trace
 * they cannot.
 *
 * `Deudores` joined `PuntoDeVenta` and `Ventas` because a credit sale needs two ends: a name to
 * bill at the till, and a place to collect the money afterwards. The POS could name a debtor
 * (`ventas.create` refuses a `credito` sale with no `clienteDeudorId`) but had nowhere to record
 * a payment, so a customer on credit could be created and never closed.
 *
 * `Proveedores` and `Compras` joined next, and the comment above used to say they were not here
 * "because the frozen 89-op contract does not contain them". It DOES contain them: five supplier
 * operations and five purchase operations, `proveedores.*` and `compras.*`, sitting in
 * `ipc-contract.js` among the 89 the whole time. This list claimed the contract was missing them
 * while `scripts/check-contract.mjs` counted all ten as unimplemented 501s — the contract and this
 * screen agreed with each other and both were wrong, which is worse than either being wrong alone.
 * The stock already moved without them: a sale can push stock down and nothing could push it back
 * up, and the average cost a sale was measured against could only be changed by hand.
 */

const PANTALLAS_FALTANTES = [
  { ruta: "/productos", nombre: "Productos", motivo: "el catalogo se carga, la edicion todavia no" },
  { ruta: "/categorias", nombre: "Categorías", motivo: "el filtro del POS ya las usa" },
  { ruta: "/caja", nombre: "Caja", motivo: "se abre al vender, el arqueo manual no" },
  { ruta: "/contabilidad", nombre: "Contabilidad", motivo: "son 15 operaciones del contrato y ninguna esta" },
  { ruta: "/configuracion", nombre: "Configuracion", motivo: "no esta en el contrato de 89 operaciones" },
];

/**
 * The top strip. Not the web's Navbar: that one carried a shop switcher, a notification bell
 * polling an op that answers 501, and a logout button for a session that does not exist.
 * This says who is on the till and gets out of the way.
 *
 * The handover control used to hang off the web `Navbar`, which this route tree never
 * renders — the feature was complete and unreachable, and no unit test could have said so.
 * It is mounted here, and on the point of sale, through `ControlesDeTurno`: one place, both
 * mount points, so there is a single definition to keep honest.
 */
const TopBar = ({ titulo }) => {
  const { user, negocio, logout } = useAuth();
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
        {/* The panel and the reports are the two screens that ANSWER questions rather than record
            something, so they sit next to Vender rather than at the end of the strip: an operator
            opening the app on a Monday morning wants the numbers first. */}
        <NavLink to="/dashboard" className={({ isActive }) => (isActive ? "active" : "")}>
          <i className="fa-solid fa-gauge-high" aria-hidden="true"></i> Panel
        </NavLink>
        <NavLink to="/reportes/ventas" className={({ isActive }) => (isActive ? "active" : "")}>
          <i className="fa-solid fa-chart-column" aria-hidden="true"></i> Reportes
        </NavLink>
        <NavLink to="/ventas" className={({ isActive }) => (isActive ? "active" : "")}>
          <i className="fa-solid fa-receipt" aria-hidden="true"></i> Ventas
        </NavLink>
        <NavLink to="/deudores" className={({ isActive }) => (isActive ? "active" : "")}>
          <i className="fa-solid fa-hand-holding-dollar" aria-hidden="true"></i> Deudores
        </NavLink>
        <NavLink to="/proveedores" className={({ isActive }) => (isActive ? "active" : "")}>
          <i className="fa-solid fa-truck-field" aria-hidden="true"></i> Proveedores
        </NavLink>
        <NavLink to="/compras" className={({ isActive }) => (isActive ? "active" : "")}>
          <i className="fa-solid fa-cart-plus" aria-hidden="true"></i> Compras
        </NavLink>
      </nav>

      <div className="mm-topbar-right">
        <ControlesDeTurno />
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
        {/* The way out of the session, in the chrome this route tree actually renders.
            It used to live only in `Navbar`/`Sidebar`, which `App.jsx` never mounts — a feature
            defined and unreachable, the same trap `ControlesDeTurno`'s comment records for the
            handover. `AuthContext.logout` clears the session and `isAuthenticated` flips, so the
            shell swaps `<Routes>` for `<Acceso />`; the button is the operator's half of it. */}
        {user ? (
          <button
            type="button"
            className="theme-toggle"
            onClick={logout}
            title="Cerrar sesión"
            aria-label="Cerrar sesión"
            data-testid="cerrar-sesion"
          >
            <i className="fa-solid fa-right-from-bracket" aria-hidden="true"></i>
          </button>
        ) : null}
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
            Pediste <code>{location.pathname}</code>. La app de escritorio hoy vende, muestra el
            historial y cobra las cuentas corrientes; el resto de las secciones todavia no.
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
            <NavLink to="/deudores" className="btn-secondary">
              <i className="fa-solid fa-hand-holding-dollar" aria-hidden="true"></i> Ver deudores
            </NavLink>
          </div>
        </div>
      </main>
    </div>
  );
};

/**
 * The debtor list, in the same chrome as Ventas.
 *
 * NOT WRAPPED IN `CajaGuard`, deliberately and this is the difference from the POS. `CajaGuard`
 * exists because a SALE with no open till records no drawer movement, so a cashier must not be
 * able to start selling. A PAYMENT is the opposite case: a card payment and a transfer are
 * refused by nothing, and forcing the till open to look at who owes what would put an error page
 * between an operator and a debt they are trying to collect. The only thing the till is needed
 * for here is CASH, and `deudores.addPayment` says so by name — `CAJA_ABIERTA_REQUERIDA`, 409 —
 * on the cash method and only on the cash method.
 */
const PaginaDeudores = () => (
  <div className="app-layout">
    <main className="main">
      <TopBar titulo="Deudores" />
      <Deudores />
    </main>
  </div>
);

/**
 * THE GATE IS NOW A PERSON, NOT A FILE.
 *
 * This used to say "the desktop has no login, so whoever opens the file IS the operator". That
 * is exactly what the shopkeeper asked to stop: on a till that four people share, "who rang this
 * up" answered "whoever switched the machine on", which is not an answer worth keeping in a
 * sales ledger.
 *
 * So `Acceso` is the gate: while `auth.me` answers null, the whole route tree is replaced by the
 * sign-in panel, and every repository behind it would refuse anyway with `ACTOR_REQUERIDO`
 * because there is no session. The two agree by construction — the panel is not a decoration in
 * front of a door that is already open.
 *
 * The till guard (`CajaGuard`) stays exactly where it was. It asks a different question: not WHO
 * is here, but whether the drawer is open. One is about the audit trail, the other is about the
 * money, and neither replaces the other.
 */
const App = () => {
  const { isAuthenticated, loading, puedeAdministrarUsuarios } = useAuth();

  if (loading) {
    return (
      <div className="acceso">
        <div className="acceso-panel card">Cargando…</div>
      </div>
    );
  }

  if (!isAuthenticated) return <Acceso />;

  return (
    <Routes>
      <Route path="/usuarios" element={
        puedeAdministrarUsuarios ? (
          <div className="app-layout">
            <main className="main">
              <TopBar titulo="Usuarios" />
              <Usuarios />
            </main>
          </div>
        ) : (
          <div className="app-layout">
            <main className="main">
              <TopBar titulo="Usuarios" />
              <div className="card">
                <p>Sólo el dueño o un supervisor pueden ver los usuarios.</p>
              </div>
            </main>
          </div>
        )
      } />
      {/* A till app opens on the till, not on a menu. */}
      <Route path="/" element={<Navigate to="/pos" replace />} />
      {/* And `/index.html` opens on the till too, because THAT is the URL the app launches with.
          `rendererUrl()` in src/main/protocol.js returns `app://bundle/index.html`, so the path
          `BrowserRouter` sees on a real launch is `/index.html` — which is not `/` and matched
          nothing but the `*` catch-all below. The first thing an operator saw on every launch was
          the "No disponible" placeholder, and the till was one click further away than the
          comment above promises. Found by launching the app, not by a test: every test mounts a
          component or renders at `/`, so nothing ever asked what the real launch URL resolves to.
          The redirect is deliberately a ROUTE and not a change to `rendererUrl()`: deep links like
          `app://bundle/ventas` rely on `isNavigationRequest()` treating a real file path as a
          file, and moving the launch URL would put that rule and the router in each other's way. */}
      <Route path="/index.html" element={<Navigate to="/pos" replace />} />
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
      {/* Customers and debtors are the SAME ROWS here. The web had a `clientes` screen and a
          `deudores` screen over one `clientes_deudores` table, so sending the old `/clientes`
          URL to the debtor list is a redirect to the truth rather than a missing page: a customer
          with a clean slate is on that list too, with a "Debe" of $0,00. */}
      <Route path="/deudores" element={<PaginaDeudores />} />
      <Route path="/clientes" element={<Navigate to="/deudores" replace />} />
      {/* The panel, and the ten reports. BOTH SIT BEHIND THE `isAuthenticated` GATE ABOVE, and
          that is the whole security story for them — not a per-route check, not a role test.
          `App` returns `<Acceso />` INSTEAD OF `<Routes>` when nobody is signed in, so an
          unauthenticated renderer never mounts a report at all: there is no element to render,
          no `useEffect` to fire, no query to make, and no `reportes.*` payload to receive. A
          report is a summary of one shop's money, so the screen and the identity it reads are
          gated by the same `if`.
          Main refuses the same call independently — every report handler calls `requireTenant`
          and answers `TENANT_REQUIRED` with no `actorId` — so the gate is not the only thing
          between an anonymous renderer and a ledger; it is the first of two. */}
      <Route
        path="/dashboard"
        element={
          <div className="app-layout">
            <main className="main">
              <TopBar titulo="Panel" />
              <Panel />
            </main>
          </div>
        }
      />
      {/* `/reportes` on its own sends the operator to the sales report rather than to a dead end:
          that is the first thing anybody wants after opening a tab called Reportes. The web's
          screen defaulted to the managerial tab; sales is the one an operator checks daily, and
          the tab strip is one click away either way. */}
      <Route path="/reportes" element={<Navigate to="/reportes/ventas" replace />} />
      <Route
        path="/reportes/:reporte"
        element={
          <div className="app-layout">
            <main className="main">
              <TopBar titulo="Reportes" />
              <Reportes />
            </main>
          </div>
        }
      />
      {/* Suppliers and purchases, in the same chrome and for the same reason `Deudores` is not
          behind `CajaGuard`: only the CASH method needs the till open, and `compras.create` says
          so by name — `CAJA_ABIERTA_REQUERIDA`, 409 — on cash and on nothing else. A card or a
          credit purchase is a bookkeeping act, and refusing to let an operator LOOK at what the
          shop owes its suppliers because the drawer happens to be closed would be the guard
          backwards. The guard exists so a cashier cannot sell into a closed till by accident;
          nobody sells by browsing this list. */}
      <Route
        path="/proveedores"
        element={
          <div className="app-layout">
            <main className="main">
              <TopBar titulo="Proveedores" />
              <Proveedores />
            </main>
          </div>
        }
      />
      <Route
        path="/compras"
        element={
          <div className="app-layout">
            <main className="main">
              <TopBar titulo="Compras" />
              <Compras />
            </main>
          </div>
        }
      />
      <Route path="*" element={<NoDisponible />} />
    </Routes>
  );
};

export default App;
