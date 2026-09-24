import React, { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { contabilidadAPI } from "../../api/contabilidad";
import Modal from "../../components/common/Modal";
import { toast } from "react-toastify";
import { formatCurrency, formatDateShort } from "../../utils/formatters";

const tipoLabels = { ingreso: "Ingreso", egreso: "Egreso", ajuste: "Ajuste", apertura: "Apertura" };
const tipoColors = { ingreso: "#22c55e", egreso: "#ef4444", ajuste: "#f59e0b", apertura: "#3b82f6" };

const today = () => new Date().toISOString().slice(0, 10);

const emptyDetalle = () => ({ cuentaContableId: "", debe: "0", haber: "0", descripcion: "" });
const emptyForm = { fecha: today(), descripcion: "", tipo: "ingreso", referencia: "", detalles: [emptyDetalle(), emptyDetalle()] };

const AsientosContables = () => {
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [selectedAsiento, setSelectedAsiento] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ fechaInicio: "", fechaFin: "", tipo: "" });

  const { data: cuentasData } = useQuery({
    queryKey: ["cuentasContables"],
    queryFn: () => contabilidadAPI.listarCuentas().then((r) => r.data.data),
  });

  const allCuentas = Object.values(cuentasData || {}).flat();

  const { data: asientosData, isLoading } = useQuery({
    queryKey: ["asientosContables", page, filters],
    queryFn: () => contabilidadAPI.listarAsientos({ page, limit: 20, ...filters }).then((r) => r.data),
  });

  const asientos = asientosData?.data || [];
  const pagination = asientosData?.pagination || {};

  const saveMutation = useMutation({
    mutationFn: (data) => contabilidadAPI.crearAsiento(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["asientosContables"] });
      toast.success("Asiento creado exitosamente");
      setModalOpen(false);
      setForm(emptyForm);
    },
    onError: (e) => toast.error(e.response?.data?.message || "Error al crear asiento"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => contabilidadAPI.eliminarAsiento(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["asientosContables"] });
      toast.success("Asiento eliminado");
      setDetailModalOpen(false);
    },
    onError: (e) => toast.error(e.response?.data?.message || "Error al eliminar"),
  });

  const handleAddLine = () => {
    setForm({ ...form, detalles: [...form.detalles, emptyDetalle()] });
  };

  const handleRemoveLine = (idx) => {
    if (form.detalles.length <= 2) {
      toast.warning("Un asiento debe tener al menos 2 líneas");
      return;
    }
    const newDetalles = form.detalles.filter((_, i) => i !== idx);
    setForm({ ...form, detalles: newDetalles });
  };

  const handleLineChange = (idx, field, value) => {
    const newDetalles = [...form.detalles];
    newDetalles[idx] = { ...newDetalles[idx], [field]: value };
    setForm({ ...form, detalles: newDetalles });
  };

  const totalDebe = form.detalles.reduce((s, d) => s + parseFloat(d.debe || 0), 0);
  const totalHaber = form.detalles.reduce((s, d) => s + parseFloat(d.haber || 0), 0);
  const isValid = totalDebe > 0 && Math.abs(totalDebe - totalHaber) < 0.01 && form.detalles.length >= 2 && form.descripcion.trim();

  const handleSave = async () => {
    if (!isValid) {
      toast.warning("Verificá que debe y haber sean iguales, y que tengas al menos 2 líneas con monto");
      return;
    }
    const payload = {
      fecha: form.fecha,
      descripcion: form.descripcion,
      tipo: form.tipo,
      referencia: form.referencia || null,
      detalles: form.detalles.map((d) => ({
        cuentaContableId: parseInt(d.cuentaContableId),
        debe: parseFloat(d.debe || 0),
        haber: parseFloat(d.haber || 0),
        descripcion: d.descripcion || null,
      })),
    };
    await saveMutation.mutateAsync(payload);
  };

  const handleViewDetail = async (asiento) => {
    try {
      const res = await contabilidadAPI.obtenerAsiento(asiento.id);
      setSelectedAsiento(res.data.data);
      setDetailModalOpen(true);
    } catch {
      toast.error("Error al cargar detalles");
    }
  };

  return (
    <div>
      <div className="table-container" style={{ marginBottom: 20 }}>
        <div className="table-header">
          <h3>Asientos Contables</h3>
          <div className="actions">
            <select value={filters.tipo} onChange={(e) => setFilters({ ...filters, tipo: e.target.value })} style={{ marginRight: 8 }}>
              <option value="">Todos los tipos</option>
              <option value="ingreso">Ingreso</option>
              <option value="egreso">Egreso</option>
              <option value="ajuste">Ajuste</option>
              <option value="apertura">Apertura</option>
            </select>
            <input type="date" value={filters.fechaInicio} onChange={(e) => setFilters({ ...filters, fechaInicio: e.target.value })} style={{ marginRight: 8 }} placeholder="Desde" />
            <input type="date" value={filters.fechaFin} onChange={(e) => setFilters({ ...filters, fechaFin: e.target.value })} style={{ marginRight: 8 }} placeholder="Hasta" />
            <button onClick={() => setModalOpen(true)} className="btn-primary">
              <i className="fa-solid fa-plus"></i> Crear Asiento
            </button>
          </div>
        </div>
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Descripción</th>
              <th>Tipo</th>
              <th>Monto</th>
              <th>Referencia</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={6}>Cargando...</td></tr>
            ) : asientos.length === 0 ? (
              <tr><td colSpan={6}>No hay asientos contables registrados</td></tr>
            ) : (
              asientos.map((a) => (
                <tr key={a.id}>
                  <td>{formatDateShort(a.fecha)}</td>
                  <td style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.descripcion}</td>
                  <td>
                    <span style={{ color: tipoColors[a.tipo] || "#64748b", fontWeight: 600, fontSize: 13 }}>
                      {tipoLabels[a.tipo] || a.tipo}
                    </span>
                  </td>
                  <td style={{ fontWeight: 600 }}>{formatCurrency(a.montoTotal)}</td>
                  <td style={{ fontSize: 13, color: "#64748b" }}>{a.referencia || "—"}</td>
                  <td>
                    <button onClick={() => handleViewDetail(a)} className="btn-secondary" style={{ padding: "4px 10px", marginRight: 6 }}>
                      <i className="fa-solid fa-eye"></i>
                    </button>
                    <button onClick={() => { if (confirm("¿Eliminar este asiento?")) deleteMutation.mutate(a.id); }} className="btn-danger" style={{ padding: "4px 10px" }}>
                      <i className="fa-solid fa-trash"></i>
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {pagination && pagination.totalPages > 1 && (
          <div style={{ padding: "12px 22px", borderTop: "1px solid #e9edf2", display: "flex", justifyContent: "center", gap: "8px" }}>
            {Array.from({ length: pagination.totalPages }, (_, i) => i + 1).map((p) => (
              <button key={p} onClick={() => setPage(p)} className={p === pagination.page ? "btn-primary" : "btn-secondary"} style={{ padding: "4px 12px", fontSize: "12px" }}>
                {p}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Modal crear asiento */}
      <Modal isOpen={modalOpen} onClose={() => { setModalOpen(false); setForm(emptyForm); }} title="Nuevo Asiento Contable" size="lg">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <div className="form-group">
            <label>Fecha</label>
            <input type="date" value={form.fecha} onChange={(e) => setForm({ ...form, fecha: e.target.value })} />
          </div>
          <div className="form-group">
            <label>Tipo</label>
            <select value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value })}>
              <option value="ingreso">Ingreso</option>
              <option value="egreso">Egreso</option>
              <option value="ajuste">Ajuste</option>
              <option value="apertura">Apertura</option>
            </select>
          </div>
          <div className="form-group">
            <label>Referencia (opcional)</label>
            <input type="text" value={form.referencia} onChange={(e) => setForm({ ...form, referencia: e.target.value })} placeholder="Ej: Venta #123" />
          </div>
        </div>
        <div className="form-group">
          <label>Descripción</label>
          <input type="text" value={form.descripcion} onChange={(e) => setForm({ ...form, descripcion: e.target.value })} placeholder="Descripción del asiento..." />
        </div>

        {/* Detalles */}
        <div style={{ marginTop: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <label style={{ fontSize: 14, fontWeight: 600 }}>Líneas del asiento</label>
            <button onClick={handleAddLine} className="btn-secondary" style={{ padding: "4px 12px", fontSize: 13 }}>
              <i className="fa-solid fa-plus" style={{ marginRight: 4 }}></i>Agregar línea
            </button>
          </div>

          {form.detalles.map((det, idx) => (
            <div key={idx} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr auto", gap: 8, marginBottom: 8, alignItems: "center" }}>
              <select value={det.cuentaContableId} onChange={(e) => handleLineChange(idx, "cuentaContableId", e.target.value)} style={{ fontSize: 13 }}>
                <option value="">Seleccionar cuenta</option>
                {allCuentas.map((c) => (
                  <option key={c.id} value={c.id}>{c.codigo} - {c.nombre}</option>
                ))}
              </select>
              <input type="number" value={det.debe} onChange={(e) => handleLineChange(idx, "debe", e.target.value)} placeholder="$Debe" style={{ fontSize: 13 }} min="0" step="0.01" />
              <input type="number" value={det.haber} onChange={(e) => handleLineChange(idx, "haber", e.target.value)} placeholder="$Haber" style={{ fontSize: 13 }} min="0" step="0.01" />
              <input type="text" value={det.descripcion} onChange={(e) => handleLineChange(idx, "descripcion", e.target.value)} placeholder="Detalle" style={{ fontSize: 13 }} />
              <button onClick={() => handleRemoveLine(idx)} style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", padding: 4, fontSize: 14 }}>
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>
          ))}

          {/* Totales */}
          <div style={{ display: "flex", gap: 20, marginTop: 12, padding: "10px 16px", background: totalDebe === totalHaber && totalDebe > 0 ? "#f0fdf4" : "#fef2f2", borderRadius: 8 }}>
            <span style={{ fontSize: 14 }}>Total Debe: <strong>{formatCurrency(totalDebe)}</strong></span>
            <span style={{ fontSize: 14 }}>Total Haber: <strong>{formatCurrency(totalHaber)}</strong></span>
            <span style={{ fontSize: 14, color: totalDebe === totalHaber && totalDebe > 0 ? "#16a34a" : "#dc2626", fontWeight: 600 }}>
              {totalDebe === totalHaber && totalDebe > 0 ? "✓ Balanceado" : "✗ No balanceado"}
            </span>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 20, paddingTop: 16, borderTop: "1px solid #363432" }}>
          <button type="button" onClick={() => { setModalOpen(false); setForm(emptyForm); }} className="btn-secondary">Cancelar</button>
          <button type="button" onClick={handleSave} className="btn-primary" disabled={!isValid || saveMutation.isPending}>
            {saveMutation.isPending ? "Guardando..." : "Crear Asiento"}
          </button>
        </div>
      </Modal>

      {/* Modal detalle */}
      <Modal isOpen={detailModalOpen} onClose={() => { setDetailModalOpen(false); setSelectedAsiento(null); }} title="Detalle del Asiento" size="lg">
        {selectedAsiento && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
              <div>
                <span style={{ fontSize: 12, color: "#64748b" }}>Fecha</span>
                <p style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{formatDateShort(selectedAsiento.fecha)}</p>
              </div>
              <div>
                <span style={{ fontSize: 12, color: "#64748b" }}>Tipo</span>
                <p style={{ fontSize: 14, fontWeight: 600, color: tipoColors[selectedAsiento.tipo], margin: 0 }}>{tipoLabels[selectedAsiento.tipo]}</p>
              </div>
              <div>
                <span style={{ fontSize: 12, color: "#64748b" }}>Monto Total</span>
                <p style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{formatCurrency(selectedAsiento.montoTotal)}</p>
              </div>
            </div>
            <p style={{ fontSize: 14, color: "#475569", marginBottom: 16 }}>{selectedAsiento.descripcion}</p>
            {selectedAsiento.referencia && (
              <p style={{ fontSize: 13, color: "#64748b", marginBottom: 16 }}>Ref: {selectedAsiento.referencia}</p>
            )}

            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 12, color: "#64748b", borderBottom: "1px solid #e2e8f0" }}>Cuenta</th>
                  <th style={{ textAlign: "right", padding: "8px 12px", fontSize: 12, color: "#64748b", borderBottom: "1px solid #e2e8f0" }}>Debe</th>
                  <th style={{ textAlign: "right", padding: "8px 12px", fontSize: 12, color: "#64748b", borderBottom: "1px solid #e2e8f0" }}>Haber</th>
                  <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 12, color: "#64748b", borderBottom: "1px solid #e2e8f0" }}>Detalle</th>
                </tr>
              </thead>
              <tbody>
                {(selectedAsiento.detalles || []).map((d) => (
                  <tr key={d.id}>
                    <td style={{ padding: "10px 12px", fontSize: 13 }}>{d.cuenta?.codigo} - {d.cuenta?.nombre}</td>
                    <td style={{ padding: "10px 12px", fontSize: 13, textAlign: "right", fontWeight: d.debe > 0 ? 600 : 400, color: d.debe > 0 ? "#0f172a" : "#94a3b8" }}>
                      {d.debe > 0 ? formatCurrency(d.debe) : "—"}
                    </td>
                    <td style={{ padding: "10px 12px", fontSize: 13, textAlign: "right", fontWeight: d.haber > 0 ? 600 : 400, color: d.haber > 0 ? "#0f172a" : "#94a3b8" }}>
                      {d.haber > 0 ? formatCurrency(d.haber) : "—"}
                    </td>
                    <td style={{ padding: "10px 12px", fontSize: 13, color: "#64748b" }}>{d.descripcion || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default AsientosContables;
