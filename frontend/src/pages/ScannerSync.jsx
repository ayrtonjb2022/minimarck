import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { connectSocket, getSocket, disconnectSocket } from "../services/socket";
import ScannerModal from "../components/common/ScannerModal";

export default function ScannerSync() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { user, loading, isAuthenticated } = useAuth();
  const [socketConnected, setSocketConnected] = useState(false);
  const [scannedCount, setScannedCount] = useState(0);
  const [scannerOpen, setScannerOpen] = useState(true);
  const [lastResult, setLastResult] = useState(null);
  const lastResultTimer = useRef(null);
  const negocioIdRef = useRef(null);

  // Redirigir a login si no autenticado
  useEffect(() => {
    if (!loading && !isAuthenticated) {
      navigate(`/login?redirect=/scanner/${roomId}`, { replace: true });
    }
  }, [loading, isAuthenticated, navigate, roomId]);

  // Determinar negocioId: primero del user autenticado, si no del roomId
  useEffect(() => {
    if (user?.negocioId) {
      negocioIdRef.current = user.negocioId;
    } else if (roomId) {
      negocioIdRef.current = parseInt(roomId, 10) || roomId;
    }
  }, [user, roomId]);

  // Conectar socket
  useEffect(() => {
    if (!negocioIdRef.current || !isAuthenticated) return;

    const negocioId = negocioIdRef.current;
    const socket = connectSocket(negocioId, "scanner");
    setSocketConnected(socket.connected);

    socket.on("connect", () => setSocketConnected(true));
    socket.on("disconnect", () => setSocketConnected(false));

    socket.on("scan-result", (result) => {
      setLastResult(result);
      if (result.success) {
        setScannedCount((prev) => prev + 1);
      }
      // Limpiar mensaje después de 3s
      if (lastResultTimer.current) clearTimeout(lastResultTimer.current);
      lastResultTimer.current = setTimeout(() => setLastResult(null), 3000);
    });

    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("scan-result");
      disconnectSocket();
      if (lastResultTimer.current) clearTimeout(lastResultTimer.current);
    };
  }, [isAuthenticated, user?.negocioId, roomId]);

  const handleScan = useCallback((codigo) => {
    const socket = getSocket();
    if (!socket?.connected) {
      setLastResult({ success: false, message: "Socket no conectado" });
      setTimeout(() => setLastResult(null), 3000);
      return;
    }
    socket.emit("scan-barcode", {
      codigo,
      negocioId: negocioIdRef.current,
    });
  }, []);

  if (loading) {
    return (
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        height: "100vh", background: "#1a1a18", color: "#d4d4c8",
      }}>
        <div className="spinner" style={{
          width: 32, height: 32,
          border: "3px solid #363432",
          borderTopColor: "#6a9589",
          borderRadius: "50%",
          animation: "spin 0.8s linear infinite",
        }} />
      </div>
    );
  }

  const statusColor = socketConnected ? "#22c55e" : "#ef4444";
  const statusText = socketConnected ? "Conectado" : "Desconectado";

  return (
    <div style={{
      position: "fixed", inset: 0,
      background: "#1a1a18",
      display: "flex", flexDirection: "column",
      zIndex: 9999,
    }}>
      {/* Header minimalista */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "12px 16px",
        borderBottom: "1px solid #363432",
        background: "#1a1a18",
        zIndex: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 18 }}>📷</span>
          <span style={{ color: "#d4d4c8", fontSize: 14, fontWeight: 600 }}>
            Escáner Remoto
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {/* Contador */}
          <span style={{ color: "#8992a7", fontSize: 12 }}>
            {scannedCount} producto{scannedCount !== 1 ? "s" : ""}
          </span>
          {/* Estado conexión */}
          <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <span style={{
              width: 8, height: 8, borderRadius: "50%",
              background: statusColor, display: "inline-block",
            }} />
            <span style={{ color: "#8992a7" }}>{statusText}</span>
          </span>
        </div>
      </div>

      {/* Scanner */}
      <div style={{ flex: 1, position: "relative" }}>
        <ScannerModal
          isOpen={scannerOpen}
          onScan={handleScan}
          onClose={() => {}}
        />

        {/* Toast overlay */}
        {lastResult && (
          <div style={{
            position: "absolute", bottom: 24, left: 16, right: 16,
            padding: "12px 16px", borderRadius: 12,
            background: lastResult.success ? "#22c55e" : "#ef4444",
            color: "#fff", fontSize: 14, fontWeight: 600,
            textAlign: "center", zIndex: 20,
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          }}>
            {lastResult.success
              ? `✅ ${lastResult.product?.nombre || "Producto"} agregado`
              : `❌ ${lastResult.message || "Error"}`
            }
          </div>
        )}
      </div>

      {/* Botón para salir */}
      <div style={{
        padding: "12px 16px",
        borderTop: "1px solid #363432",
        background: "#1a1a18",
        textAlign: "center",
      }}>
        <button
          onClick={() => navigate("/pos")}
          style={{
            width: "100%", padding: "12px",
            background: "#363432", color: "#d4d4c8",
            border: "none", borderRadius: 8,
            fontSize: 14, fontWeight: 600, cursor: "pointer",
          }}
        >
          Volver al POS
        </button>
      </div>
    </div>
  );
}
