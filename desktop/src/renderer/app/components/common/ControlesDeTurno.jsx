import React from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import RelevoTurno from "./RelevoTurno";

/**
 * THE TWO CONTROLS THAT MUST BE REACHABLE FROM THE TILL.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS SMALL. The handover button and the link to the
 * users module both used to live in the WEB's `Navbar`, and the desktop route tree never
 * renders that component — `App.jsx` draws its own `TopBar` and `/pos` renders the POS
 * full-bleed with no chrome at all. So the feature was complete and UNREACHABLE: there
 * was no button anywhere in the running app that handed the till over, and a
 * `data-testid="relevo-turno"` element that only existed in a file nobody mounts.
 *
 * Every unit test still passed. A test that renders a component in isolation cannot tell
 * you the component is never mounted; only driving the real app and asking the DOM for
 * that test id can. The handover drive did exactly that and got `{hayBoton: false}`.
 *
 * So the controls are here, in one place, mounted in the two places a person actually is:
 * the top strip (every screen with chrome) and the point of sale (the launch route, which
 * has no chrome). One definition, two mount points — the same decision that moved
 * `construirContexto` out of `installIpc`: if something has to be reachable from
 * everywhere, it belongs in a component, not in a page.
 *
 * The users link is gated by `puedeAdministrarUsuarios`, which comes from the ROLE in the
 * session, not from a route guard that could be bypassed. The route already refuses a
 * `vendedor`; this just stops offering them the door.
 */
const ControlesDeTurno = ({ compacto = false }) => {
  const { user, puedeAdministrarUsuarios } = useAuth();

  return (
    <div className={compacto ? "mm-turno-controles compacto" : "mm-turno-controles"}>
      {puedeAdministrarUsuarios ? (
        <NavLink
          to="/usuarios"
          className={({ isActive }) => (isActive ? "mm-turno-enlace activo" : "mm-turno-enlace")}
          title="Quién trabaja en el negocio"
          data-testid="ir-a-usuarios"
        >
          <i className="fa-solid fa-id-badge" aria-hidden="true"></i>
          {compacto ? null : "Usuarios"}
        </NavLink>
      ) : null}

      {/* The handover is a LOGIN, not a switch: whoever is taking the till types their own
          password, and there is no other way to change who is on it. That is `RelevoTurno`. */}
      <RelevoTurno />

      {compacto && user?.nombre ? (
        <span className="mm-turno-quien" title={`Rol: ${user.rol}`}>
          {user.nombre}
        </span>
      ) : null}
    </div>
  );
};

export default ControlesDeTurno;
