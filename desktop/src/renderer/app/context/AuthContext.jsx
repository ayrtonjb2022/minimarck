import React, { createContext, useState, useContext, useEffect } from "react";
import { authAPI } from "../api/auth";
import { negocioAPI } from "../api/negocio";
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
 * WHO IS OPERATING, on a machine that has no sign-in.
 *
 * WHAT IS GONE AND WHY IT IS GONE. The web's version held a JWT in `localStorage`, exposed
 * `login`/`logout`, and redirected to /login on a 401. None of that exists on the desktop
 * (decision #275): there is no password, no session and no token, so there is nothing to store,
 * nothing to expire and nothing to redirect to. A login form on a till machine that boots straight
 * into the register would be a speed bump with nothing behind it — anyone who can open the app
 * can read the file, whatever the password was.
 *
 * WHAT REPLACES IT. One call to `auth.me`, which main answers from the local identity resolved
 * at startup. The operator is a FACT ABOUT THE FILE, not a credential, and `user.rol` still works
 * because the seed's admin is a real `users` row with a real role.
 *
 * `isAuthenticated` is kept — five components branch on it — and it now means "the file has an
 * operator", which is the only question the desktop can actually ask. It is NOT a security check
 * and must not be used as one: there is nothing to be unauthorized from.
 *
 * `login` and `logout` are NOT provided. `ProtectedRoute` is not mounted either, and a `user` of
 * null is a file with no operator, which main already logged an actionable sentence for; the
 * shell renders that state rather than bouncing to a page that does not exist.
 */
export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [negocio, setNegocio] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let vigente = true;
    (async () => {
      try {
        const [operador, tienda] = await Promise.all([
          authAPI.me(),
          negocioAPI.obtener().catch(() => null),
        ]);
        if (!vigente) return;
        setUser(operador);
        setNegocio(tienda);
      } catch (err) {
        // TENANT_REQUIRED here means the FILE has no resolvable business or operator, which
        // `identityWarning` already explained in main's log with the specific cause. This keeps
        // the reason visible in the window too, instead of leaving a blank shell.
        if (!vigente) return;
        setError(mensajeDeError(err, "Sin identidad local"));
      } finally {
        if (vigente) setLoading(false);
      }
    })();
    return () => {
      vigente = false;
    };
  }, []);

  const value = {
    user,
    negocio,
    error,
    loading,
    isAuthenticated: !!user,
    isAdmin: user?.rol === "admin",
    isSupervisor: user?.rol === "supervisor",
    isVendedor: user?.rol === "vendedor",
    hasRole: (role) => user?.rol === role,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
