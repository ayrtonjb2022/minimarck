import React, { useState, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { comprasAPI } from "../api/compras";
import { proveedoresAPI } from "../api/proveedores";
import { productosAPI } from "../api/productos";
import Modal from "../components/common/Modal";
import ConfirmDialog from "../components/common/ConfirmDialog";
import { toast } from "react-toastify";
import { formatCurrency, formatDate } from "../utils/formatters";
import { ESTADO_COMPRA_LABELS } from "../utils/constants";

const Compras = () => {

  const location = useLocation();
  const stockBajo = location.state?.stockBajo;

  const [compras, setCompras] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({});
  const [filters, setFilters] = useState({});
  const [proveedores, setProveedores] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [detalleOpen, setDetalleOpen] = useState(false);
  const [selectedCompra, setSelectedCompra] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [compraToCancel, setCompraToCancel] = useState(null);

  useEffect(() => { fetchCompras(); }, [filters]);
  useEffect(() => { proveedoresAPI.listar({ limit: 999 }).then((r) => setProveedores(r.data.data || [])).catch(() => {}); }, []);

  const fetchCompras = async (page = 1) => {
    try { setLoading(true); const r = await comprasAPI.listar({ page, limit: 20, ...filters }); setCompras(r.data.data); setPagination(r.data.pagination); }
    catch { toast.error("Error al cargar compras"); } finally { setLoading(false); }
  };

  const handleView = async (compra) => {
    try { const r = await comprasAPI.obtener(compra.id); setSelectedCompra(r.data?.data); setDetalleOpen(true); }
    catch { toast.error("Error al cargar detalle"); }
  };

  const handleCancel = (compra) => { setCompraToCancel(compra); setConfirmOpen(true); };

  const confirmCancel = async () => {
    try { await comprasAPI.cancelar(compraToCancel.id); toast.success("Compra cancelada"); fetchCompras(); }
    catch (err) { toast.error(err.response?.data?.message || "Error al cancelar"); }
    setConfirmOpen(false);
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

  return (
    <div>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:12, marginBottom:20}}>
        <div style={{display:"flex", gap:10, flexWrap:"wrap", alignItems:"center"}}>
          <input type="date" value={filters.fechaDesde || ""} onChange={(e) => setFilters({ ...filters, fechaDesde: e.target.value || undefined })} className="filter-input" />
          <input type="date" value={filters.fechaHasta || ""} onChange={(e) => setFilters({ ...filters, fechaHasta: e.target.value || undefined })} className="filter-input" />
          <select value={filters.proveedorId || ""} onChange={(e) => setFilters({ ...filters, proveedorId: e.target.value || undefined })} className="filter-input">
            <option value="">Todos los proveedores</option>
            {proveedores.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
          <select value={filters.estado || ""} onChange={(e) => setFilters({ ...filters, estado: e.target.value || undefined })} className="filter-input">
            <option value="">Todos los estados</option>
            <option value="pendiente">Pendiente</option>
            <option value="completada">Completada</option>
            <option value="cancelada">Cancelada</option>
          </select>
        </div>
        <button className="btn-primary" onClick={() => setModalOpen(true)}><i className="fa-solid fa-plus"></i> Nueva Compra</button>
      </div>

      {stockBajo && stockBajo.length > 0 && (
        <div style={{
          background:"linear-gradient(135deg, rgba(243, 139, 168, 0.1), rgba(250, 179, 135, 0.08))",
          border:"1px solid rgba(243, 139, 168, 0.25)",
          borderRadius:12, padding:"14px 18px", marginBottom:16,
          display:"flex", alignItems:"flex-start", gap:12
        }}>
          <i className="fa-solid fa-boxes-stacked" style={{fontSize:20, color:"var(--kanagawa-orange)", marginTop:2, flexShrink:0}}></i>
          <div style={{flex:1}}>
            <p style={{fontWeight:600, fontSize:14, color:"var(--kanagawa-fg)", margin:"0 0 8px"}}>
              Productos con stock bajo — recomendamos reponer
            </p>
            <div style={{display:"flex", flexWrap:"wrap", gap:"6px"}}>
              {stockBajo.map((p) => (
                <span key={p.id} style={{
                  background:"rgba(243, 139, 168, 0.12)",
                  borderRadius:6, padding:"4px 10px",
                  fontSize:13, color:"var(--kanagawa-fg)",
                  display:"inline-flex", alignItems:"center", gap:6
                }}>
                  <span style={{fontWeight:500}}>{p.nombre}</span>
                  <span style={{fontSize:12, color:"var(--kanagawa-comment)"}}>
                    {p.stock} / {p.stockMinimo}
                  </span>
                </span>
              ))}
            </div>
          </div>
          <button onClick={() => window.history.replaceState({}, document.title)}
            style={{background:"none", border:"none", color:"var(--kanagawa-comment)", cursor:"pointer", padding:4, flexShrink:0}}>
            <i className="fa-solid fa-times"></i>
          </button>
        </div>
      )}

      <div className="table-container">
        <div className="table-header">
          <h3>Compras</h3>
          <div className="actions" />
        </div>
        <table>
          <thead>
            <tr>
              <th># Compra</th>
              <th>Fecha</th>
              <th>Proveedor</th>
              <th>Productos</th>
              <th>Total</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} style={{textAlign:"center", padding:32, color:"#94a3b8"}}>Cargando...</td></tr>
            ) : compras.length === 0 ? (
              <tr><td colSpan={7} style={{textAlign:"center", padding:32, color:"#94a3b8"}}>No hay compras registradas</td></tr>
            ) : compras.map((row) => {
              const estadoClass = row.estado === "pendiente" ? "pending" : row.estado === "completada" ? "paid" : "cancelled";
              const totalProductos = row.detalles?.length || row.totalProductos || "-";
              return (
                <tr key={row.id}>
                  <td style={{fontFamily:"monospace"}}>{row.folio}</td>
                  <td>{formatDate(row.fecha || row.createdAt)}</td>
                  <td>{row.proveedor?.nombre || "-"}</td>
                  <td>{totalProductos}</td>
                  <td style={{fontWeight:600}}>{formatCurrency(row.total)}</td>
                  <td>
                    <span className={`status ${estadoClass}`}>
                      <span className="dot"></span>
                      {ESTADO_COMPRA_LABELS[row.estado] || row.estado}
                    </span>
                  </td>
                  <td>
                    <div style={{display:"flex", gap:6, alignItems:"center"}}>
                      <button onClick={() => handleView(row)} style={{padding:"6px 10px", border:"none", background:"transparent", color:"#3b82f6", cursor:"pointer", borderRadius:6, fontSize:16}} title="Ver detalle">
                        <i className="fa-solid fa-eye"></i>
                      </button>
                      {row.estado !== "cancelada" && (
                        <button onClick={() => handleCancel(row)} style={{padding:"6px 10px", border:"none", background:"transparent", color:"#ef4444", cursor:"pointer", borderRadius:6, fontSize:16}} title="Cancelar compra">
                          <i className="fa-solid fa-trash"></i>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {p && (
          <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 22px", borderTop:"1px solid #e9edf2"}}>
            <span style={{fontSize:13, color:"#64748b"}}>Mostrando {p.from} - {p.to} de {p.total}</span>
            <div style={{display:"flex", gap:8, alignItems:"center"}}>
              <button onClick={() => fetchCompras(p.currentPage - 1)} disabled={p.currentPage === 1}
                style={{padding:"6px 12px", border:"1px solid #e2e8f0", borderRadius:6, background:"#fff", cursor:p.currentPage === 1 ? "not-allowed" : "pointer", fontSize:13, opacity:p.currentPage === 1 ? 0.5 : 1}}>
                <i className="fa-solid fa-chevron-left"></i>
              </button>
              <span style={{fontSize:13, color:"#475569", padding:"0 8px"}}>{p.currentPage} / {p.totalPages}</span>
              <button onClick={() => fetchCompras(p.currentPage + 1)} disabled={p.currentPage >= p.totalPages}
                style={{padding:"6px 12px", border:"1px solid #e2e8f0", borderRadius:6, background:"#fff", cursor:p.currentPage >= p.totalPages ? "not-allowed" : "pointer", fontSize:13, opacity:p.currentPage >= p.totalPages ? 0.5 : 1}}>
                <i className="fa-solid fa-chevron-right"></i>
              </button>
            </div>
          </div>
        )}
      </div>

      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="Nueva Compra" size="xl">
        <CompraForm onSave={() => { setModalOpen(false); fetchCompras(); }} onCancel={() => setModalOpen(false)} />
      </Modal>

      <Modal isOpen={detalleOpen} onClose={() => setDetalleOpen(false)} title="Detalle de Compra" size="lg">
        {selectedCompra && <CompraDetalle compra={selectedCompra} />}
      </Modal>

      <ConfirmDialog isOpen={confirmOpen} onClose={() => setConfirmOpen(false)} onConfirm={confirmCancel}
        title="Cancelar Compra" message={`¿Estás seguro de cancelar la compra "${compraToCancel?.folio}"? Se revertirá el stock.`}
        confirmText="Cancelar Compra" />
    </div>
  );
};

const CompraForm = ({ onSave, onCancel }) => {
  const [proveedores, setProveedores] = useState([]);
  const [productos, setProductos] = useState([]);
  const [proveedorId, setProveedorId] = useState("");
  const [observaciones, setObservaciones] = useState("");
  const [items, setItems] = useState([{ productoId: "", cantidad: 1, precioUnitario: 0 }]);
  const [guardando, setGuardando] = useState(false);
  const [retirarDeCaja, setRetirarDeCaja] = useState(true);

  useEffect(() => {
    proveedoresAPI.listar({ limit: 999 }).then((r) => setProveedores(r.data.data || [])).catch(() => {});
    productosAPI.listar({ limit: 999 }).then((r) => setProductos(r.data.data || [])).catch(() => {});
  }, []);

  const subtotal = items.reduce((s, i) => s + (parseInt(i.cantidad || 0) * parseFloat(i.precioUnitario || 0)), 0);

  const handleAddItem = () => setItems([...items, { productoId: "", cantidad: 1, precioUnitario: 0 }]);
  const handleRemoveItem = (idx) => items.length > 1 && setItems(items.filter((_, i) => i !== idx));
  const handleItemChange = (idx, field, value) => {
    const updated = items.map((item, i) => {
      if (i !== idx) return item;
      if (field === "productoId") {
        const prod = productos.find((p) => p.id === parseInt(value));
        return { ...item, productoId: value, precioUnitario: prod ? parseFloat(prod.precioCompra || 0) : 0 };
      }
      return { ...item, [field]: value };
    });
    setItems(updated);
  };

  const handleSave = async () => {
    if (!proveedorId) { toast.error("Selecciona un proveedor"); return; }
    const validItems = items.filter((i) => i.productoId && i.cantidad > 0 && i.precioUnitario > 0);
    if (validItems.length === 0) { toast.error("Agrega al menos un producto válido"); return; }
    setGuardando(true);
    try {
      await comprasAPI.crear({ proveedorId: parseInt(proveedorId), items: validItems, observaciones, retirarDeCaja });
      toast.success("Compra registrada exitosamente");
      onSave();
    } catch (err) { toast.error(err.response?.data?.message || "Error al registrar compra"); }
    finally { setGuardando(false); }
  };

  return (
    <div>
      <div className="form-row">
        <div className="form-group">
          <label>Proveedor</label>
          <select value={proveedorId} onChange={(e) => setProveedorId(e.target.value)}>
            <option value="">Seleccionar proveedor...</option>
            {proveedores.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Observaciones</label>
          <input value={observaciones} onChange={(e) => setObservaciones(e.target.value)} placeholder="Opcional" />
        </div>
      </div>

      <div style={{borderTop:"1px solid #e9edf2", paddingTop:16, marginTop:8}}>
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12}}>
          <h4 style={{fontWeight:600, fontSize:14}}>Productos</h4>
          <button onClick={handleAddItem} className="btn-secondary" style={{padding:"6px 14px", fontSize:13}}>
            <i className="fa-solid fa-plus"></i> Agregar producto
          </button>
        </div>
        {items.map((item, idx) => (
          <div key={idx} style={{display:"flex", gap:8, alignItems:"flex-end", marginBottom:10, flexWrap:"wrap"}}>
            <div className="form-group" style={{flex:1, minWidth:180, marginBottom:0}}>
              <label style={{fontSize:12}}>Producto</label>
              <select value={item.productoId} onChange={(e) => handleItemChange(idx, "productoId", e.target.value)}>
                <option value="">Seleccionar...</option>
                {productos.map((p) => <option key={p.id} value={p.id}>{p.nombre} (${parseFloat(p.precio || 0).toFixed(2)})</option>)}
              </select>
            </div>
            <div className="form-group" style={{width:80, marginBottom:0}}>
              <label style={{fontSize:12}}>Cant.</label>
              <input type="number" min={1} value={item.cantidad} onChange={(e) => handleItemChange(idx, "cantidad", e.target.value)} />
            </div>
            <div className="form-group" style={{width:110, marginBottom:0}}>
              <label style={{fontSize:12}}>Precio Unit.</label>
              <input type="number" min={0} step="0.01" value={item.precioUnitario} onChange={(e) => handleItemChange(idx, "precioUnitario", e.target.value)} />
            </div>
            <div style={{paddingBottom:8}}>
              <div style={{fontSize:14, fontWeight:600, color:"#1e293b", paddingTop:20}}>${(parseInt(item.cantidad || 0) * parseFloat(item.precioUnitario || 0)).toFixed(2)}</div>
            </div>
            <button onClick={() => handleRemoveItem(idx)} disabled={items.length === 1}
              style={{padding:"6px", border:"none", background:"transparent", color: items.length === 1 ? "#cbd5e1" : "#ef4444", cursor: items.length === 1 ? "not-allowed" : "pointer", fontSize:16, paddingBottom:8}} title="Eliminar producto">
              <i className="fa-solid fa-trash"></i>
            </button>
          </div>
        ))}
        <div style={{textAlign:"right", marginTop:12}}>
          <p style={{fontSize:20, fontWeight:700}}>Subtotal: {formatCurrency(subtotal)}</p>
        </div>
      </div>

      <div style={{
        display:"flex", alignItems:"center", gap:10,
        padding:"12px 16px", background:"rgba(37, 99, 235, 0.06)",
        borderRadius:8, marginTop:8, marginBottom:4,
        border:"1px solid rgba(37, 99, 235, 0.15)"
      }}>
        <label style={{
          display:"flex", alignItems:"center", gap:10, cursor:"pointer", flex:1
        }}>
          <input
            type="checkbox"
            checked={retirarDeCaja}
            onChange={(e) => setRetirarDeCaja(e.target.checked)}
            style={{width:18, height:18, accentColor:"#2563eb", cursor:"pointer"}}
          />
          <div>
            <strong style={{fontSize:14, display:"block"}}>Retirar de caja</strong>
            <span style={{fontSize:12, color:"#64748b"}}>
              {retirarDeCaja
                ? `Se registrará un egreso de ${formatCurrency(subtotal)} en la caja abierta`
                : "Si hay una caja abierta, podés debitarlo automáticamente"}
            </span>
          </div>
        </label>
      </div>

      <div style={{display:"flex", justifyContent:"flex-end", gap:12, paddingTop:16, borderTop:"1px solid #e9edf2", marginTop:8}}>
        <button onClick={onCancel} className="btn-secondary">Cancelar</button>
        <button onClick={handleSave} disabled={guardando} className="btn-primary">{guardando ? "Guardando..." : "Registrar Compra"}</button>
      </div>
    </div>
  );
};

const CompraDetalle = ({ compra }) => {
  const estadoClass = compra.estado === "pendiente" ? "pending" : compra.estado === "completada" ? "paid" : "cancelled";

  return (
    <div>
      <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginBottom:16}}>
        <div><div style={{fontSize:13, color:"#64748b", marginBottom:4}}>Folio</div><div style={{fontWeight:500}}>{compra.folio}</div></div>
        <div><div style={{fontSize:13, color:"#64748b", marginBottom:4}}>Fecha</div><div style={{fontWeight:500}}>{formatDate(compra.fecha || compra.createdAt)}</div></div>
        <div><div style={{fontSize:13, color:"#64748b", marginBottom:4}}>Proveedor</div><div style={{fontWeight:500}}>{compra.proveedor?.nombre || "-"}</div></div>
        <div>
          <div style={{fontSize:13, color:"#64748b", marginBottom:4}}>Estado</div>
          <span className={`status ${estadoClass}`}>
            <span className="dot"></span>
            {ESTADO_COMPRA_LABELS[compra.estado] || compra.estado}
          </span>
        </div>
        <div style={{gridColumn:"span 2"}}>
          <div style={{fontSize:13, color:"#64748b", marginBottom:4}}>Observaciones</div>
          <div style={{fontWeight:500}}>{compra.observaciones || "-"}</div>
        </div>
      </div>

      <div style={{borderTop:"1px solid #e9edf2", paddingTop:16}}>
        <h4 style={{fontWeight:600, fontSize:14, marginBottom:12}}>Productos</h4>
        <table style={{width:"100%", borderCollapse:"collapse", fontSize:14}}>
          <thead>
            <tr style={{background:"#f8fafc"}}>
              <th style={{textAlign:"left", padding:"10px 16px", fontWeight:600, color:"#475569", fontSize:12, textTransform:"uppercase", letterSpacing:"0.4px"}}>Producto</th>
              <th style={{textAlign:"right", padding:"10px 16px", fontWeight:600, color:"#475569", fontSize:12, textTransform:"uppercase", letterSpacing:"0.4px"}}>Cant.</th>
              <th style={{textAlign:"right", padding:"10px 16px", fontWeight:600, color:"#475569", fontSize:12, textTransform:"uppercase", letterSpacing:"0.4px"}}>Precio Unit.</th>
              <th style={{textAlign:"right", padding:"10px 16px", fontWeight:600, color:"#475569", fontSize:12, textTransform:"uppercase", letterSpacing:"0.4px"}}>Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {(compra.detalles || []).map((det, idx) => (
              <tr key={idx}>
                <td style={{padding:"10px 16px", borderBottom:"1px solid #f1f5f9"}}>{det.producto?.nombre || `Producto #${det.productoId}`}</td>
                <td style={{padding:"10px 16px", borderBottom:"1px solid #f1f5f9", textAlign:"right"}}>{det.cantidad}</td>
                <td style={{padding:"10px 16px", borderBottom:"1px solid #f1f5f9", textAlign:"right"}}>{formatCurrency(det.precioUnitario)}</td>
                <td style={{padding:"10px 16px", borderBottom:"1px solid #f1f5f9", textAlign:"right", fontWeight:600}}>{formatCurrency(det.subtotal)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{borderTop:"2px solid #e9edf2"}}>
              <td colSpan={3} style={{padding:"10px 16px", textAlign:"right", fontWeight:600}}>Subtotal:</td>
              <td style={{padding:"10px 16px", textAlign:"right", fontWeight:600}}>{formatCurrency(compra.subtotal)}</td>
            </tr>
            <tr>
              <td colSpan={3} style={{padding:"10px 16px", textAlign:"right", fontSize:18, fontWeight:700}}>Total:</td>
              <td style={{padding:"10px 16px", textAlign:"right", fontSize:18, fontWeight:700, color:"#2563eb"}}>{formatCurrency(compra.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
};

export default Compras;
