import React, { useState, useEffect } from "react";
import { negocioAPI } from "../api/negocio";
import { useAuth } from "../context/AuthContext";
import { authAPI } from "../api/auth";
import { toast } from "react-toastify";

const TABS = [
  { id: "general", label: "General", icon: "fa-cog" },
  { id: "alertas", label: "Alertas", icon: "fa-bell" },
  { id: "pos", label: "POS / Ticket", icon: "fa-cash-register" },
  { id: "perfil", label: "Perfil", icon: "fa-user" },
];

const Configuracion = () => {
  const { user } = useAuth();
  const [tab, setTab] = useState("general");
  const [negocio, setNegocio] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    nombre: "", ruc: "", direccion: "", telefono: "", email: "", website: "",
    tipoComercio: "otro",
  });
  const [alertas, setAlertas] = useState({ alertaCajaMin: "", alertaCajaMax: "" });
  const [posConfig, setPosConfig] = useState({ ticketHeader: "", ticketFooter: "" });

  // Perfil / Contraseña
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [passwordData, setPasswordData] = useState({ passwordActual: "", nuevaPassword: "", confirmarPassword: "" });
  const [savingPassword, setSavingPassword] = useState(false);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    negocioAPI.obtener()
      .then((r) => {
        const n = r.data?.data || r.data;
        setNegocio(n);
        if (n) {
          setForm({
            nombre: n.nombre || "", ruc: n.ruc || "", direccion: n.direccion || "",
            telefono: n.telefono || "", email: n.email || "", website: n.website || "",
            tipoComercio: n.tipoComercio || "otro",
          });
          const c = n.configuracion || {};
          setAlertas({ alertaCajaMin: c.alertaCajaMin || "", alertaCajaMax: c.alertaCajaMax || "" });
          setPosConfig({ ticketHeader: c.ticketHeader || "", ticketFooter: c.ticketFooter || "" });
        }
      })
      .catch(() => toast.error("Error al cargar configuración"))
      .finally(() => setLoading(false));
  }, [user]);

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = tab === "alertas"
        ? { configuracion: { 
            alertaCajaMin: parseFloat(alertas.alertaCajaMin) || 0,
            alertaCajaMax: parseFloat(alertas.alertaCajaMax) || 0,
          }}
        : form;
      await negocioAPI.actualizar(payload);
      toast.success("Configuración guardada");
    } catch (err) {
      toast.error(err.response?.data?.message || "Error al guardar");
    } finally {
      setSaving(false);
    }
  };

  const handleSavePOS = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await negocioAPI.actualizar({ configuracion: { ...negocio?.configuracion, ...posConfig } });
      toast.success("Configuración POS guardada");
    } catch (err) {
      toast.error(err.response?.data?.message || "Error al guardar");
    } finally {
      setSaving(false);
    }
  };

  const handlePasswordChange = (e) => {
    const { name, value } = e.target;
    setPasswordData({ ...passwordData, [name]: value });
    if (errors[name]) setErrors({ ...errors, [name]: "" });
  };

  const validatePassword = () => {
    const newErrors = {};
    if (!passwordData.passwordActual) newErrors.passwordActual = "La contraseña actual es requerida";
    if (!passwordData.nuevaPassword) newErrors.nuevaPassword = "La nueva contraseña es requerida";
    else if (passwordData.nuevaPassword.length < 6) newErrors.nuevaPassword = "Debe tener al menos 6 caracteres";
    if (!passwordData.confirmarPassword) newErrors.confirmarPassword = "Confirma tu nueva contraseña";
    else if (passwordData.nuevaPassword !== passwordData.confirmarPassword) newErrors.confirmarPassword = "Las contraseñas no coinciden";
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmitPassword = async (e) => {
    e.preventDefault();
    if (!validatePassword()) return;
    setSavingPassword(true);
    try {
      await authAPI.changePassword({ currentPassword: passwordData.passwordActual, newPassword: passwordData.nuevaPassword });
      toast.success("Contraseña actualizada exitosamente");
      setShowPasswordForm(false);
      setPasswordData({ passwordActual: "", nuevaPassword: "", confirmarPassword: "" });
    } catch (error) {
      toast.error(error.response?.data?.message || "Error al cambiar contraseña");
    } finally { setSavingPassword(false); }
  };

  if (loading) return <div style={{ textAlign: "center", padding: 60 }}><i className="fa-solid fa-spinner fa-spin" style={{ fontSize: 32, color: "#7e9cd8" }}></i></div>;

  const tabStyle = (t) => ({
    display: "flex", alignItems: "center", gap: 6, padding: "10px 18px", fontSize: 13,
    fontWeight: 600, border: "none", cursor: "pointer", borderRadius: "8px 8px 0 0",
    background: tab === t ? "#1d1c19" : "transparent",
    color: tab === t ? "#7e9cd8" : "#8992a7",
    borderBottom: tab === t ? "2px solid #7e9cd8" : "2px solid transparent",
    transition: "0.2s",
  });

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: 16, fontWeight: 600 }}>Configuración</h3>
        <p style={{ fontSize: 13, color: "#8992a7", marginTop: 4 }}>Administra los datos y preferencias de tu negocio</p>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 24, borderBottom: "1px solid #363432", paddingBottom: 0 }}>
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} style={tabStyle(t.id)}>
            <i className={`fa-solid ${t.icon}`}></i>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "general" && (
        <form onSubmit={handleSave} className="card" style={{ maxWidth: 640, padding: 24 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div className="form-group" style={{ gridColumn: "1 / -1" }}>
              <label>Nombre del negocio *</label>
              <input type="text" name="nombre" value={form.nombre} onChange={handleChange} required />
            </div>
            <div className="form-group">
              <label>RUC / RFC</label>
              <input type="text" name="ruc" value={form.ruc} onChange={handleChange} />
            </div>
            <div className="form-group">
              <label>Tipo de comercio</label>
              <select name="tipoComercio" value={form.tipoComercio} onChange={handleChange}>
                <option value="despensa">Despensa</option>
                <option value="kiosco">Kiosco</option>
                <option value="ferreteria">Ferretería</option>
                <option value="tienda_ropa">Tienda de Ropa</option>
                <option value="casa_electricidad">Casa de Electricidad</option>
                <option value="electrodomesticos">Electrodomésticos</option>
                <option value="libreria">Librería</option>
                <option value="veterinaria">Veterinaria</option>
                <option value="regaleria">Regalería</option>
                <option value="otro">Otro</option>
              </select>
            </div>
            <div className="form-group">
              <label>Teléfono</label>
              <input type="text" name="telefono" value={form.telefono} onChange={handleChange} />
            </div>
            <div className="form-group">
              <label>Email</label>
              <input type="email" name="email" value={form.email} onChange={handleChange} />
            </div>
            <div className="form-group">
              <label>Dirección</label>
              <input type="text" name="direccion" value={form.direccion} onChange={handleChange} />
            </div>
            <div className="form-group">
              <label>Sitio web</label>
              <input type="text" name="website" value={form.website} onChange={handleChange} />
            </div>
          </div>
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #363432", display: "flex", justifyContent: "flex-end" }}>
            <button type="submit" className="btn-primary" disabled={saving}>
              <i className="fa-solid fa-save"></i>
              {saving ? " Guardando..." : " Guardar cambios"}
            </button>
          </div>
        </form>
      )}

      {tab === "alertas" && (
        <form onSubmit={handleSave} className="card" style={{ maxWidth: 640, padding: 24 }}>
          <p style={{ fontSize: 13, color: "#8992a7", marginBottom: 20 }}>
            Configurá los montos mínimos y máximos de efectivo en caja para recibir notificaciones cuando el saldo esté fuera de esos rangos.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div className="form-group">
              <label>Alerta de saldo mínimo ($)</label>
              <input type="number" value={alertas.alertaCajaMin} onChange={(e) => setAlertas({ ...alertas, alertaCajaMin: e.target.value })} placeholder="Ej: 10000" min="0" />
              <small style={{ fontSize: 11, color: "#6a6a6b" }}>Notificará cuando el saldo esté por debajo de este monto</small>
            </div>
            <div className="form-group">
              <label>Alerta de saldo máximo ($)</label>
              <input type="number" value={alertas.alertaCajaMax} onChange={(e) => setAlertas({ ...alertas, alertaCajaMax: e.target.value })} placeholder="Ej: 500000" min="0" />
              <small style={{ fontSize: 11, color: "#6a6a6b" }}>Notificará cuando el saldo supere este monto</small>
            </div>
          </div>
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #363432", display: "flex", justifyContent: "flex-end" }}>
            <button type="submit" className="btn-primary" disabled={saving}>
              <i className="fa-solid fa-save"></i>
              {saving ? " Guardando..." : " Guardar alertas"}
            </button>
          </div>
        </form>
      )}

      {tab === "pos" && (
        <form onSubmit={handleSavePOS} className="card" style={{ maxWidth: 640, padding: 24 }}>
          <p style={{ fontSize: 13, color: "#8992a7", marginBottom: 20 }}>
            Personalizá el formato del ticket y la configuración del punto de venta.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div className="form-group">
              <label>Encabezado del ticket</label>
              <input type="text" value={posConfig.ticketHeader} onChange={(e) => setPosConfig({...posConfig, ticketHeader: e.target.value})} placeholder="Gracias por su compra" />
              <small style={{ fontSize: 11, color: "#6a6a6b" }}>Texto que aparece al inicio del ticket</small>
            </div>
            <div className="form-group">
              <label>Pie del ticket</label>
              <input type="text" value={posConfig.ticketFooter} onChange={(e) => setPosConfig({...posConfig, ticketFooter: e.target.value})} placeholder="Vuelva pronto" />
              <small style={{ fontSize: 11, color: "#6a6a6b" }}>Texto que aparece al final del ticket</small>
            </div>
          </div>
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #363432", display: "flex", justifyContent: "flex-end" }}>
            <button type="submit" className="btn-primary" disabled={saving}>
              <i className="fa-solid fa-save"></i>
              {saving ? " Guardando..." : " Guardar configuración POS"}
            </button>
          </div>
        </form>
      )}

      {tab === "perfil" && (
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <div style={{ flex: 2, minWidth: 280 }}>
            <div className="card" style={{ padding: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
                <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#7e9cd8", color: "#181616", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, fontWeight: 700 }}>
                  {(user?.nombre || "U")[0]}
                </div>
                <div>
                  <h2 style={{ fontSize: 20, fontWeight: 600, color: "#c5c9c5", margin: 0 }}>{user?.nombre}</h2>
                  <span className="rol-badge admin">{(user?.rol || "usuario").toUpperCase()}</span>
                </div>
              </div>
              <div className="form-row">
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: "#181616", borderRadius: 10 }}>
                  <i className="fa-regular fa-envelope" style={{ color: "#6a6a6b", fontSize: 18 }}></i>
                  <div><p style={{ fontSize: 12, color: "#8992a7", margin: 0 }}>Email</p><p style={{ fontSize: 14, fontWeight: 500, margin: "2px 0 0 0", color: "#c5c9c5" }}>{user?.email}</p></div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: "#181616", borderRadius: 10 }}>
                  <i className="fa-solid fa-phone" style={{ color: "#6a6a6b", fontSize: 18 }}></i>
                  <div><p style={{ fontSize: 12, color: "#8992a7", margin: 0 }}>Teléfono</p><p style={{ fontSize: 14, fontWeight: 500, margin: "2px 0 0 0", color: "#c5c9c5" }}>{user?.telefono || "-"}</p></div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: "#181616", borderRadius: 10 }}>
                  <i className="fa-regular fa-calendar" style={{ color: "#6a6a6b", fontSize: 18 }}></i>
                  <div><p style={{ fontSize: 12, color: "#8992a7", margin: 0 }}>Creado</p><p style={{ fontSize: 14, fontWeight: 500, margin: "2px 0 0 0", color: "#c5c9c5" }}>{user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : "-"}</p></div>
                </div>
              </div>
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div className="card" style={{ padding: 24, marginBottom: 16 }}>
              <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16, color: "#c5c9c5" }}>Seguridad</h3>
              {!showPasswordForm ? (
                <button onClick={() => setShowPasswordForm(true)} className="btn-primary" style={{ width: "100%", justifyContent: "center" }}>
                  <i className="fa-solid fa-key"></i> Cambiar Contraseña
                </button>
              ) : (
                <form onSubmit={handleSubmitPassword}>
                  <div className="form-group">
                    <label>Contraseña Actual</label>
                    <input type="password" name="passwordActual" value={passwordData.passwordActual} onChange={handlePasswordChange}
                      className={errors.passwordActual ? "error" : ""} />
                    {errors.passwordActual && <p style={{ fontSize: 12, color: "#e46885", marginTop: 2 }}>{errors.passwordActual}</p>}
                  </div>
                  <div className="form-group">
                    <label>Nueva Contraseña</label>
                    <input type="password" name="nuevaPassword" value={passwordData.nuevaPassword} onChange={handlePasswordChange}
                      className={errors.nuevaPassword ? "error" : ""} />
                    {errors.nuevaPassword && <p style={{ fontSize: 12, color: "#e46885", marginTop: 2 }}>{errors.nuevaPassword}</p>}
                  </div>
                  <div className="form-group">
                    <label>Confirmar Contraseña</label>
                    <input type="password" name="confirmarPassword" value={passwordData.confirmarPassword} onChange={handlePasswordChange}
                      className={errors.confirmarPassword ? "error" : ""} />
                    {errors.confirmarPassword && <p style={{ fontSize: 12, color: "#e46885", marginTop: 2 }}>{errors.confirmarPassword}</p>}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" onClick={() => { setShowPasswordForm(false); setPasswordData({ passwordActual: "", nuevaPassword: "", confirmarPassword: "" }); setErrors({}); }} className="btn-secondary" style={{ flex: 1 }}>Cancelar</button>
                    <button type="submit" disabled={savingPassword} className="btn-primary" style={{ flex: 1 }}>{savingPassword ? "Actualizando..." : "Actualizar"}</button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Configuracion;
