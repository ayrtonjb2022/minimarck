import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { contabilidadAPI } from "../../api/contabilidad";
import Modal from "../../components/common/Modal";
import { toast } from "react-toastify";
import { formatCurrency, formatDateShort } from "../../utils/formatters";

const today = () => new Date().toISOString().slice(0, 10);

const tipoLabels = {
  prestamo_mp: "MercadoPago",
  prestamo_bancario: "Préstamo Bancario",
  prestamo_personal: "Préstamo Personal",
  proveedor: "Proveedor",
  otro: "Otro",
};

const tipoColors = {
  prestamo_mp: "#009ee3",
  prestamo_bancario: "#2563eb",
  prestamo_personal: "#7c3aed",
  proveedor: "#d97706",
  otro: "#64748b",
};

const estadoColors = {
  activo: { bg: "#dcfce7", text: "#166534" },
  pagado: { bg: "#e2e8f0", text: "#475569" },
  vencido: { bg: "#fee2e2", text: "#991b1b" },
};

const emptyDeuda = {
  nombre: "", tipo: "prestamo_mp", montoOriginal: "", tasaInteres: "",
  cuotasTotales: "", montoCuota: "", fechaInicio: today(), fechaVencimiento: "",
  contactoNombre: "", contactoTelefono: "", notas: "",
};

const emptyPago = { monto: "", fecha: today(), metodoPago: "efectivo", numeroCuota: "", observaciones: "" };

const DeudasContabilidad = () => {
  const queryClient = useQueryClient();
  const [modalDeudaOpen, setModalDeudaOpen] = useState(false);
  const [modalPagoOpen, setModalPagoOpen] = useState(false);
  const [modalDetailOpen, setModalDetailOpen] = useState(false);
  const [selectedDeuda, setSelectedDeuda] = useState(null);
  const [deudaForm, setDeudaForm] = useState(emptyDeuda);
  const [pagoForm, setPagoForm] = useState(emptyPago);
  const [filterTipo, setFilterTipo] = useState("");
  const [filterEstado, setFilterEstado] = useState("");

  const { data: deudas, isLoading } = useQuery({
    queryKey: ["deudasContabilidad", filterTipo, filterEstado],
    queryFn: () => contabilidadAPI.listarDeudas({ tipo: filterTipo, estado: filterEstado }).then((r) => r.data.data),
  });

  const { data: pagosData } = useQuery({
    queryKey: ["pagosDeuda", selectedDeuda?.id],
    queryFn: () => contabilidadAPI.listarPagosDeuda(selectedDeuda.id).then((r) => r.data.data),
    enabled: !!selectedDeuda,
  });

  const saveDeudaMutation = useMutation({
    mutationFn: (data) => contabilidadAPI.crearDeuda(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deudasContabilidad"] });
      toast.success("Deuda registrada exitosamente");
      setModalDeudaOpen(false);
      setDeudaForm(emptyDeuda);
    },
    onError: (e) => toast.error(e.response?.data?.message || "Error al registrar deuda"),
  });

  const updateDeudaMutation = useMutation({
    mutationFn: ({ id, data }) => contabilidadAPI.actualizarDeuda(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deudasContabilidad"] });
      toast.success("Deuda actualizada");
    },
    onError: (e) => toast.error(e.response?.data?.message || "Error al actualizar"),
  });

  const pagoMutation = useMutation({
    mutationFn: ({ id, data }) => contabilidadAPI.registrarPagoDeuda(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deudasContabilidad"] });
      queryClient.invalidateQueries({ queryKey: ["pagosDeuda"] });
      toast.success("Pago registrado exitosamente");
      setModalPagoOpen(false);
      setPagoForm(emptyPago);
    },
    onError: (e) => toast.error(e.response?.data?.message || "Error al registrar pago"),
  });

  const handleSaveDeuda = async () => {
    if (!deudaForm.nombre.trim() || !deudaForm.montoOriginal || !deudaForm.fechaInicio) {
      toast.warning("Nombre, monto y fecha son obligatorios");
      return;
    }
    await saveDeudaMutation.mutateAsync({
      ...deudaForm,
      montoOriginal: parseFloat(deudaForm.montoOriginal),
      tasaInteres: deudaForm.tasaInteres ? parseFloat(deudaForm.tasaInteres) : null,
      cuotasTotales: deudaForm.cuotasTotales ? parseInt(deudaForm.cuotasTotales) : null,
      montoCuota: deudaForm.montoCuota ? parseFloat(deudaForm.montoCuota) : null,
      fechaVencimiento: deudaForm.fechaVencimiento || null,
    });
  };

  const handleSavePago = async () => {
    if (!pagoForm.monto || parseFloat(pagoForm.monto) <= 0) {
      toast.warning("Ingresá un monto válido");
      return;
    }
    await pagoMutation.mutateAsync({
      id: selectedDeuda.id,
      data: {
        monto: parseFloat(pagoForm.monto),
        fecha: pagoForm.fecha,
        metodoPago: pagoForm.metodoPago,
        numeroCuota: pagoForm.numeroCuota ? parseInt(pagoForm.numeroCuota) : null,
        observaciones: pagoForm.observaciones || null,
      },
    });
  };

  const handleViewDetail = (deuda) => {
    setSelectedDeuda(deuda);
    setModalDetailOpen(true);
  };

  const handleOpenPago = (deuda) => {
    setSelectedDeuda(deuda);
    setPagoForm(emptyPago);
    setModalPagoOpen(true);
  };

  const handleToggleEstado = async (deuda) => {
    const nuevoEstado = deuda.estado === "activo" ? "vencido" : "activo";
    await updateDeudaMutation.mutateAsync({ id: deuda.id, data: { estado: nuevoEstado } });
  };

  const totalDeudas = (deudas || []).reduce((s, d) => s + parseFloat(d.saldoPendiente || 0), 0);

  return (
    <div>
      <div className="table-container" style={{ marginBottom: 20 }}>
        <div className="table-header">
          <h3>Deudas y Préstamos</h3>
          <div className="actions">
            <select value={filterTipo} onChange={(e) => setFilterTipo(e.target.value)} style={{ marginRight: 8 }}>
              <option value="">Todos los tipos</option>
              {Object.entries(tipoLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select value={filterEstado} onChange={(e) => setFilterEstado(e.target.value)} style={{ marginRight: 8 }}>
              <option value="">Todos los estados</option>
              <option value="activo">Activo</option>
              <option value="pagado">Pagado</option>
              <option value="vencido">Vencido</option>
            </select>
            <button onClick={() => { setDeudaForm(emptyDeuda); setModalDeudaOpen(true); }} className="btn-primary">
              <i className="fa-solid fa-plus"></i> Nueva Deuda
            </button>
          </div>
        </div>
      </div>

      {/* Resumen */}
      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <div className="stat-card" style={{ borderTop: "3px solid #ef4444" }}>
          <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Total pendiente</p>
          <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#dc2626" }}>{formatCurrency(totalDeudas)}</p>
        </div>
        <div className="stat-card" style={{ borderTop: "3px solid #22c55e" }}>
          <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Deudas activas</p>
          <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#16a34a" }}>
            {(deudas || []).filter((d) => d.estado === "activo").length}
          </p>
        </div>
        <div className="stat-card" style={{ borderTop: "3px solid #f59e0b" }}>
          <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Vencidas</p>
          <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#d97706" }}>
            {(deudas || []).filter((d) => d.estado === "vencido").length}
          </p>
        </div>
        <div className="stat-card" style={{ borderTop: "3px solid #94a3b8" }}>
          <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Pagadas</p>
          <p style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0", color: "#64748b" }}>
            {(deudas || []).filter((d) => d.estado === "pagado").length}
          </p>
        </div>
      </div>

      {/* Tabla */}
      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Tipo</th>
              <th>Monto Original</th>
              <th>Saldo Pendiente</th>
              <th>Cuotas</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7}>Cargando...</td></tr>
            ) : (deudas || []).length === 0 ? (
              <tr><td colSpan={7}>No hay deudas registradas</td></tr>
            ) : (
              deudas.map((d) => (
                <tr key={d.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{d.nombre}</div>
                    {d.contactoNombre && <div style={{ fontSize: 12, color: "#64748b" }}>Contacto: {d.contactoNombre}</div>}
                  </td>
                  <td>
                    <span style={{
                      display: "inline-block",
                      padding: "2px 10px",
                      borderRadius: 12,
                      fontSize: 12,
                      fontWeight: 600,
                      color: "#fff",
                      background: tipoColors[d.tipo] || "#64748b",
                    }}>
                      {tipoLabels[d.tipo] || d.tipo}
                    </span>
                  </td>
                  <td>{formatCurrency(d.montoOriginal)}</td>
                  <td style={{ fontWeight: 600, color: d.saldoPendiente > 0 ? "#dc2626" : "#16a34a" }}>
                    {formatCurrency(d.saldoPendiente)}
                  </td>
                  <td>{d.cuotasPagadas || 0}/{d.cuotasTotales || "—"}</td>
                  <td>
                    <span style={{
                      display: "inline-block",
                      padding: "2px 10px",
                      borderRadius: 12,
                      fontSize: 12,
                      fontWeight: 600,
                      background: estadoColors[d.estado]?.bg || "#e2e8f0",
                      color: estadoColors[d.estado]?.text || "#475569",
                    }}>
                      {d.estado === "activo" ? "Activo" : d.estado === "pagado" ? "Pagado" : "Vencido"}
                    </span>
                  </td>
                  <td>
                    <button onClick={() => handleViewDetail(d)} className="btn-secondary" style={{ padding: "4px 10px", marginRight: 6 }} title="Ver historial">
                      <i className="fa-solid fa-eye"></i>
                    </button>
                    {d.estado !== "pagado" && (
                      <>
                        <button onClick={() => handleOpenPago(d)} className="btn-primary" style={{ padding: "4px 10px", marginRight: 6 }} title="Registrar pago">
                          <i className="fa-solid fa-dollar-sign"></i>
                        </button>
                        <button onClick={() => handleToggleEstado(d)} className="btn-secondary" style={{ padding: "4px 10px" }} title={d.estado === "activo" ? "Marcar vencida" : "Reactivar"}>
                          <i className={`fa-solid fa-${d.estado === "activo" ? "exclamation-triangle" : "rotate-right"}`}></i>
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Modal nueva deuda */}
      <Modal isOpen={modalDeudaOpen} onClose={() => setModalDeudaOpen(false)} title="Nueva Deuda" size="md">
        <div className="form-group">
          <label>Nombre / Concepto</label>
          <input type="text" value={deudaForm.nombre} onChange={(e) => setDeudaForm({ ...deudaForm, nombre: e.target.value })} placeholder="Ej: Préstamo MercadoPago" />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="form-group">
            <label>Tipo</label>
            <select value={deudaForm.tipo} onChange={(e) => setDeudaForm({ ...deudaForm, tipo: e.target.value })}>
              {Object.entries(tipoLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Monto Original ($)</label>
            <input type="number" value={deudaForm.montoOriginal} onChange={(e) => setDeudaForm({ ...deudaForm, montoOriginal: e.target.value })} min="0" step="0.01" />
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <div className="form-group">
            <label>Tasa de interés % anual</label>
            <input type="number" value={deudaForm.tasaInteres} onChange={(e) => setDeudaForm({ ...deudaForm, tasaInteres: e.target.value })} min="0" step="0.01" placeholder="Opcional" />
          </div>
          <div className="form-group">
            <label>Cuotas totales</label>
            <input type="number" value={deudaForm.cuotasTotales} onChange={(e) => setDeudaForm({ ...deudaForm, cuotasTotales: e.target.value })} min="1" placeholder="Opcional" />
          </div>
          <div className="form-group">
            <label>Monto cuota ($)</label>
            <input type="number" value={deudaForm.montoCuota} onChange={(e) => setDeudaForm({ ...deudaForm, montoCuota: e.target.value })} min="0" step="0.01" placeholder="Opcional" />
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="form-group">
            <label>Fecha de inicio</label>
            <input type="date" value={deudaForm.fechaInicio} onChange={(e) => setDeudaForm({ ...deudaForm, fechaInicio: e.target.value })} />
          </div>
          <div className="form-group">
            <label>Fecha de vencimiento</label>
            <input type="date" value={deudaForm.fechaVencimiento} onChange={(e) => setDeudaForm({ ...deudaForm, fechaVencimiento: e.target.value })} />
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="form-group">
            <label>Nombre contacto</label>
            <input type="text" value={deudaForm.contactoNombre} onChange={(e) => setDeudaForm({ ...deudaForm, contactoNombre: e.target.value })} placeholder="A quién le debés" />
          </div>
          <div className="form-group">
            <label>Teléfono contacto</label>
            <input type="text" value={deudaForm.contactoTelefono} onChange={(e) => setDeudaForm({ ...deudaForm, contactoTelefono: e.target.value })} placeholder="Opcional" />
          </div>
        </div>
        <div className="form-group">
          <label>Notas</label>
          <textarea value={deudaForm.notas} onChange={(e) => setDeudaForm({ ...deudaForm, notas: e.target.value })} rows={2} placeholder="Detalles adicionales..." />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 20, paddingTop: 16, borderTop: "1px solid #363432" }}>
          <button onClick={() => setModalDeudaOpen(false)} className="btn-secondary">Cancelar</button>
          <button onClick={handleSaveDeuda} className="btn-primary" disabled={saveDeudaMutation.isPending}>
            {saveDeudaMutation.isPending ? "Guardando..." : "Crear Deuda"}
          </button>
        </div>
      </Modal>

      {/* Modal registrar pago */}
      <Modal isOpen={modalPagoOpen} onClose={() => setModalPagoOpen(false)} title={`Registrar Pago — ${selectedDeuda?.nombre || ""}`} size="sm">
        {selectedDeuda && (
          <div>
            <div style={{ background: "#f8fafc", borderRadius: 8, padding: 12, marginBottom: 16 }}>
              <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Saldo pendiente: <strong style={{ color: "#dc2626" }}>{formatCurrency(selectedDeuda.saldoPendiente)}</strong></p>
              {selectedDeuda.montoCuota && <p style={{ fontSize: 13, color: "#64748b", margin: "4px 0 0" }}>Cuota mensual: <strong>{formatCurrency(selectedDeuda.montoCuota)}</strong></p>}
            </div>
            <div className="form-group">
              <label>Monto a pagar ($)</label>
              <input type="number" value={pagoForm.monto} onChange={(e) => setPagoForm({ ...pagoForm, monto: e.target.value })} min="0.01" step="0.01" max={selectedDeuda.saldoPendiente} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div className="form-group">
                <label>Fecha</label>
                <input type="date" value={pagoForm.fecha} onChange={(e) => setPagoForm({ ...pagoForm, fecha: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Método de pago</label>
                <select value={pagoForm.metodoPago} onChange={(e) => setPagoForm({ ...pagoForm, metodoPago: e.target.value })}>
                  <option value="efectivo">Efectivo</option>
                  <option value="tarjeta">Tarjeta</option>
                  <option value="transferencia">Transferencia</option>
                </select>
              </div>
            </div>
            <div className="form-group">
              <label>Número de cuota (opcional)</label>
              <input type="number" value={pagoForm.numeroCuota} onChange={(e) => setPagoForm({ ...pagoForm, numeroCuota: e.target.value })} min="1" />
            </div>
            <div className="form-group">
              <label>Observaciones</label>
              <input type="text" value={pagoForm.observaciones} onChange={(e) => setPagoForm({ ...pagoForm, observaciones: e.target.value })} placeholder="Opcional" />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 20, paddingTop: 16, borderTop: "1px solid #363432" }}>
              <button onClick={() => setModalPagoOpen(false)} className="btn-secondary">Cancelar</button>
              <button onClick={handleSavePago} className="btn-primary" disabled={pagoMutation.isPending}>
                {pagoMutation.isPending ? "Guardando..." : "Registrar Pago"}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Modal detalle / historial de pagos */}
      <Modal isOpen={modalDetailOpen} onClose={() => { setModalDetailOpen(false); setSelectedDeuda(null); }} title={`Historial — ${selectedDeuda?.nombre || ""}`} size="lg">
        {selectedDeuda && (
          <div>
            <div className="stats-grid" style={{ marginBottom: 16 }}>
              <div className="stat-card">
                <p style={{ fontSize: 12, color: "#64748b", margin: 0 }}>Original</p>
                <p style={{ fontSize: 18, fontWeight: 700, margin: "2px 0 0" }}>{formatCurrency(selectedDeuda.montoOriginal)}</p>
              </div>
              <div className="stat-card">
                <p style={{ fontSize: 12, color: "#64748b", margin: 0 }}>Pendiente</p>
                <p style={{ fontSize: 18, fontWeight: 700, margin: "2px 0 0", color: "#dc2626" }}>{formatCurrency(selectedDeuda.saldoPendiente)}</p>
              </div>
              <div className="stat-card">
                <p style={{ fontSize: 12, color: "#64748b", margin: 0 }}>Cuotas</p>
                <p style={{ fontSize: 18, fontWeight: 700, margin: "2px 0 0" }}>{selectedDeuda.cuotasPagadas || 0}/{selectedDeuda.cuotasTotales || "—"}</p>
              </div>
            </div>

            <h4 style={{ margin: "0 0 8px", fontSize: 14 }}>Pagos realizados</h4>
            {(pagosData || []).length === 0 ? (
              <p style={{ color: "#94a3b8", fontStyle: "italic" }}>No hay pagos registrados</p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 12, color: "#64748b", borderBottom: "1px solid #e2e8f0" }}>Fecha</th>
                    <th style={{ textAlign: "right", padding: "8px 12px", fontSize: 12, color: "#64748b", borderBottom: "1px solid #e2e8f0" }}>Monto</th>
                    <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 12, color: "#64748b", borderBottom: "1px solid #e2e8f0" }}>Método</th>
                    <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 12, color: "#64748b", borderBottom: "1px solid #e2e8f0" }}>Cuota</th>
                    <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 12, color: "#64748b", borderBottom: "1px solid #e2e8f0" }}>Observaciones</th>
                  </tr>
                </thead>
                <tbody>
                  {(pagosData || []).map((p) => (
                    <tr key={p.id}>
                      <td style={{ padding: "10px 12px", fontSize: 13 }}>{formatDateShort(p.fecha)}</td>
                      <td style={{ padding: "10px 12px", fontSize: 13, textAlign: "right", fontWeight: 600, color: "#16a34a" }}>{formatCurrency(p.monto)}</td>
                      <td style={{ padding: "10px 12px", fontSize: 13, textTransform: "capitalize" }}>{p.metodoPago}</td>
                      <td style={{ padding: "10px 12px", fontSize: 13 }}>{p.numeroCuota || "—"}</td>
                      <td style={{ padding: "10px 12px", fontSize: 13, color: "#64748b" }}>{p.observaciones || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
};

export default DeudasContabilidad;
