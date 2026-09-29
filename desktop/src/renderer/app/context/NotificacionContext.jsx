import { createContext, useContext, useState, useCallback } from "react";

const NotificacionContext = createContext();

/**
 * A notification bell that does not fetch.
 *
 * The web version called `notificacionesAPI.listar()` on mount and then every 60 seconds, and it
 * gated even that on `localStorage.getItem("token")` existing — a dependency on a token the
 * desktop does not have, so the fetch would have been skipped anyway.
 *
 * It is not restored here. `notificaciones.list` is a contract member with no handler in this
 * build, so a poll would answer 501 once a minute forever and fill the log with a refusal the
 * operator never asked for. The `useNotificaciones` shape is kept — the Navbar reads `count` — and
 * it reads 0, which is the truth: this build has no notification source.
 *
 * `toast` (react-toastify) is the real feedback channel and needs no provider; it is what every
 * message in the POS uses.
 */
export function NotificacionProvider({ children }) {
  const [notificaciones, setNotificaciones] = useState([]);

  const refresh = useCallback(async () => {
    setNotificaciones([]);
    return [];
  }, []);

  const value = { notificaciones, count: 0, loading: false, refresh };

  return <NotificacionContext.Provider value={value}>{children}</NotificacionContext.Provider>;
}

export const useNotificaciones = () => useContext(NotificacionContext);
