import React, { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

const Modal = ({ isOpen, onClose, title, children, size = "md", className = "" }) => {
  const modalRef = useRef();

  useEffect(() => {
    const handleEscape = (e) => { if (e.key === "Escape") onClose(); };
    const handleClickOutside = (e) => { if (modalRef.current && !modalRef.current.contains(e.target)) onClose(); };
    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
      document.addEventListener("mousedown", handleClickOutside);
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.removeEventListener("mousedown", handleClickOutside);
      document.body.style.overflow = "unset";
    };
  }, [isOpen, onClose]);

  const sizeMap = { sm: 400, md: 500, lg: 700, xl: 900, full: 1100 };

  return (
    <AnimatePresence>
      {isOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 200, overflowY: "auto", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }} onClick={onClose} />
          <motion.div ref={modalRef} initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }}
            style={{ position: "relative", background: "var(--kanagawa-bg)", borderRadius: 16, boxShadow: "0 20px 60px rgba(0,0,0,0.5)", width: "100%", maxWidth: sizeMap[size], maxHeight: "90vh", display: "flex", flexDirection: "column" }}
            className={className}>
            {title && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "20px 24px", borderBottom: "1px solid var(--kanagawa-border)" }}>
                <h3 style={{ fontSize: 18, fontWeight: 600, color: "var(--kanagawa-fg)" }}>{title}</h3>
                <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, color: "var(--kanagawa-comment)", cursor: "pointer", padding: 4, borderRadius: 8 }}
                  onMouseEnter={(e) => e.target.style.background = "var(--kanagawa-surface0)"} onMouseLeave={(e) => e.target.style.background = "transparent"}>
                  <i className="fa-solid fa-xmark"></i>
                </button>
              </div>
            )}
            <div style={{ padding: "20px 24px", overflowY: "auto", flex: 1 }}>{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

export default Modal;
