import React, { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { contabilidadAPI } from "../../api/contabilidad";
import Modal from "../../components/common/Modal";
import { toast } from "react-toastify";

const tipoLabels = {
  activo: "Activos",
  pasivo: "Pasivos",
  capital: "Capital",
  ingreso: "Ingresos",
  gasto: "Gastos",
};

const tipoColors = {
  activo: "#3b82f6",
  pasivo: "#ef4444",
  capital: "#a855f7",
  ingreso: "#22c55e",
  gasto: "#f59e0b",
};

const tipoIcons = {
  activo: "fa-solid fa-building",
  pasivo: "fa-solid fa-credit-card",
  capital: "fa-solid fa-landmark",
  ingreso: "fa-solid fa-arrow-trend-up",
  gasto: "fa-solid fa-arrow-trend-down",
};

const emptyForm = { codigo: "", nombre: "", tipo: "activo", descripcion: "", parentId: "" };

const CuentasContables = () => {
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [expanded, setExpanded] = useState({ activo: true, pasivo: true, capital: true, ingreso: true, gasto: true });

  const { data: cuentasData, isLoading } = useQuery({
    queryKey: ["cuentasContables"],
    queryFn: () => contabilidadAPI.listarCuentas().then((r) => r.data.data),
  });

  const saveMutation = useMutation({
    mutationFn: (formData) => {
      const payload = {
        ...formData,
        parentId: formData.parentId || null,
      };
      if (editing) return contabilidadAPI.actualizarCuenta(editing.id, payload);
      return contabilidadAPI.crearCuenta(payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cuentasContables"] });
      toast.success(editing ? "Cuenta actualizada" : "Cuenta creada");
      setModalOpen(false);
      setEditing(null);
      setForm(emptyForm);
    },
    onError: (e) => toast.error(e.response?.data?.message || "Error al guardar"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => contabilidadAPI.eliminarCuenta(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cuentasContables"] });
      toast.success("Cuenta desactivada");
    },
    onError: (e) => toast.error(e.response?.data?.message || "Error al desactivar"),
  });

  const handleOpenCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setModalOpen(true);
  };

  const handleOpenEdit = (cuenta) => {
    setEditing(cuenta);
    setForm({
      codigo: cuenta.codigo,
      nombre: cuenta.nombre,
      tipo: cuenta.tipo,
      descripcion: cuenta.descripcion || "",
      parentId: cuenta.parentId || "",
    });
    setModalOpen(true);
  };

  const handleSave = async () => {
    if (!form.codigo.trim() || !form.nombre.trim()) {
      toast.warning("Código y nombre son obligatorios");
      return;
    }
    await saveMutation.mutateAsync(form);
  };

  const toggleTipo = (tipo) => setExpanded((prev) => ({ ...prev, [tipo]: !prev[tipo] }));

  const allCuentas = Object.values(cuentasData || {}).flat();

  return (
    <div>
      <div className="table-container" style={{ marginBottom: 20 }}>
        <div className="table-header">
          <h3>Plan de Cuentas</h3>
          <div className="actions">
            <button onClick={handleOpenCreate} className="btn-primary">
              <i className="fa-solid fa-plus"></i> Nueva Cuenta
            </button>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="card"><p>Cargando cuentas...</p></div>
      ) : (
        Object.entries(tipoLabels).map(([tipo, label]) => {
          const cuentas = (cuentasData || {})[tipo] || [];
          if (cuentas.length === 0) return null;
          return (
            <div key={tipo} className="card" style={{ marginBottom: 12 }}>
              <div
                onClick={() => toggleTipo(tipo)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  cursor: "pointer",
                  padding: "4px 0",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <i className={tipoIcons[tipo]} style={{ color: tipoColors[tipo], fontSize: 16 }}></i>
                  <h3 style={{ margin: 0, fontSize: 15 }}>
                    {label}
                    <span style={{ fontSize: 12, fontWeight: 400, color: "#94a3b8", marginLeft: 8 }}>
                      ({cuentas.length})
                    </span>
                  </h3>
                </div>
                <i className={`fa-solid fa-chevron-${expanded[tipo] ? "up" : "down"}`} style={{ color: "#94a3b8", fontSize: 12 }}></i>
              </div>

              {expanded[tipo] && (
                <div style={{ marginTop: 12 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 12, color: "#64748b", borderBottom: "1px solid #e2e8f0" }}>Código</th>
                        <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 12, color: "#64748b", borderBottom: "1px solid #e2e8f0" }}>Nombre</th>
                        <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 12, color: "#64748b", borderBottom: "1px solid #e2e8f0" }}>Descripción</th>
                        <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 12, color: "#64748b", borderBottom: "1px solid #e2e8f0" }}>Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cuentas.map((c) => (
                        <tr key={c.id}>
                          <td style={{ padding: "10px 12px", fontSize: 14, fontWeight: 600, color: tipoColors[tipo] }}>{c.codigo}</td>
                          <td style={{ padding: "10px 12px", fontSize: 14 }}>{c.nombre}{c.parentId ? " (sub)" : ""}</td>
                          <td style={{ padding: "10px 12px", fontSize: 13, color: "#64748b" }}>{c.descripcion || "—"}</td>
                          <td style={{ padding: "10px 12px" }}>
                            <button onClick={() => handleOpenEdit(c)} className="btn-secondary" style={{ padding: "4px 10px", marginRight: 6 }}>
                              <i className="fa-solid fa-edit"></i>
                            </button>
                            <button onClick={() => { if (confirm("¿Desactivar esta cuenta?")) deleteMutation.mutate(c.id); }} className="btn-danger" style={{ padding: "4px 10px" }}>
                              <i className="fa-solid fa-trash"></i>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })
      )}

      {/* Modal crear/editar cuenta */}
      <Modal isOpen={modalOpen} onClose={() => { setModalOpen(false); setEditing(null); }} title={editing ? "Editar Cuenta" : "Nueva Cuenta"} size="md">
        <div className="form-group">
          <label>Código</label>
          <input
            type="text"
            value={form.codigo}
            onChange={(e) => setForm({ ...form, codigo: e.target.value })}
            placeholder="Ej: 1.1.01"
          />
        </div>
        <div className="form-group">
          <label>Nombre</label>
          <input
            type="text"
            value={form.nombre}
            onChange={(e) => setForm({ ...form, nombre: e.target.value })}
            placeholder="Ej: Caja chica"
          />
        </div>
        <div className="form-group">
          <label>Tipo</label>
          <select value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value })}>
            <option value="activo">Activo</option>
            <option value="pasivo">Pasivo</option>
            <option value="capital">Capital</option>
            <option value="ingreso">Ingreso</option>
            <option value="gasto">Gasto</option>
          </select>
        </div>
        <div className="form-group">
          <label>Cuenta padre (opcional)</label>
          <select value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })}>
            <option value="">Ninguna</option>
            {(allCuentas || []).map((c) => (
              <option key={c.id} value={c.id}>{c.codigo} - {c.nombre}</option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>Descripción (opcional)</label>
          <textarea
            value={form.descripcion}
            onChange={(e) => setForm({ ...form, descripcion: e.target.value })}
            rows={2}
            placeholder="Descripción de la cuenta..."
          />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 20, paddingTop: 16, borderTop: "1px solid #363432" }}>
          <button type="button" onClick={() => { setModalOpen(false); setEditing(null); }} className="btn-secondary">Cancelar</button>
          <button type="button" onClick={handleSave} className="btn-primary" disabled={saveMutation.isPending}>
            {saveMutation.isPending ? "Guardando..." : editing ? "Actualizar" : "Crear"}
          </button>
        </div>
      </Modal>
    </div>
  );
};

export default CuentasContables;
