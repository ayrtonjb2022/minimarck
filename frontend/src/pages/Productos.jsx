import React, { useState, useEffect } from "react";
import { productosAPI } from "../api/productos";
import { categoriasAPI } from "../api/categorias";
import Modal from "../components/common/Modal";
import ConfirmDialog from "../components/common/ConfirmDialog";
import ProductForm from "../components/forms/ProductForm";
import { toast } from "react-toastify";
import { formatCurrency } from "../utils/formatters";

const Productos = () => {
  const [productos, setProductos] = useState([]);
  const [categorias, setCategorias] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({});
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState({});
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [productToDelete, setProductToDelete] = useState(null);

  useEffect(() => {
    fetchProductos();
    fetchCategorias();
  }, [search, filters]);

  const fetchProductos = async (page = 1) => {
    try {
      setLoading(true);
      const params = { page, limit: 20, search, ...filters };
      const response = await productosAPI.listar(params);
      setProductos(response.data.data);
      setPagination(response.data.pagination);
    } catch (error) {
      toast.error("Error al cargar productos");
    } finally {
      setLoading(false);
    }
  };

  const fetchCategorias = async () => {
    try {
      const response = await categoriasAPI.listar();
      setCategorias(response.data?.data || []);
    } catch (error) {
      console.error("Error al cargar categorías:", error);
    }
  };

  const handleCreate = () => {
    setSelectedProduct(null);
    setModalOpen(true);
  };

  const handleEdit = (product) => {
    setSelectedProduct(product);
    setModalOpen(true);
  };

  const handleDelete = (product) => {
    setProductToDelete(product);
    setConfirmOpen(true);
  };

  const confirmDelete = async () => {
    try {
      await productosAPI.eliminar(productToDelete.id);
      toast.success("Producto eliminado exitosamente");
      fetchProductos();
    } catch (error) {
      toast.error("Error al eliminar producto");
    }
    setConfirmOpen(false);
  };

  const handleSave = async (formData) => {
    try {
      if (selectedProduct) {
        await productosAPI.actualizar(selectedProduct.id, formData);
        toast.success("Producto actualizado exitosamente");
      } else {
        await productosAPI.crear(formData);
        toast.success("Producto creado exitosamente");
      }
      setModalOpen(false);
      fetchProductos();
    } catch (error) {
      toast.error(error.response?.data?.message || "Error al guardar producto");
    }
  };

  const getCategoriaNombre = (catId) => {
    const cat = categorias.find((c) => c.id === catId);
    return cat ? cat.nombre : "-";
  };

  return (
    <div>
      <div className="table-container" style={{ marginBottom: "20px" }}>
        <div className="table-header">
          <h3>Productos</h3>
          <div className="actions">
            <input
              type="text"
              placeholder="Buscar producto..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="filter-input"
              style={{ width: 240 }}
            />
            <select
              value={filters.categoriaId || ""}
              onChange={(e) =>
                setFilters({ ...filters, categoriaId: e.target.value || undefined })
              }
            >
              <option value="">Todas las categorías</option>
              {categorias.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.nombre}
                </option>
              ))}
            </select>
            <button onClick={handleCreate} className="btn-primary">
              <i className="fa-solid fa-plus"></i>
              Nuevo Producto
            </button>
          </div>
        </div>
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>Código</th>
              <th>Producto</th>
              <th>Categoría</th>
              <th>Precio</th>
              <th>IVA</th>
              <th>Stock / U.M.</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8}>Cargando...</td>
              </tr>
            ) : productos.length === 0 ? (
              <tr>
                <td colSpan={8}>No hay productos registrados</td>
              </tr>
            ) : (
              productos.map((row) => (
                <tr key={row.id}>
                  <td>{row.codigo}</td>
                  <td>{row.nombre}</td>
                  <td>{getCategoriaNombre(row.categoriaId)}</td>
                  <td>{formatCurrency(row.precio)}</td>
                  <td>{row.tieneIva ? `${row.ivaPorcentaje || 21}%` : "—"}</td>
                  <td>{row.stock} {row.unidadMedida !== "unidad" ? row.unidadMedida || "" : ""}</td>
                  <td>
                    <span className={`status ${row.activo ? "active-s" : "inactive-s"}`}>
                      <span className="dot"></span>
                      {row.activo ? "Activo" : "Inactivo"}
                    </span>
                  </td>
                  <td>
                    <button onClick={() => handleEdit(row)} className="btn-secondary" style={{ padding: "4px 10px", marginRight: "6px" }}>
                      <i className="fa-solid fa-edit"></i>
                    </button>
                    <button onClick={() => handleDelete(row)} className="btn-danger" style={{ padding: "4px 10px" }}>
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
            {Array.from({ length: pagination.totalPages }, (_, i) => i + 1).map((page) => (
              <button
                key={page}
                onClick={() => fetchProductos(page)}
                className={page === pagination.page ? "btn-primary" : "btn-secondary"}
                style={{ padding: "4px 12px", fontSize: "12px" }}
              >
                {page}
              </button>
            ))}
          </div>
        )}
      </div>

      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={selectedProduct ? "Editar Producto" : "Nuevo Producto"}
        size="lg"
      >
        <ProductForm
          product={selectedProduct}
          categorias={categorias}
          onSave={handleSave}
          onCancel={() => setModalOpen(false)}
        />
      </Modal>

      <ConfirmDialog
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={confirmDelete}
        title="Eliminar Producto"
        message={`¿Estás seguro de eliminar el producto "${productToDelete?.nombre}"?`}
      />
    </div>
  );
};

export default Productos;
