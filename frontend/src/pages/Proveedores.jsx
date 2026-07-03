import React, { useState, useEffect } from "react";
import { proveedoresAPI } from "../api/proveedores";
import Modal from "../components/common/Modal";
import ConfirmDialog from "../components/common/ConfirmDialog";
import { toast } from "react-toastify";

const Proveedores = () => {

  const [proveedores, setProveedores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({});
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [toDelete, setToDelete] = useState(null);
  const [form, setForm] = useState({ nombre: "", ruc: "", telefono: "", email: "", direccion: "", contacto: "", notas: "" });

  useEffect(() => { fetchProveedores(); }, [search]);

  const fetchProveedores = async (page = 1) => {
    try { setLoading(true); const r = await proveedoresAPI.listar({ page, limit: 20, search }); setProveedores(r.data.data); setPagination(r.data.pagination); }
    catch { toast.error("Error al cargar proveedores"); } finally { setLoading(false); }
  };

  const resetForm = () => setForm({ nombre: "", ruc: "", telefono: "", email: "", direccion: "", contacto: "", notas: "" });

  const handleCreate = () => { resetForm(); setSelected(null); setModalOpen(true); };
  const handleEdit = (p) => { setForm({ nombre: p.nombre, ruc: p.ruc || "", telefono: p.telefono || "", email: p.email || "", direccion: p.direccion || "", contacto: p.contacto || "", notas: p.notas || "" }); setSelected(p); setModalOpen(true); };
  const handleDelete = (p) => { setToDelete(p); setConfirmOpen(true); };

  const confirmDelete = async () => {
    try { await proveedoresAPI.eliminar(toDelete.id); toast.success("Proveedor eliminado"); fetchProveedores(); }
    catch { toast.error("Error al eliminar proveedor"); }
    setConfirmOpen(false);
  };

  const handleSave = async () => {
    if (!form.nombre.trim()) { toast.error("El nombre es obligatorio"); return; }
    try {
      if (selected) { await proveedoresAPI.actualizar(selected.id, form); toast.success("Proveedor actualizado"); }
      else { await proveedoresAPI.crear(form); toast.success("Proveedor creado"); }
      setModalOpen(false); fetchProveedores();
    } catch (err) { toast.error(err.response?.data?.message || "Error al guardar"); }
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
        <div style={{display:"flex", gap:10, flexWrap:"wrap"}}>
          <input type="text" placeholder="🔍 Buscar por nombre..." value={search} onChange={(e) => setSearch(e.target.value)} className="filter-input" style={{width:240}} />
        </div>
        <button className="btn-primary" onClick={handleCreate}><i className="fa-solid fa-plus"></i> Nuevo Proveedor</button>
      </div>

      <div className="table-container">
        <div className="table-header">
          <h3>Proveedores</h3>
          <div className="actions" />
        </div>
        <table>
          <thead>
            <tr>
              <th>Proveedor</th>
              <th>Contacto</th>
              <th>Teléfono</th>
              <th>Email</th>
              <th>Productos</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} style={{textAlign:"center", padding:32, color:"#94a3b8"}}>Cargando...</td></tr>
            ) : proveedores.length === 0 ? (
              <tr><td colSpan={7} style={{textAlign:"center", padding:32, color:"#94a3b8"}}>No hay proveedores registrados</td></tr>
            ) : proveedores.map((row) => (
              <tr key={row.id}>
                <td>{row.nombre}</td>
                <td>{row.contacto || "-"}</td>
                <td>{row.telefono || "-"}</td>
                <td>{row.email || "-"}</td>
                <td>{row.totalProductos != null ? row.totalProductos : "-"}</td>
                <td>
                  <span className={`status ${row.activo !== false ? "active-s" : "inactive-s"}`}>
                    <span className="dot"></span>
                    {row.activo !== false ? "Activo" : "Inactivo"}
                  </span>
                </td>
                  <td>
                    <div style={{display:"flex", gap:6}}>
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
              <button onClick={() => fetchProveedores(p.currentPage - 1)} disabled={p.currentPage === 1}
                style={{padding:"6px 12px", border:"1px solid #e2e8f0", borderRadius:6, background:"#fff", cursor:p.currentPage === 1 ? "not-allowed" : "pointer", fontSize:13, opacity:p.currentPage === 1 ? 0.5 : 1}}>
                <i className="fa-solid fa-chevron-left"></i>
              </button>
              <span style={{fontSize:13, color:"#475569", padding:"0 8px"}}>{p.currentPage} / {p.totalPages}</span>
              <button onClick={() => fetchProveedores(p.currentPage + 1)} disabled={p.currentPage >= p.totalPages}
                style={{padding:"6px 12px", border:"1px solid #e2e8f0", borderRadius:6, background:"#fff", cursor:p.currentPage >= p.totalPages ? "not-allowed" : "pointer", fontSize:13, opacity:p.currentPage >= p.totalPages ? 0.5 : 1}}>
                <i className="fa-solid fa-chevron-right"></i>
              </button>
            </div>
          </div>
        )}
      </div>

      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title={selected ? "Editar Proveedor" : "Nuevo Proveedor"} size="lg">
        <div>
          <div className="form-row">
            <div className="form-group">
              <label>Nombre *</label>
              <input value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} />
            </div>
            <div className="form-group">
              <label>RUC</label>
              <input value={form.ruc} onChange={(e) => setForm({ ...form, ruc: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Teléfono</label>
              <input value={form.telefono} onChange={(e) => setForm({ ...form, telefono: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Email</label>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Dirección</label>
              <input value={form.direccion} onChange={(e) => setForm({ ...form, direccion: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Persona de Contacto</label>
              <input value={form.contacto} onChange={(e) => setForm({ ...form, contacto: e.target.value })} />
            </div>
          </div>
          <div className="form-group">
            <label>Notas</label>
            <textarea value={form.notas} onChange={(e) => setForm({ ...form, notas: e.target.value })} rows={3} />
          </div>
          <div style={{display:"flex", justifyContent:"flex-end", gap:12, paddingTop:16, borderTop:"1px solid #e9edf2", marginTop:8}}>
            <button onClick={() => setModalOpen(false)} className="btn-secondary">Cancelar</button>
            <button onClick={handleSave} className="btn-primary">{selected ? "Actualizar" : "Crear"}</button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog isOpen={confirmOpen} onClose={() => setConfirmOpen(false)} onConfirm={confirmDelete}
        title="Eliminar Proveedor" message={`¿Estás seguro de eliminar a "${toDelete?.nombre}"?`} />
    </div>
  );
};

export default Proveedores;
