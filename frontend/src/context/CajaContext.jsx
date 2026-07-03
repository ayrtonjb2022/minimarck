import React, { createContext, useState, useContext, useEffect, useCallback } from "react";
import { cajasAPI } from "../api/cajas";
import { useAuth } from "./AuthContext";
import { toast } from "react-toastify";

const CajaContext = createContext();

export const useCaja = () => {
  const context = useContext(CajaContext);
  if (!context) {
    throw new Error("useCaja must be used within a CajaProvider");
  }
  return context;
};

export const CajaProvider = ({ children }) => {
  const { user, isAuthenticated } = useAuth();
  const [cajaActiva, setCajaActiva] = useState(null);
  const [loadingCaja, setLoadingCaja] = useState(true);

  const verificarCaja = useCallback(async () => {
    if (!isAuthenticated) {
      setCajaActiva(null);
      setLoadingCaja(false);
      return;
    }
    try {
      const response = await cajasAPI.activa();
      const data = response.data?.data !== undefined ? response.data.data : response.data;
      setCajaActiva(data || null);
    } catch (error) {
      if (error.response?.status === 404) {
        setCajaActiva(null);
      } else {
        console.error("Error al verificar caja activa:", error);
        setCajaActiva(null);
      }
    } finally {
      setLoadingCaja(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    verificarCaja();
  }, [verificarCaja]);

  const abrirCaja = async (saldoInicial, observaciones) => {
    try {
      const response = await cajasAPI.apertura({ saldoInicial, observaciones });
      const data = response.data?.data !== undefined ? response.data.data : response.data;
      setCajaActiva(data);
      toast.success("Caja abierta correctamente");
      return { success: true, caja: data };
    } catch (error) {
      const message = error.response?.data?.message || "Error al abrir la caja";
      toast.error(message);
      return { success: false, error: message };
    }
  };

  const cerrarCaja = async (id) => {
    try {
      await cajasAPI.cierre(id);
      setCajaActiva(null);
      toast.success("Caja cerrada correctamente");
      verificarCaja();
      return { success: true };
    } catch (error) {
      const message = error.response?.data?.message || "Error al cerrar la caja";
      toast.error(message);
      return { success: false, error: message };
    }
  };

  const value = {
    cajaActiva,
    loadingCaja,
    abrirCaja,
    cerrarCaja,
    verificarCaja,
    hayCajaActiva: !!cajaActiva,
  };

  return <CajaContext.Provider value={value}>{children}</CajaContext.Provider>;
};
