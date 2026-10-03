import React, { useState } from "react";
import { Routes, Route, Navigate, useLocation, NavLink } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import CajaGuard from "./components/common/CajaGuard";
import AppShell from "./components/common/AppShell";
import PuntoDeVenta from "./pages/puntoDeVenta";
import Ventas from "./pages/Ventas";
import Deudores from "./pages/Deudores";
import Proveedores from "./pages/Proveedores";
import Compras from "./pages/Compras";
import Acceso from "./pages/Acceso";
import Usuarios from "./pages/Usuarios";
import Reportes from "./pages/Reportes";
import Panel from "./pages/Panel";
import Productos from "./pages/Productos";
import Categorias from "./pages/Categorias";
import Contabilidad from "./pages/Contabilidad";
import Respaldos from "./pages/Respaldos";

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
 *
 * LO QUE ESTE ARCHIVO YA NO DIBUJA, Y POR QUÉ.
 *
 * El cromo de cada pantalla — la barra lateral con los doce destinos agrupados en cuatro
 * secciones, la barra delgada con el título, el relevo, el tema y la salida — vive entero en
 * `AppShell.jsx`. Este archivo pasó de catorce copias de
 * `<div className="app-layout"><main className="main"><TopBar …/><Page /></main></div>` a
 * catorce `<AppShell titulo="…"><Page /></AppShell>`, que es la mitad de las líneas y un solo
 * lugar donde un cambio de cromo hay que recordar aplicar.
 *
 * `TopBar` no se borró sin más: su mitad útil (el relevo, el tema, la salida, y
 * `.mm-topbar-title`, que `src/main/index.js` lee del DOM real para el chequeo NAV-2) se mudó
 * a `BarraSuperior` DENTRO de `AppShell.jsx`, con el porqué escrito al lado. Lo que desapareció
 * fue la tira de doce enlaces, que era el problema: a 1280px doce textos en fila son un muro,
 * y no dicen cuál es la pantalla de arranque.
 */

const PANTALLAS_FALTANTES = [
  { ruta: "/caja", nombre: "Caja", motivo: "se abre al vender, el arqueo manual no" },
  { ruta: "/configuracion", nombre: "Configuracion", motivo: "no esta en el contrato de 89 operaciones" },
];

/**
 * The screen for a route this build does not have, instead of a 404 from nowhere.
 *
 * It receives the collapse pair from `App` and passes it on instead of owning it, for the same
 * reason every other route here does: the sidebar's fold state lives in `App`, so it survives a
 * route change instead of snapping back open every time the operator hits a dead URL.
 */
const NoDisponible = ({ colapsado, onAlternarColapsado }) => {
  const location = useLocation();

  return (
    <AppShell titulo="No disponible" colapsado={colapsado} onAlternarColapsado={onAlternarColapsado}>
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
            <i className="fa-solid fa-coins" aria-hidden="true"></i> Ver deudores
          </NavLink>
        </div>
      </div>
    </AppShell>
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
 *
 * Sigue siendo un componente de módulo y no un elemento en línea dentro de `<Routes>` a propósito:
 * los componentes definidos dentro de `App` se recrean en cada render y React desmonta el
 * subárbol entero, con lo cual el estado del POS y el texto del filtro se perderían al cambiar de
 * ruta. Acá además hace falta que sea un componente para recibir y reenviar el par
 * `colapsado`/`onAlternarColapsado` como cualquier otra pantalla, sin repetir el `AppShell`
 * dentro de la lista de rutas.
 */
const PaginaDeudores = ({ colapsado, onAlternarColapsado }) => (
  <AppShell titulo="Deudores" colapsado={colapsado} onAlternarColapsado={onAlternarColapsado}>
    <Deudores />
  </AppShell>
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

  /**
   * EL ESTADO DEL PLIEGUE VIVE EN `App`, NO EN `AppShell`, Y ESO ES LO IMPORTANTE.
   *
   * `AppShell` se monta y se desmonta en cada cambio de ruta. Si el pliegue fuera estado suyo,
   * el operador que plegara el menú para liberar ancho — que es justo lo que hace alguien con
   * una pantalla chica y un carrito abierto — vería la barra reabrirse sola al ir a cobrar, y
   * otra vez al volver a vender. El estado tiene que vivir un nivel más arriba que las rutas,
   * y el único lugar de ese nivel que sobrevive a la navegación es `App`.
   *
   * `alternarColapsado` usa la forma funcional de `setColapsado` en vez de leer `colapsado` del
   * closure: con dos clics dentro del mismo tick, un cierre calculado con el valor viejo se
   * aplicaría dos veces y la barra no se movería. `v => !v` lee siempre el valor más reciente y
   * se aplica una vez.
   */
  const [colapsado, setColapsado] = useState(false);
  const alternarColapsado = () => setColapsado((v) => !v);

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
          <AppShell titulo="Usuarios" colapsado={colapsado} onAlternarColapsado={alternarColapsado}>
            <Usuarios />
          </AppShell>
        ) : (
          <AppShell titulo="Usuarios" colapsado={colapsado} onAlternarColapsado={alternarColapsado}>
            <div className="card">
              <p>Sólo el dueño o un supervisor pueden ver los usuarios.</p>
            </div>
          </AppShell>
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
      {/* EL PUNTO DE VENTA AHORA USA EL CROMO DE TODAS LAS PANTALLAS, Y ESTO NO ES COSMÉTICO.
          Antes `/pos` era la única ruta sin `app-layout`: sin barra lateral, sin marca, sin
          salida. El precio de esa excepción eran cuatro `NavLink` pegados a la fila del
          buscador en `puntoDeVenta.jsx`, y el porqué de por qué existían y de por qué se
          fueron está en el docblock de `AppShell`, que es el cromo que vino a reemplazarlos.
          `CajaGuard` sigue envolviendo al POS exactamente igual: la pregunta que hace —¿está
          abierta la caja?— es del dinero y no del cromo. */}
      <Route
        path="/pos"
        element={
          <CajaGuard>
            <AppShell titulo="Vender" colapsado={colapsado} onAlternarColapsado={alternarColapsado}>
              <PuntoDeVenta />
            </AppShell>
          </CajaGuard>
        }
      />
      <Route
        path="/ventas"
        element={
          <AppShell titulo="Ventas" colapsado={colapsado} onAlternarColapsado={alternarColapsado}>
            <Ventas />
          </AppShell>
        }
      />
      {/* Customers and debtors are the SAME ROWS here. The web had a `clientes` screen and a
          `deudores` screen over one `clientes_deudores` table, so sending the old `/clientes`
          URL to the debtor list is a redirect to the truth rather than a missing page: a customer
          with a clean slate is on that list too, with a "Debe" of $0,00. */}
      <Route
        path="/deudores"
        element={<PaginaDeudores colapsado={colapsado} onAlternarColapsado={alternarColapsado} />}
      />
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
          <AppShell titulo="Panel" colapsado={colapsado} onAlternarColapsado={alternarColapsado}>
            <Panel />
          </AppShell>
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
          <AppShell titulo="Reportes" colapsado={colapsado} onAlternarColapsado={alternarColapsado}>
            <Reportes />
          </AppShell>
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
          <AppShell titulo="Proveedores" colapsado={colapsado} onAlternarColapsado={alternarColapsado}>
            <Proveedores />
          </AppShell>
        }
      />
      <Route
        path="/compras"
        element={
          <AppShell titulo="Compras" colapsado={colapsado} onAlternarColapsado={alternarColapsado}>
            <Compras />
          </AppShell>
        }
      />
      {/* The catalogue, and the categories it is filed under.
          NOT behind `CajaGuard`, for the same reason `Proveedores` is not: pricing a product and
          organising the shelf are not till operations, and `productos.*` never touches the drawer.
          Putting them behind the open-register guard would mean a shopkeeper cannot fix a price on
          a Monday morning before opening. */}
      <Route
        path="/productos"
        element={
          <AppShell titulo="Productos" colapsado={colapsado} onAlternarColapsado={alternarColapsado}>
            <Productos />
          </AppShell>
        }
      />
      <Route
        path="/categorias"
        element={
          <AppShell titulo="Categorías" colapsado={colapsado} onAlternarColapsado={alternarColapsado}>
            <Categorias />
          </AppShell>
        }
      />
      {/* The ledger, and the debts the shop itself owes.
          NOT behind `CajaGuard`, and for the same reason `Proveedores` is not: reading the journal
          and paying a bank loan are not till operations. The ONE thing here that touches the drawer
          — a debt payment in cash — does not go through the till at all: `pagos_deuda_contabilidad`
          is a separate table from `movimientos_caja`, and refusing to show the ledger because the
          drawer happens to be closed would be the guard backwards. */}
      <Route
        path="/contabilidad"
        element={
          <AppShell titulo="Contabilidad" colapsado={colapsado} onAlternarColapsado={alternarColapsado}>
            <Contabilidad />
          </AppShell>
        }
      />
      {/* The shop's file, and the only screen that can undo a disaster.
          GATED BY ROLE, unlike every other route here: a restore replaces the database INCLUDING
          the users table, so a screen that could reach it would be a way around the sign-in it was
          supposed to be behind. The gate is the same `puedeAdministrarUsuarios` the nav link uses,
          so the sidebar cannot offer a door that answers "no". */}
      <Route
        path="/respaldos"
        element={
          puedeAdministrarUsuarios ? (
            <AppShell titulo="Respaldos" colapsado={colapsado} onAlternarColapsado={alternarColapsado}>
              <Respaldos />
            </AppShell>
          ) : (
            <AppShell titulo="Respaldos" colapsado={colapsado} onAlternarColapsado={alternarColapsado}>
              <div className="card">
                <p>Sólo el dueño o un supervisor pueden ver y restaurar respaldos.</p>
              </div>
            </AppShell>
          )
        }
      />
      <Route
        path="*"
        element={<NoDisponible colapsado={colapsado} onAlternarColapsado={alternarColapsado} />}
      />
    </Routes>
  );
};

export default App;
