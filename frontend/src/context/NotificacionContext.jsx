import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { notificacionesAPI } from "../api/notificaciones";

const NotificacionContext = createContext();

export function NotificacionProvider({ children }) {
  const [notificaciones, setNotificaciones] = useState([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!localStorage.getItem("token")) return;
    try {
      setLoading(true);
      const r = await notificacionesAPI.listar();
      setNotificaciones(r.data?.data || []);
    } catch (err) {
      console.error("[Notificaciones] Error al consultar:", err.response?.data || err.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 60000);
    return () => clearInterval(interval);
  }, []);

  const count = notificaciones.length;

  return (
    <NotificacionContext.Provider value={{ notificaciones, count, loading, refresh }}>
      {children}
    </NotificacionContext.Provider>
  );
}

export const useNotificaciones = () => useContext(NotificacionContext);
