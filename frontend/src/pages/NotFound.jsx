import React from "react";
import { useNavigate } from "react-router-dom";
import "./NotFound.css";

const NotFound = () => {
  const navigate = useNavigate();

  return (
    <div className="not-found">
      {/* Logo */}
      <div className="not-found__header">
        <span className="not-found__logo">MiniMarck</span>
        <button className="not-found__home-btn" onClick={() => navigate("/dashboard")}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
          Inicio
        </button>
      </div>

      {/* Grid dos columnas */}
      <div className="not-found__grid">
        {/* Columna izquierda — texto */}
        <div className="not-found__content">
          <h1 className="not-found__title">404</h1>
          <h2 className="not-found__subtitle">Página no encontrada</h2>
          <p className="not-found__text">
            La página que buscas no existe o fue movida. Revisá la URL o volvé al inicio para seguir usando MiniMarck.
          </p>
          <div className="not-found__actions">
            <button className="not-found__btn not-found__btn--primary" onClick={() => navigate(-1)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="19" y1="12" x2="5" y2="12" />
                <polyline points="12 19 5 12 12 5" />
              </svg>
              Volver
            </button>
          </div>
        </div>

        {/* Columna derecha — ilustración */}
        <div className="not-found__illustration">
          <img
            src="/not-found-worker.png"
            alt="Página no encontrada"
            className="not-found__image"
          />
        </div>
      </div>
    </div>
  );
};

export default NotFound;
