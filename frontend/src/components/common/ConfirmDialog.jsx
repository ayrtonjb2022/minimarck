import React from "react";
import { motion, AnimatePresence } from "framer-motion";

const ConfirmDialog = ({ isOpen, onClose, onConfirm, title, message, confirmText = "Confirmar", cancelText = "Cancelar" }) => {
  return (
    <AnimatePresence>
      {isOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }} onClick={onClose} />
          <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}
            style={{ position: "relative", background: "var(--kanagawa-bg)", borderRadius: 16, boxShadow: "0 20px 60px rgba(0,0,0,0.5)", maxWidth: 480, width: "100%", padding: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
              <div style={{ width: 48, height: 48, borderRadius: "50%", background: "var(--kanagawa-bg-alt)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <i className="fa-solid fa-triangle-exclamation" style={{ color: "var(--kanagawa-red)", fontSize: 24 }}></i>
              </div>
              <div>
                <h3 style={{ fontSize: 18, fontWeight: 600, color: "var(--kanagawa-fg)", margin: 0 }}>{title}</h3>
                <p style={{ fontSize: 14, color: "var(--kanagawa-fg-muted)", margin: "4px 0 0 0" }}>{message}</p>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 20 }}>
              <button onClick={onClose} className="btn-secondary">{cancelText}</button>
              <button onClick={() => { onConfirm(); onClose(); }} className="btn-danger">{confirmText}</button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

export default ConfirmDialog;
