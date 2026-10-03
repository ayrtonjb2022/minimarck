import React, { createContext, useState, useContext, useEffect, useCallback } from "react";
import { authAPI } from "../api/auth";
import { mensajeDeError } from "../api/ipc";

const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};

/**
 * WHO IS ON THE TILL, AND HOW THEY GOT THERE.
 *
 * The desktop now has real sign-in: a password, checked in the main process, and a session that
 * lives there. What the renderer gets back is a NAME and a ROLE, never a secret and never
 * anything it could replay — there is no token here to steal, because the renderer is not the
 * thing being authenticated. The process is.
 *
 * `auth.me` answers `null` when nobody is signed in, and that null is the whole gate: the shell
 * renders the sign-in panel instead of the app. It is a value, not an error, because "nobody is
 * signed in" is the normal state of a till that has just been switched on, not a failure.
 *
 * `personas` is the list the handover picker needs — who else works here — and it arrives on the
 * same call the shell was already making. That is why the handover is a pick and not a guess.
 *
 * A RELOAD DOES NOT SIGN YOU OUT, and a RESTART DOES. `auth.me` is asked again every time this
 * provider mounts, so a crashed-and-rebuilt window, a deep link, or a dev reload all come back
 * signed in. The session lives in the main process, and none of those restart it. Quitting the
 * app is what ends a session, which is the honest line: on a single machine, the process IS the
 * session, and pretending otherwise with a persisted "remember me" would be a lock that opens by
 * itself.
 */
export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [negocio, setNegocio] = useState(null);
  const [personas, setPersonas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refrescar = useCallback(async () => {
    try {
      const estado = await authAPI.me();
      setUser(estado?.user ?? null);
      setNegocio(estado?.negocio ?? null);
      setPersonas(estado?.personas ?? []);
      return estado;
    } catch (err) {
      setError(mensajeDeError(err, "Sin identidad local"));
      return null;
    }
  }, []);

  useEffect(() => {
    let vigente = true;
    (async () => {
      await refrescar();
      if (vigente) setLoading(false);
    })();
    return () => {
      vigente = false;
    };
  }, [refrescar]);

  /**
   * Sign in — and, when somebody is already on the till, hand it over.
   *
   * The name may be typed or picked, and the password is always the INCOMING person's. There is
   * no branch in here that skips the password, because there is no branch anywhere in the app
   * that can.
   */
  const login = async (nombre, password) => {
    setError(null);
    const estado = await authAPI.login(nombre, password);
    await refrescar();
    return estado;
  };

  /** First launch (creates the business and its owner) or, when signed in, add an employee. */
  const register = async (datos) => {
    setError(null);
    const estado = await authAPI.register(datos);
    await refrescar();
    return estado;
  };

  /**
   * `auth.changePassword`, aimed at somebody else.
   *
   * This is the owner setting an employee's password because the employee forgot the one they
   * were given at hiring. It carries NO current password on purpose: the session is the proof that
   * the owner is who they say they are, and requiring the old password here would mean the owner
   * has to know an employee's password in order to replace it — which is the opposite of the point.
   *
   * Main decides whether the call is allowed, from the role in the session. A supervisor calling
   * this gets a 403 and the reason arrives here as a message the users module already knows how to
   * show, so the refusal is visible where the button was pressed rather than swallowed.
   */
  const restablecerPassword = async (usuarioId, password) => {
    setError(null);
    const res = await authAPI.changePassword(undefined, password, usuarioId);
    // `personas` is the roster the users screen renders, and the reset does not change a name — but
    // the credential row behind a person IS what `puedeIngresar` reports, so a person who had no
    // password and just got one has to stop showing as "sin credencial". One refresh is cheaper than
    // teaching the screen which half of the roster a reset can change.
    await refrescar();
    return res;
  };

  /** End the session. The panel comes back, and the next launch starts here too. */
  const logout = async () => {
    await authAPI.logout();
    setUser(null);
    setNegocio(null);
    setPersonas([]);
  };

  const value = {
    user,
    /**
     * `actual` is `user` under the name the users screen asks for.
     *
     * The reset button's guard is `actual?.rol === "admin" && p.id !== actual.id` — "the owner, and
     * not on their own row, because your own password is the self path and needs the old one". That
     * expression was written against a property this provider never published, so the guard was
     * always `undefined === "admin"` and the button was invisible for everybody, including the owner
     * the feature exists for. The backend was complete the whole time.
     *
     * It is an ALIAS and not a second piece of state on purpose: two fields meaning "who is signed
     * in" is how a screen ends up reading one while the session updates the other.
     */
    actual: user,
    negocio,
    personas,
    error,
    loading,
    isAuthenticated: !!user,
    isAdmin: user?.rol === "admin",
    isSupervisor: user?.rol === "supervisor",
    isVendedor: user?.rol === "vendedor",
    /** Who may open the users module: the owner and a supervisor. The web stores the role and
     *  does not enforce it, so this is the check the desktop owes. */
    puedeAdministrarUsuarios: user?.rol === "admin" || user?.rol === "supervisor",
    hasRole: (role) => user?.rol === role,
    login,
    register,
    restablecerPassword,
    logout,
    refrescar
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
