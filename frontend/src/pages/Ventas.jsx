import React, { useState, useEffect } from "react";
import { useAuth } from "../context/AuthContext";
import { ventasAPI } from "../api/ventas";
import { productosAPI } from "../api/productos";
import { cajasAPI } from "../api/cajas";
import Modal from "../components/common/Modal";
import SaleForm from "../components/forms/SaleForm";
import { toast } from "react-toastify";
import { formatCurrency, formatDate } from "../utils/formatters";
import { METODO_PAGO_LABELS } from "../utils/constants";
import { exportExcel } from "../utils/export";

const Ventas = () => {
  const { user } = useAuth();
  const [ventas, setVentas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({});
  const [filters, setFilters] = useState({});
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedVenta, setSelectedVenta] = useState(null);
  const [productos, setProductos] = useState([]);
  const [cajaActual, setCajaActual] = useState(null);

  useEffect(() => { fetchVentas(); fetchProductos(); fetchCajaActual(); }, [filters]);

  const fetchVentas = async (page = 1) => {
    try {
      setLoading(true);
      const params = { page, limit: 20, ...filters };
      const response = await ventasAPI.listar(params);
      setVentas(response.data.data);
      setPagination(response.data.pagination);
    } catch (error) { toast.error("Error al cargar ventas"); }
    finally { setLoading(false); }
  };

  const fetchProductos = async () => {
    try { const response = await productosAPI.listar({ limit: 999 }); setProductos(response.data.data); }
    catch (error) { console.error("Error al cargar productos:", error); }
  };

  const fetchCajaActual = async () => {
    try { const response = await cajasAPI.activa(); setCajaActual(response.data?.data); }
    catch (error) { setCajaActual(null); }
  };

  const handleCreate = () => {
    if (!cajaActual) { toast.warning("Debes abrir la caja primero"); return; }
    setSelectedVenta(null); setModalOpen(true);
  };

  const handleView = (venta) => { setSelectedVenta(venta); setModalOpen(true); };

  const handleSave = async (formData) => {
    try { await ventasAPI.crear(formData); toast.success("Venta registrada exitosamente"); setModalOpen(false); fetchVentas(); fetchCajaActual(); fetchProductos(); }
    catch (error) { toast.error(error.response?.data?.message || "Error al registrar venta"); }
  };

  const estadoClass = (estado) => {
    if (estado === "completada") return "paid";
    if (estado === "pendiente") return "pending";
    return "cancelled";
  };

  const estadoLabel = (estado) => {
    if (estado === "completada") return "Completada";
    if (estado === "pendiente") return "Pendiente";
    return "Anulada";
  };

  const handleExport = () => {
    const columns = [
      { header: "# Venta", key: "folio" },
      { header: "Fecha", key: "fecha", cell: (r) => formatDate(r.fecha || r.createdAt) },
      { header: "Cliente", key: "clienteNombre" },
      { header: "Vendedor", key: "usuario.nombre" },
      { header: "Total", key: "total", cell: (r) => formatCurrency(r.total) },
      { header: "Método", key: "metodoPago", cell: (r) => METODO_PAGO_LABELS[r.metodoPago] || r.metodoPago },
      { header: "Estado", key: "estado", cell: (r) => estadoLabel(r.estado) },
    ];
    exportExcel(ventas, columns, `ventas-${new Date().toISOString().slice(0, 10)}`);
  };

  return (
    <div>
      <div className="table-container" style={{ marginBottom: "20px" }}>
        <div className="table-header">
          <h3>Ventas</h3>
          <div className="actions">
            <input
              type="date"
              value={filters.fechaInicio || ""}
              onChange={(e) => setFilters({ ...filters, fechaInicio: e.target.value })}
              placeholder="Fecha inicio"
            />
            <input
              type="date"
              value={filters.fechaFin || ""}
              onChange={(e) => setFilters({ ...filters, fechaFin: e.target.value })}
              placeholder="Fecha fin"
            />
            <select
              value={filters.estado || ""}
              onChange={(e) => setFilters({ ...filters, estado: e.target.value || undefined })}
            >
              <option value="">Todos los estados</option>
              <option value="completada">Completada</option>
              <option value="anulada">Anulada</option>
            </select>
            <button onClick={handleExport} className="btn-secondary">
              <i className="fa-solid fa-file-export"></i>
              Exportar
            </button>
            <button onClick={handleCreate} className="btn-primary">
              <i className="fa-solid fa-plus"></i>
              Nueva Venta
            </button>
          </div>
        </div>
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th># Venta</th>
              <th>Fecha</th>
              <th>Cliente</th>
              <th>Vendedor</th>
              <th>Total</th>
              <th>Método</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} style={{textAlign:"center", padding:32, color:"#94a3b8"}}>Cargando...</td>
              </tr>
            ) : ventas.length === 0 ? (
              <tr>
                <td colSpan={8} style={{textAlign:"center", padding:32, color:"#94a3b8"}}>No hay ventas registradas</td>
              </tr>
            ) : (
              ventas.map((row) => (
                <tr key={row.id}>
                  <td>#{row.folio}</td>
                  <td>{formatDate(row.fecha || row.createdAt)}</td>
                  <td>{row.clienteNombre || "-"}</td>
                  <td>{row.usuario?.nombre || ""}</td>
                  <td>{formatCurrency(row.total)}</td>
                  <td>{METODO_PAGO_LABELS[row.metodoPago] || row.metodoPago}</td>
                  <td>
                    <span className={`status ${estadoClass(row.estado)}`}>
                      <span className="dot"></span>
                      {estadoLabel(row.estado)}
                    </span>
                  </td>
                  <td>
                    <button onClick={() => handleView(row)} className="btn-secondary" style={{ padding: "4px 10px" }} title="Ver detalle">
                      <i className="fa-solid fa-eye"></i>
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {pagination && pagination.totalPages > 1 && (
          <div style={{ padding: "12px 22px", borderTop: "1px solid #e9edf2", display: "flex", justifyContent: "center", gap: "8px" }}>
            {Array.from({ length: pagination.totalPages }, (_, i) => i + 1).map((page) => (
              <button
                key={page}
                onClick={() => fetchVentas(page)}
                className={page === pagination.page ? "btn-primary" : "btn-secondary"}
                style={{ padding: "4px 12px", fontSize: "12px" }}
              >
                {page}
              </button>
            ))}
          </div>
        )}
      </div>

      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title={selectedVenta ? "Detalle de Venta" : "Nueva Venta"} size="xl">
        {selectedVenta ? <VentaDetalle venta={selectedVenta} /> : <SaleForm productos={productos} onSave={handleSave} onCancel={() => setModalOpen(false)} />}
      </Modal>
    </div>
  );
};

const VentaDetalle = ({ venta }) => {
  const estadoClass = (estado) => {
    if (estado === "completada") return "paid";
    if (estado === "pendiente") return "pending";
    return "cancelled";
  };

  const estadoLabel = (estado) => {
    if (estado === "completada") return "Completada";
    if (estado === "pendiente") return "Pendiente";
    return "Anulada";
  };

  return (
    <div className="card">
      <div className="card-header">
        <h3>Detalle #{venta.folio}</h3>
        <span className={`status ${estadoClass(venta.estado)}`}>
          <span className="dot"></span>
          {estadoLabel(venta.estado)}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "16px" }}>
        <div><span style={{ fontSize: "12px", color: "#8992a7" }}>Folio</span><div style={{ fontWeight: 500 }}>#{venta.folio}</div></div>
        <div><span style={{ fontSize: "12px", color: "#8992a7" }}>Fecha</span><div style={{ fontWeight: 500 }}>{formatDate(venta.fecha || venta.createdAt)}</div></div>
        <div><span style={{ fontSize: "12px", color: "#8992a7" }}>Vendedor</span><div style={{ fontWeight: 500 }}>{venta.usuario?.nombre}</div></div>
        <div><span style={{ fontSize: "12px", color: "#8992a7" }}>Método de Pago</span><div style={{ fontWeight: 500 }}>{METODO_PAGO_LABELS[venta.metodoPago]}</div></div>
        <div><span style={{ fontSize: "12px", color: "#8992a7" }}>Cliente</span><div style={{ fontWeight: 500 }}>{venta.clienteNombre || "-"}</div></div>
      </div>
      <div style={{ borderTop: "1px solid #363432", paddingTop: "12px" }}>
        <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "8px" }}>Productos</div>
        <table>
          <thead>
            <tr>
              <th>Producto</th>
              <th style={{ textAlign: "right" }}>Cant.</th>
              <th style={{ textAlign: "right" }}>Precio</th>
              <th style={{ textAlign: "right" }}>Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {(venta.detalles || venta.ventaDetalles)?.map((detalle, index) => (
              <tr key={detalle.id ?? detalle.productoId ?? index}>
                <td>{detalle.producto?.nombre || detalle.nombreProducto || detalle.nombre}</td>
                <td style={{ textAlign: "right" }}>{detalle.cantidad}</td>
                <td style={{ textAlign: "right" }}>{formatCurrency(detalle.precioUnitario)}</td>
                <td style={{ textAlign: "right" }}>{formatCurrency(detalle.subtotal)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} style={{ textAlign: "right", fontWeight: 500, paddingTop: "8px" }}>Subtotal:</td>
              <td style={{ textAlign: "right", fontWeight: 500, paddingTop: "8px" }}>{formatCurrency(venta.subtotal)}</td>
            </tr>
            <tr>
              <td colSpan={3} style={{ textAlign: "right", fontWeight: 500 }}>IVA (21%):</td>
              <td style={{ textAlign: "right", fontWeight: 500 }}>{formatCurrency(venta.iva || 0)}</td>
            </tr>
            <tr>
              <td colSpan={3} style={{ textAlign: "right", fontWeight: 700, fontSize: "16px", borderTop: "2px solid #363432" }}>Total:</td>
              <td style={{ textAlign: "right", fontWeight: 700, fontSize: "16px", borderTop: "2px solid #363432" }}>{formatCurrency(venta.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
};

export default Ventas;
