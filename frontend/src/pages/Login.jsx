import React, { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { motion } from "framer-motion";

const Login = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    const result = await login(email, password);
    setLoading(false);
    if (result.success) navigate("/dashboard");
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0f0d0c", padding: 16 }}>
      <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} style={{ width: "100%", maxWidth: 420 }}>
        <Link to="/" style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "#6a6a6b", fontSize: 13, marginBottom: 16, textDecoration: "none", transition: "color 0.2s" }}
              onMouseEnter={(e) => e.currentTarget.style.color = "#7e9cd8"}
              onMouseLeave={(e) => e.currentTarget.style.color = "#6a6a6b"}>
          <i className="fa-solid fa-arrow-left" style={{ fontSize: 12 }}></i> Volver al inicio
        </Link>
        <div style={{ background: "#1d1c19", borderRadius: 16, boxShadow: "0 4px 24px rgba(0,0,0,0.3)", padding: 40, border: "1px solid #363432" }}>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <Link to="/" style={{ textDecoration: "none" }}>
              <i className="fa-solid fa-store" style={{ fontSize: 48, color: "#7e9cd8", marginBottom: 12, cursor: "pointer" }}></i>
              <h1 style={{ fontSize: 28, fontWeight: 800, color: "#c5c9c5", cursor: "pointer" }}>MiniMarck2</h1>
            </Link>
            <p style={{ color: "#8992a7", marginTop: 4, fontSize: 14 }}>Sistema POS / CRM — Iniciar sesión</p>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label><i className="fa-regular fa-envelope"></i> Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@empresa.com" required />
            </div>
            <div className="form-group">
              <label><i className="fa-solid fa-lock"></i> Contraseña</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
            </div>
            <button type="submit" disabled={loading} className="btn-primary" style={{ width: "100%", padding: "10px 18px", marginTop: 8, justifyContent: "center" }}>
              {loading ? "Iniciando sesión..." : "Iniciar Sesión"}
            </button>
          </form>

          <div style={{ marginTop: 16, textAlign: "center", fontSize: 13, color: "#6a6a6b" }}>
            <p>¿No tenés cuenta? <Link to="/register" style={{ color: "#7e9cd8", fontWeight: 600, textDecoration: "none" }}>Crear negocio</Link></p>
          </div>

        </div>
      </motion.div>
    </div>
  );
};

export default Login;
