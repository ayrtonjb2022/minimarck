import React, { useState, useEffect } from "react";
import { deudoresAPI } from "../api/deudores";
import { Link } from "react-router-dom";
import Modal from "../components/common/Modal";
import ConfirmDialog from "../components/common/ConfirmDialog";
import DebtorForm from "../components/forms/DebtorForm";
import PaymentForm from "../components/forms/PaymentForm";
import BoletaPago from "../components/common/BoletaPago";
import { toast } from "react-toastify";
import { formatCurrency, formatDate } from "../utils/formatters";

const Deudores = () => {
  const [deudores, setDeudores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({});
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState({});
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedDeudor, setSelectedDeudor] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deudorToDelete, setDeudorToDelete] = useState(null);
  const [pagoModalOpen, setPagoModalOpen] = useState(false);
  const [deudorForPago, setDeudorForPago] = useState(null);
  const [detalleModalOpen, setDetalleModalOpen] = useState(false);
  const [deudorDetalle, setDeudorDetalle] = useState(null);
  const [pagosHistorial, setPagosHistorial] = useState([]);
  const [boletaModalOpen, setBoletaModalOpen] = useState(false);
  const [boletaData, setBoletaData] = useState(null);

  useEffect(() => { fetchDeudores(); }, [search, filters]);

  const fetchDeudores = async (page = 1) => {
    try { setLoading(true); const params = { page, limit: 20, search, ...filters }; const response = await deudoresAPI.listar(params); setDeudores(response.data.data); setPagination(response.data.pagination); }
    catch (error) { toast.error("Error al cargar deudores"); } finally { setLoading(false); }
  };

  const handleCreate = () => { setSelectedDeudor(null); setModalOpen(true); };
  const handleEdit = (deudor) => { setSelectedDeudor(deudor); setModalOpen(true); };
  const handleDelete = (deudor) => { setDeudorToDelete(deudor); setConfirmOpen(true); };

  const confirmDelete = async () => {
    try { await deudoresAPI.eliminar(deudorToDelete.id); toast.success("Deudor eliminado exitosamente"); fetchDeudores(); }
    catch (error) { toast.error("Error al eliminar deudor"); }
    setConfirmOpen(false);
  };

  const handlePago = (deudor) => { setDeudorForPago(deudor); setPagoModalOpen(true); };
  const handleVerDetalle = async (deudor) => {
    try {
      const response = await deudoresAPI.obtener(deudor.id);
      setDeudorDetalle(response.data?.data);
      const pagosRes = await deudoresAPI.pagos(deudor.id);
      setPagosHistorial(pagosRes.data?.data || []);
    } catch (error) {
      toast.error("Error al cargar detalle del deudor");
    }
    setDetalleModalOpen(true);
  };

  const handleSave = async (formData) => {
    try {
      if (selectedDeudor) { await deudoresAPI.actualizar(selectedDeudor.id, formData); toast.success("Deudor actualizado exitosamente"); }
      else { await deudoresAPI.crear(formData); toast.success("Deudor creado exitosamente"); }
      setModalOpen(false); fetchDeudores();
    } catch (error) { toast.error(error.response?.data?.message || "Error al guardar deudor"); }
  };

  const handleRegistrarPago = async (data) => {
    try {
      const res = await deudoresAPI.registrarPago(deudorForPago.id, data);
      const result = res.data?.data;
      const pagadoCompleto = result?.pagadoCompleto;

      if (pagadoCompleto) {
        toast.success("¡Deuda pagada completamente!");
        setPagoModalOpen(false);
        // Traer todos los pagos y abrir boleta
        const pagosRes = await deudoresAPI.pagos(deudorForPago.id);
        setBoletaData({
          deudor: { ...deudorForPago, notas: result.notas, deudaTotal: result.deudaTotal },
          pagos: pagosRes.data?.data || [],
        });
        setBoletaModalOpen(true);
        fetchDeudores();
      } else {
        toast.success("Pago registrado exitosamente");
        setPagoModalOpen(false);
        fetchDeudores();
      }
    } catch (error) {
      toast.error(error.response?.data?.message || "Error al registrar pago");
    }
  };



  const p = pagination?.total
    ? (() => {
        const page = pagination.page || pagination.currentPage || 1;
        const limit = pagination.limit || 20;
        const total = pagination.total || 0;
        const totalPages = pagination.totalPages || pagination.pageCount || 1;
        return { currentPage: page, totalPages, total, from: (page - 1) * limit + 1, to: Math.min(page * limit, total) };
      })()
    : null;

  const totalDeudores = pagination?.total || deudores.length;
  const sumDeudaTotal = deudores.reduce((s, d) => s + (d.deudaTotal || 0), 0);
  const promedio = deudores.length > 0 ? sumDeudaTotal / deudores.length : 0;

  return (
    <div>
      <div className="stats-grid">
        <div className="stat-card">
          <div className="label"><span>Total Clientes</span><i className="fa-solid fa-users"></i></div>
          <div className="value">{totalDeudores}</div>
        </div>
        <div className="stat-card">
          <div className="label"><span>Deuda Total</span><i className="fa-solid fa-hand-holding-dollar"></i></div>
          <div className="value">{formatCurrency(sumDeudaTotal)}</div>
        </div>
        <div className="stat-card">
          <div className="label"><span>Promedio Deuda</span><i className="fa-solid fa-file-invoice"></i></div>
          <div className="value">{formatCurrency(promedio)}</div>
        </div>
      </div>

      <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:12, marginBottom:20}}>
        <div style={{display:"flex", gap:10, flexWrap:"wrap"}}>
          <input type="text" placeholder="🔍 Buscar por nombre o documento..." value={search} onChange={(e) => setSearch(e.target.value)} className="filter-input" style={{width:240}} />
          <select value={filters.conDeuda || ""} onChange={(e) => setFilters({ ...filters, conDeuda: e.target.value || undefined })} className="filter-input">
            <option value="">Todos</option>
            <option value="true">Solo con deuda</option>
          </select>
        </div>
        <div style={{display:"flex", gap:10}}>
          <Link to="/pos" className="btn-secondary"><i className="fa-solid fa-truck"></i> Ir a Punto de Venta</Link>
          <button className="btn-primary" onClick={handleCreate}><i className="fa-solid fa-plus"></i> Nuevo Cliente</button>
        </div>
      </div>

      <div className="table-container">
        <div className="table-header">
          <h3>Clientes</h3>
          <div className="actions" />
        </div>
        <table>
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Teléfono</th>
              <th>Deuda Total</th>
              <th>Último Pago</th>
              <th>Días Vencido</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} style={{textAlign:"center", padding:32, color:"#94a3b8"}}>Cargando...</td></tr>
            ) : deudores.length === 0 ? (
              <tr><td colSpan={6} style={{textAlign:"center", padding:32, color:"#94a3b8"}}>No hay deudores registrados</td></tr>
            ) : deudores.map((row) => (
              <tr key={row.id}>
                <td>{row.nombre}</td>
                <td>{row.telefono || "-"}</td>
                <td>{formatCurrency(row.deudaTotal || 0)}</td>
                <td>{row.ultimoPago ? formatDate(row.ultimoPago) : "-"}</td>
                <td>{row.diasVencido != null ? row.diasVencido : "-"}</td>
                <td>
                  <div style={{display:"flex", gap:6, alignItems:"center", flexWrap:"wrap"}}>
                    <button onClick={() => handleVerDetalle(row)} style={{padding:"6px 10px", border:"none", background:"transparent", color:"#3b82f6", cursor:"pointer", borderRadius:6, fontSize:16}} title="Ver detalle">
                      <i className="fa-solid fa-eye"></i>
                    </button>
                    {row.deudaPendiente > 0 && (
                      <button className="btn-secondary" onClick={() => handlePago(row)} style={{padding:"4px 12px", fontSize:12}}>
                        <i className="fa-solid fa-dollar-sign"></i> Pagar
                      </button>
                    )}
                    <button onClick={() => handleEdit(row)} style={{padding:"6px 10px", border:"none", background:"transparent", color:"#2563eb", cursor:"pointer", borderRadius:6, fontSize:16}} title="Editar">
                      <i className="fa-solid fa-edit"></i>
                    </button>
                    <button onClick={() => handleDelete(row)} style={{padding:"6px 10px", border:"none", background:"transparent", color:"#ef4444", cursor:"pointer", borderRadius:6, fontSize:16}} title="Eliminar">
                      <i className="fa-solid fa-trash"></i>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {p && (
          <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 22px", borderTop:"1px solid #e9edf2"}}>
            <span style={{fontSize:13, color:"#64748b"}}>Mostrando {p.from} - {p.to} de {p.total}</span>
            <div style={{display:"flex", gap:8, alignItems:"center"}}>
              <button onClick={() => fetchDeudores(p.currentPage - 1)} disabled={p.currentPage === 1}
                style={{padding:"6px 12px", border:"1px solid #e2e8f0", borderRadius:6, background:"#fff", cursor:p.currentPage === 1 ? "not-allowed" : "pointer", fontSize:13, opacity:p.currentPage === 1 ? 0.5 : 1}}>
                <i className="fa-solid fa-chevron-left"></i>
              </button>
              <span style={{fontSize:13, color:"#475569", padding:"0 8px"}}>{p.currentPage} / {p.totalPages}</span>
              <button onClick={() => fetchDeudores(p.currentPage + 1)} disabled={p.currentPage >= p.totalPages}
                style={{padding:"6px 12px", border:"1px solid #e2e8f0", borderRadius:6, background:"#fff", cursor:p.currentPage >= p.totalPages ? "not-allowed" : "pointer", fontSize:13, opacity:p.currentPage >= p.totalPages ? 0.5 : 1}}>
                <i className="fa-solid fa-chevron-right"></i>
              </button>
            </div>
          </div>
        )}
      </div>

      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title={selectedDeudor ? "Editar Cliente" : "Nuevo Cliente"} size="lg">
        <DebtorForm deudor={selectedDeudor} onSave={handleSave} onCancel={() => setModalOpen(false)} />
      </Modal>
      <Modal isOpen={pagoModalOpen} onClose={() => setPagoModalOpen(false)} title="Registrar Pago">
        <PaymentForm deudor={deudorForPago} onSave={handleRegistrarPago} onCancel={() => setPagoModalOpen(false)} />
      </Modal>
      <Modal isOpen={detalleModalOpen} onClose={() => setDetalleModalOpen(false)} title="Detalle del Cliente" size="lg">
        {deudorDetalle && <DeudorDetalle deudor={deudorDetalle} pagos={pagosHistorial} />}
      </Modal>
      <Modal isOpen={boletaModalOpen} onClose={() => setBoletaModalOpen(false)} title="Boleta de Pago" size="lg">
        {boletaData && <BoletaPago deudor={boletaData.deudor} pagos={boletaData.pagos} onClose={() => setBoletaModalOpen(false)} />}
      </Modal>
      <ConfirmDialog isOpen={confirmOpen} onClose={() => setConfirmOpen(false)} onConfirm={confirmDelete}
        title="Eliminar Cliente" message={`¿Estás seguro de eliminar al cliente "${deudorToDelete?.nombre}"?`} />
    </div>
  );
};

const DeudorDetalle = ({ deudor, pagos }) => (
  <div>
    <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginBottom:16}}>
      <div><div style={{fontSize:13, color:"#64748b", marginBottom:4}}>Cliente</div><div style={{fontWeight:500}}>{deudor.nombre}</div></div>
      <div><div style={{fontSize:13, color:"#64748b", marginBottom:4}}>Documento</div><div style={{fontWeight:500}}>{deudor.documento || "-"}</div></div>
      <div><div style={{fontSize:13, color:"#64748b", marginBottom:4}}>Teléfono</div><div style={{fontWeight:500}}>{deudor.telefono || "-"}</div></div>
      <div><div style={{fontSize:13, color:"#64748b", marginBottom:4}}>Email</div><div style={{fontWeight:500}}>{deudor.email || "-"}</div></div>
      <div><div style={{fontSize:13, color:"#64748b", marginBottom:4}}>Dirección</div><div style={{fontWeight:500}}>{deudor.direccion || "-"}</div></div>
      <div><div style={{fontSize:13, color:"#64748b", marginBottom:4}}>Límite de Crédito</div><div style={{fontWeight:500}}>{formatCurrency(deudor.limiteCredito || 0)}</div></div>
      <div><div style={{fontSize:13, color:"#64748b", marginBottom:4}}>Deuda Total</div><div style={{fontSize:20, fontWeight:700, color:"#2563eb"}}>{formatCurrency(deudor.deudaTotal || 0)}</div></div>
      <div><div style={{fontSize:13, color:"#64748b", marginBottom:4}}>Deuda Pendiente</div><div style={{fontSize:20, fontWeight:700, color:"#ef4444"}}>{formatCurrency(deudor.deudaPendiente || 0)}</div></div>
    </div>
    {pagos && pagos.length > 0 && (
      <div style={{borderTop:"1px solid #e9edf2", paddingTop:16, marginBottom:16}}>
        <h4 style={{fontWeight:600, fontSize:14, marginBottom:12}}>Historial de Pagos</h4>
        <table style={{width:"100%", borderCollapse:"collapse", fontSize:14}}>
          <thead>
            <tr style={{background:"#f8fafc"}}>
              <th style={{textAlign:"left", padding:"10px 16px", fontWeight:600, color:"#475569", fontSize:12, textTransform:"uppercase", letterSpacing:"0.4px"}}>Fecha</th>
              <th style={{textAlign:"left", padding:"10px 16px", fontWeight:600, color:"#475569", fontSize:12, textTransform:"uppercase", letterSpacing:"0.4px"}}>Monto</th>
              <th style={{textAlign:"left", padding:"10px 16px", fontWeight:600, color:"#475569", fontSize:12, textTransform:"uppercase", letterSpacing:"0.4px"}}>Método</th>
              <th style={{textAlign:"left", padding:"10px 16px", fontWeight:600, color:"#475569", fontSize:12, textTransform:"uppercase", letterSpacing:"0.4px"}}>Observaciones</th>
            </tr>
          </thead>
          <tbody>
            {pagos.map((p, i) => (
              <tr key={i}>
                <td style={{padding:"10px 16px", borderBottom:"1px solid #f1f5f9"}}>{formatDate(p.fecha || p.createdAt)}</td>
                <td style={{padding:"10px 16px", borderBottom:"1px solid #f1f5f9"}}>{formatCurrency(p.monto)}</td>
                <td style={{padding:"10px 16px", borderBottom:"1px solid #f1f5f9"}}>{p.metodoPago || "-"}</td>
                <td style={{padding:"10px 16px", borderBottom:"1px solid #f1f5f9"}}>{p.observaciones || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
    {deudor.notas && (
      <div style={{borderTop:"1px solid #e9edf2", paddingTop:16}}>
        <h4 style={{fontWeight:600, fontSize:14, marginBottom:12}}>Historial de compras a crédito</h4>
        <div style={{background:"#f8fafc", borderRadius:12, padding:12, fontSize:13, color:"#475569", whiteSpace:"pre-wrap", fontFamily:"monospace", maxHeight:240, overflowY:"auto", lineHeight:1.6}}>{deudor.notas}</div>
      </div>
    )}
  </div>
);

export default Deudores;
