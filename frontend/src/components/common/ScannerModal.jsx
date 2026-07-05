import React, { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

const ScannerModal = ({ isOpen, onScan, onClose }) => {
  const mountRef = useRef(null);
  const scannerRef = useRef(null);
  const onScanRef = useRef(onScan);

  // Siempre tener el último callback
  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    if (!isOpen) {
      if (scannerRef.current) {
        scannerRef.current.stop().catch(() => {});
        scannerRef.current = null;
      }
      return;
    }

    let cancelled = false;

    const startScanner = async () => {
      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        if (cancelled) return;

        const html5QrCode = new Html5Qrcode("barcode-scanner");
        scannerRef.current = html5QrCode;

        const cameras = await Html5Qrcode.getCameras();
        if (cancelled) return;

        if (!cameras || cameras.length === 0) {
          console.error("No se encontraron cámaras");
          return;
        }

        await html5QrCode.start(
          { facingMode: "environment" },
          {
            fps: 10,
            qrbox: { width: 250, height: 150 },
          },
          (decodedText) => {
            if (cancelled) return;
            cancelled = true;
            html5QrCode.stop().catch(() => {});
            scannerRef.current = null;
            onScanRef.current(decodedText);
          },
          () => {
            // Ignorar errores de escaneo continuo
          }
        );
      } catch (err) {
        console.error("Error al iniciar scanner:", err);
      }
    };

    startScanner();

    return () => {
      cancelled = true;
      if (scannerRef.current) {
        scannerRef.current.stop().catch(() => {});
        scannerRef.current = null;
      }
    };
  }, [isOpen]);

  return (
    <AnimatePresence>
      {isOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 300,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.7)",
              backdropFilter: "blur(4px)",
            }}
            onClick={onClose}
          />
          <motion.div
            ref={mountRef}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            style={{
              position: "relative",
              background: "#1a1a18",
              borderRadius: 16,
              boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
              width: "100%",
              maxWidth: 400,
              overflow: "hidden",
            }}
          >
            {/* Header */}
            <div
              style={{
                padding: "16px 20px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                borderBottom: "1px solid #363432",
              }}
            >
              <h3
                style={{
                  fontSize: 16,
                  fontWeight: 600,
                  color: "#d4d4c8",
                  margin: 0,
                }}
              >
                Escanear Código
              </h3>
              <button
                onClick={onClose}
                style={{
                  background: "none",
                  border: "none",
                  fontSize: 20,
                  color: "#8992a7",
                  cursor: "pointer",
                  padding: 4,
                  borderRadius: 8,
                }}
                onMouseEnter={(e) =>
                  (e.target.style.background = "#2a2a26")
                }
                onMouseLeave={(e) =>
                  (e.target.style.background = "transparent")
                }
              >
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>

            {/* Camera / Scanner */}
            <div style={{ padding: 20 }}>
              <div
                id="barcode-scanner"
                style={{
                  width: "100%",
                  aspectRatio: "1/1",
                  borderRadius: 12,
                  overflow: "hidden",
                  position: "relative",
                  background: "#000",
                }}
              >
                {/* Viewfinder overlay */}
                <div
                  style={{
                    position: "absolute",
                    top: "50%",
                    left: "50%",
                    transform: "translate(-50%, -50%)",
                    width: 220,
                    height: 140,
                    zIndex: 10,
                    pointerEvents: "none",
                  }}
                >
                  {/* Corners */}
                  <div
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: 24,
                      height: 24,
                      borderTop: "3px solid #6a9589",
                      borderLeft: "3px solid #6a9589",
                      borderTopLeftRadius: 6,
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      top: 0,
                      right: 0,
                      width: 24,
                      height: 24,
                      borderTop: "3px solid #6a9589",
                      borderRight: "3px solid #6a9589",
                      borderTopRightRadius: 6,
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      bottom: 0,
                      left: 0,
                      width: 24,
                      height: 24,
                      borderBottom: "3px solid #6a9589",
                      borderLeft: "3px solid #6a9589",
                      borderBottomLeftRadius: 6,
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      bottom: 0,
                      right: 0,
                      width: 24,
                      height: 24,
                      borderBottom: "3px solid #6a9589",
                      borderRight: "3px solid #6a9589",
                      borderBottomRightRadius: 6,
                    }}
                  />
                  {/* Scanning line animation */}
                  <div
                    style={{
                      position: "absolute",
                      left: 8,
                      right: 8,
                      height: 2,
                      background:
                        "linear-gradient(90deg, transparent, #6a9589, transparent)",
                      animation: "scanLine 2s ease-in-out infinite",
                      opacity: 0.7,
                    }}
                  />
                  <style>{`
                    @keyframes scanLine {
                      0%, 100% { top: 8px; }
                      50% { top: calc(100% - 8px); }
                    }
                  `}</style>
                </div>
              </div>

              <p
                style={{
                  textAlign: "center",
                  color: "#8992a7",
                  fontSize: 13,
                  marginTop: 12,
                }}
              >
                Apuntá la cámara al código de barras del producto
              </p>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

export default ScannerModal;
