import { useState } from "react";
import { useCaja } from "../../context/CajaContext";
import { useAuth } from "../../context/AuthContext";
import Loader from "./Loader";

const CajaGuard = ({ children }) => {
  const { cajaActiva, loadingCaja, abrirCaja } = useCaja();
  const { user } = useAuth();
  const [saldoInicial, setSaldoInicial] = useState("");
  const [observaciones, setObservaciones] = useState("");
  const [abriendo, setAbriendo] = useState(false);
  const [error, setError] = useState("");

  if (loadingCaja) return <Loader fullScreen />;

  if (!cajaActiva && user && (user.rol === "admin" || user.rol === "supervisor")) {
    const handleAbrir = async () => {
      const monto = parseFloat(saldoInicial);
      if (isNaN(monto) || monto < 0) {
        setError("Ingresa un saldo inicial válido");
        return;
      }
      setError("");
      setAbriendo(true);
      const result = await abrirCaja(monto, observaciones);
      setAbriendo(false);
      if (!result.success) {
        setError(result.error || "Error al abrir la caja");
      }
    };

    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0f0d0c", padding: 16 }}>
        <div style={{ background: "#1d1c19", borderRadius: 16, boxShadow: "0 4px 24px rgba(0,0,0,0.3)", width: "100%", maxWidth: 440, padding: 32, border: "1px solid #363432" }}>
          <div style={{ textAlign: "center", marginBottom: 24 }}>
            <i className="fa-solid fa-cash-register" style={{ fontSize: 48, color: "#c4a57b", marginBottom: 12 }}></i>
            <h2 style={{ fontSize: 22, fontWeight: 700, color: "#c5c9c5", margin: 0 }}>Caja Cerrada</h2>
            <p style={{ color: "#8992a7", marginTop: 8, fontSize: 14 }}>No tenés una caja abierta. Para usar el sistema, debés abrir una caja primero.</p>
            {user?.negocio && <p style={{ fontSize: 13, color: "#6a6a6b", marginTop: 4 }}>Negocio: <strong style={{ color: "#c5c9c5" }}>{user.negocio.nombre || user.negocio}</strong></p>}
          </div>

          <div className="form-group">
            <label><i className="fa-solid fa-dollar-sign"></i> Saldo Inicial</label>
            <input type="number" min="0" step="0.01" autoFocus value={saldoInicial} onChange={(e) => { setSaldoInicial(e.target.value); setError(""); }}
              onKeyDown={(e) => e.key === "Enter" && handleAbrir()}
              style={error ? { borderColor: "#e46885", fontSize: 18 } : { fontSize: 18 }}
              placeholder="0.00" />
            {error && <p style={{ fontSize: 12, color: "#e46885", marginTop: 4 }}>{error}</p>}
          </div>

          <div className="form-group">
            <label><i className="fa-regular fa-note-sticky"></i> Observaciones</label>
            <textarea value={observaciones} onChange={(e) => setObservaciones(e.target.value)}
              rows={2} placeholder="Opcional — motivo de apertura" style={{ resize: "none" }} />
          </div>

          <button onClick={handleAbrir} disabled={abriendo} className="btn-primary" style={{ width: "100%", justifyContent: "center", padding: "10px 18px", fontSize: 15 }}>
            {abriendo ? <><i className="fa-solid fa-spinner fa-spin"></i> Abriendo caja...</> : <><i className="fa-solid fa-cash-register"></i> Abrir Caja</>}
          </button>
        </div>
      </div>
    );
  }

  if (!cajaActiva && user && user.rol === "vendedor") {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0f0d0c", padding: 16 }}>
        <div style={{ background: "#1d1c19", borderRadius: 16, boxShadow: "0 4px 24px rgba(0,0,0,0.3)", width: "100%", maxWidth: 440, padding: 32, textAlign: "center", border: "1px solid #363432" }}>
          <i className="fa-solid fa-triangle-exclamation" style={{ fontSize: 48, color: "#e46885", marginBottom: 12 }}></i>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: "#c5c9c5", margin: 0 }}>Caja Cerrada</h2>
          <p style={{ color: "#8992a7", marginTop: 8, fontSize: 14 }}>No hay una caja abierta. Contactá a tu supervisor para que abra la caja.</p>
        </div>
      </div>
    );
  }

  return children;
};

export default CajaGuard;
