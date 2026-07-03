import React, { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { authAPI } from "../api/auth";
import { toast } from "react-toastify";

const TIPOS_COMERCIO = [
  { value: "despensa", label: "Despensa" },
  { value: "kiosco", label: "Kiosco" },
  { value: "ferreteria", label: "Ferretería" },
  { value: "tienda_ropa", label: "Tienda de Ropa" },
  { value: "casa_electricidad", label: "Casa de Electricidad" },
  { value: "electrodomesticos", label: "Electrodomésticos" },
  { value: "libreria", label: "Librería" },
  { value: "veterinaria", label: "Veterinaria" },
  { value: "regaleria", label: "Regalería" },
  { value: "otro", label: "Otro" },
];

const Register = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({});
  const [form, setForm] = useState({
    nombre: "", email: "", password: "", confirmPassword: "",
    nombreNegocio: "", ruc: "", tipoComercio: "otro", telefono: "", direccion: "",
  });

  const update = (field, value) => { setForm((prev) => ({ ...prev, [field]: value })); setErrors((prev) => ({ ...prev, [field]: "" })); };

  const handleRegister = async () => {
    if (form.password !== form.confirmPassword) {
      toast.error("Las contraseñas no coinciden");
      return;
    }
    setLoading(true);
    try {
      const { confirmPassword, ...payload } = form;
      const res = await authAPI.register(payload);
      const { token, user } = res.data.data;
      localStorage.setItem("token", token);
      localStorage.setItem("user", JSON.stringify(user));
      toast.success("Negocio registrado exitosamente");
      navigate("/dashboard");
    } catch (err) {
      const data = err.response?.data;
      if (data?.errors) {
        const fieldErrors = {};
        data.errors.forEach((e) => { fieldErrors[e.field] = e.message; });
        setErrors(fieldErrors);
        toast.error(data.message || "Error de validación");
        if (fieldErrors.nombre || fieldErrors.email || fieldErrors.password) setStep(1);
        else if (fieldErrors.nombreNegocio || fieldErrors.ruc || fieldErrors.telefono || fieldErrors.direccion) setStep(2);
      } else {
        toast.error(data?.message || "Error al registrar");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0f0d0c", padding: 16 }}>
      <div style={{ width: "100%", maxWidth: 560 }}>
        <Link to="/" style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "#6a6a6b", fontSize: 13, marginBottom: 16, textDecoration: "none", transition: "color 0.2s" }}
              onMouseEnter={(e) => e.currentTarget.style.color = "#7e9cd8"}
              onMouseLeave={(e) => e.currentTarget.style.color = "#6a6a6b"}>
          <i className="fa-solid fa-arrow-left" style={{ fontSize: 12 }}></i> Volver al inicio
        </Link>
        <div style={{ background: "#1d1c19", borderRadius: 16, boxShadow: "0 4px 24px rgba(0,0,0,0.3)", padding: 40, border: "1px solid #363432" }}>
          <div style={{ textAlign: "center", marginBottom: 28 }}>
            <Link to="/" style={{ textDecoration: "none" }}>
              <i className="fa-solid fa-store" style={{ fontSize: 40, color: "#7e9cd8", marginBottom: 8, cursor: "pointer" }}></i>
              <h1 style={{ fontSize: 24, fontWeight: 800, color: "#c5c9c5", cursor: "pointer" }}>MiniMarck2</h1>
            </Link>
            <p style={{ color: "#8992a7", marginTop: 4, fontSize: 14 }}>Completá los pasos para registrar tu empresa</p>
          </div>

          <div style={{ display: "flex", justifyContent: "center", gap: 8, marginBottom: 28 }}>
            {[1, 2].map((s) => (
              <div key={s} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 28, height: 28, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, background: step >= s ? "#7e9cd8" : "#363432", color: step >= s ? "#181616" : "#6a6a6b", transition: "all 0.3s" }}>{s}</div>
                <span style={{ fontSize: 12, color: step >= s ? "#c5c9c5" : "#6a6a6b", fontWeight: step >= s ? 600 : 400 }}>
                  {s === 1 ? "Tus datos" : "Negocio"}
                </span>
                {s < 2 && <div style={{ width: 24, height: 1, background: step > s ? "#7e9cd8" : "#363432" }} />}
              </div>
            ))}
          </div>

          {step === 1 && (
            <div>
              <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16, color: "#c5c9c5" }}>Tus datos personales</h3>
              <div className="form-group">
                <label>Nombre completo *</label>
                <input type="text" value={form.nombre} onChange={(e) => update("nombre", e.target.value)} placeholder="Ej: Carlos Pérez" required className={errors.nombre ? "error" : ""} />
                {errors.nombre && <p style={{ fontSize: 12, color: "#e46885", marginTop: 4 }}>{errors.nombre}</p>}
              </div>
              <div className="form-group">
                <label>Email *</label>
                <input type="email" value={form.email} onChange={(e) => update("email", e.target.value)} placeholder="admin@tutienda.com" required className={errors.email ? "error" : ""} />
                {errors.email && <p style={{ fontSize: 12, color: "#e46885", marginTop: 4 }}>{errors.email}</p>}
              </div>
              <div className="form-group">
                <label>Contraseña *</label>
                <input type="password" value={form.password} onChange={(e) => update("password", e.target.value)} placeholder="Mín. 6 caracteres" required className={errors.password ? "error" : ""} />
                {errors.password && <p style={{ fontSize: 12, color: "#e46885", marginTop: 4 }}>{errors.password}</p>}
              </div>
              <div className="form-group">
                <label>Confirmar contraseña *</label>
                <input type="password" value={form.confirmPassword} onChange={(e) => update("confirmPassword", e.target.value)} placeholder="Repetí la contraseña" required />
              </div>
              <button onClick={() => setStep(2)} className="btn-primary" style={{ width: "100%", justifyContent: "center", marginTop: 4 }}>
                Siguiente <i className="fa-solid fa-arrow-right"></i>
              </button>
            </div>
          )}

          {step === 2 && (
            <div>
              <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16, color: "#c5c9c5" }}>Datos del negocio</h3>
              <div className="form-group">
                <label>Nombre del negocio *</label>
                <input type="text" value={form.nombreNegocio} onChange={(e) => update("nombreNegocio", e.target.value)} placeholder="Ej: Mi Tienda" required className={errors.nombreNegocio ? "error" : ""} />
                {errors.nombreNegocio && <p style={{ fontSize: 12, color: "#e46885", marginTop: 4 }}>{errors.nombreNegocio}</p>}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div className="form-group">
                  <label>RUC / RFC</label>
                  <input type="text" value={form.ruc} onChange={(e) => update("ruc", e.target.value)} placeholder="Opcional" className={errors.ruc ? "error" : ""} />
                  {errors.ruc && <p style={{ fontSize: 12, color: "#e46885", marginTop: 4 }}>{errors.ruc}</p>}
                </div>
                <div className="form-group">
                  <label>Tipo de comercio</label>
                  <select value={form.tipoComercio} onChange={(e) => update("tipoComercio", e.target.value)}>
                    {TIPOS_COMERCIO.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label>Teléfono</label>
                <input type="text" value={form.telefono} onChange={(e) => update("telefono", e.target.value)} placeholder="Opcional" className={errors.telefono ? "error" : ""} />
                {errors.telefono && <p style={{ fontSize: 12, color: "#e46885", marginTop: 4 }}>{errors.telefono}</p>}
              </div>
              <div className="form-group">
                <label>Dirección</label>
                <input type="text" value={form.direccion} onChange={(e) => update("direccion", e.target.value)} placeholder="Opcional" className={errors.direccion ? "error" : ""} />
                {errors.direccion && <p style={{ fontSize: 12, color: "#e46885", marginTop: 4 }}>{errors.direccion}</p>}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button onClick={() => setStep(1)} className="btn-secondary" style={{ flex: 1, justifyContent: "center" }}>
                  <i className="fa-solid fa-arrow-left"></i> Atrás
                </button>
                <button onClick={handleRegister} disabled={loading} className="btn-primary" style={{ flex: 1, justifyContent: "center" }}>
                  {loading ? <><i className="fa-solid fa-spinner fa-spin"></i> Creando...</> : <><i className="fa-solid fa-store"></i> Crear negocio</>}
                </button>
              </div>
            </div>
          )}

          <div style={{ marginTop: 20, textAlign: "center", fontSize: 13, color: "#6a6a6b" }}>
            ¿Ya tenés cuenta? <Link to="/login" style={{ color: "#7e9cd8", fontWeight: 600, textDecoration: "none" }}>Iniciar sesión</Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Register;
