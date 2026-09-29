import React, { createContext, useState, useContext, useEffect, useCallback } from "react";
import { cajasAPI } from "../api/cajas";
import { useAuth } from "./AuthContext";
import { mensajeDeError } from "../api/ipc";
import { toast } from "react-toastify";

const CajaContext = createContext();

export const useCaja = () => {
  const context = useContext(CajaContext);
  if (!context) {
    throw new Error("useCaja must be used within a CajaProvider");
  }
  return context;
};

/**
 * The open till, and the only two things anyone does to one.
 *
 * The web version polled `cajas/activa`, special-cased a 404 as "no till", and exposed the full
 * seven-operation surface including `cierre` and `desglose`. The desktop answers `null` for no
 * open till — not a 404, because a closed shop is not a broken shop and there is no status code
 * in an IPC result to branch on — so the `error.response?.status === 404` branch is gone and its
 * intent is now the whole of the happy path.
 *
 * `cerrarCaja` is deliberately NOT here. Closing the drawer is the shift-end reconciliation
 * screen, it needs the accounting surface that is not mounted in this build, and a cashier who
 * can close a till from the register is a cashier who can close a till with cash missing. The
 * operation exists (`cajas.close`) and answers for a caller that is built to use it.
 */
export const CajaProvider = ({ children }) => {
  const { isAuthenticated } = useAuth();
  const [cajaActiva, setCajaActiva] = useState(null);
  const [loadingCaja, setLoadingCaja] = useState(true);

  const verificarCaja = useCallback(async () => {
    if (!isAuthenticated) {
      setCajaActiva(null);
      setLoadingCaja(false);
      return;
    }
    try {
      setCajaActiva((await cajasAPI.activa()) || null);
    } catch (err) {
      // Not "no till" — something refused. Showing an empty register after a failed read would
      // invite the operator to open a SECOND drawer on top of one that already exists, so the
      // reason is shown and the state stays unknown.
      console.error("Error al verificar caja activa:", err);
      toast.error(mensajeDeError(err, "No se pudo verificar la caja activa"));
    } finally {
      setLoadingCaja(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    verificarCaja();
  }, [verificarCaja]);

  /**
   * Open the drawer. The float is typed in PESOS and travels as pesos; `cajas.repo.js` converts
   * it to integer centavos, and a fractional float never reaches a column.
   */
  const abrirCaja = async (saldoInicial, observaciones) => {
    try {
      const caja = await cajasAPI.apertura({ saldoInicial, observaciones });
      setCajaActiva(caja);
      toast.success("Caja abierta correctamente");
      return { success: true, caja };
    } catch (err) {
      const message = mensajeDeError(err, "Error al abrir la caja");
      toast.error(message);
      return { success: false, error: message };
    }
  };

  const value = {
    cajaActiva,
    loadingCaja,
    abrirCaja,
    verificarCaja,
    hayCajaActiva: !!cajaActiva,
  };

  return <CajaContext.Provider value={value}>{children}</CajaContext.Provider>;
};
