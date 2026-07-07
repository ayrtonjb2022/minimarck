import React, { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { productosAPI } from "../api/productos";
import { categoriasAPI } from "../api/categorias";
import Modal from "../components/common/Modal";
import ScannerModal from "../components/common/ScannerModal";
import ConfirmDialog from "../components/common/ConfirmDialog";
import ProductForm from "../components/forms/ProductForm";
import { toast } from "react-toastify";
import { formatCurrency } from "../utils/formatters";

const Productos = () => {
  const queryClient = useQueryClient();
  const [categorias, setCategorias] = useState([]);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState({});
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [productToDelete, setProductToDelete] = useState(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [stockModalOpen, setStockModalOpen] = useState(false);
  const [stockModalProduct, setStockModalProduct] = useState(null);
  const [stockCantidad, setStockCantidad] = useState("");
  const [barcodePrefill, setBarcodePrefill] = useState(null);

  // React Query — productos cacheados
  const { data: productosData, isLoading } = useQuery({
    queryKey: ["productos", search, filters, page],
    queryFn: () =>
      productosAPI
        .listar({ page, limit: 20, search, ...filters })
        .then((r) => r.data),
    staleTime: 30000,
  });

  const productos = productosData?.data || [];
  const pagination = productosData?.pagination || {};

  // Resetear página al cambiar búsqueda o filtros
  useEffect(() => {
    setPage(1);
  }, [search, filters]);

  // Categorías (se cargan una vez)
  useEffect(() => {
    categoriasAPI
      .listar()
      .then((r) => setCategorias(r.data?.data || []))
      .catch(() => {});
  }, []);

  // Mutation — crear / actualizar producto
  const saveMutation = useMutation({
    mutationFn: (formData) => {
      if (selectedProduct) {
        return productosAPI.actualizar(selectedProduct.id, formData);
      }
      return productosAPI.crear(formData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["productos"] });
      toast.success(
        selectedProduct
          ? "Producto actualizado exitosamente"
          : "Producto creado exitosamente"
      );
      setModalOpen(false);
      setBarcodePrefill(null);
    },
    onError: (error) => {
      toast.error(
        error.response?.data?.message || "Error al guardar producto"
      );
    },
  });

  // Mutation — eliminar producto
  const deleteMutation = useMutation({
    mutationFn: () => productosAPI.eliminar(productToDelete.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["productos"] });
      toast.success("Producto eliminado exitosamente");
      setConfirmOpen(false);
    },
    onError: () => toast.error("Error al eliminar producto"),
  });

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
    await deleteMutation.mutateAsync();
  };

  const handleScan = async (codigo) => {
    setScannerOpen(false);
    try {
      const response = await productosAPI.buscarPorCodigo(codigo);
      // Producto encontrado → abrir modal para agregar stock
      const producto = response.data.data;
      setStockModalProduct(producto);
      setStockCantidad("");
      setStockModalOpen(true);
    } catch (error) {
      if (error.response?.status === 404) {
        // Producto no encontrado → precargar código en creación
        setBarcodePrefill(codigo);
        setSelectedProduct(null);
        setModalOpen(true);
      } else {
        toast.error("Error al buscar producto: " + (error.response?.data?.message || error.message));
      }
    }
  };

  const handleConfirmStock = async () => {
    if (!stockModalProduct || !stockCantidad || parseInt(stockCantidad) <= 0) {
      toast.warning("Ingresá una cantidad válida");
      return;
    }
    try {
      const nuevaCantidad = parseInt(stockCantidad);
      await productosAPI.actualizar(stockModalProduct.id, {
        stock: stockModalProduct.stock + nuevaCantidad,
      });
      toast.success(`Stock actualizado: +${nuevaCantidad} ${stockModalProduct.unidadMedida || "unidad(es)"}`);
      setStockModalOpen(false);
      setStockModalProduct(null);
      queryClient.invalidateQueries({ queryKey: ["productos"] });
    } catch (error) {
      toast.error("Error al actualizar stock: " + (error.response?.data?.message || error.message));
    }
  };

  const handleSave = async (formData) => {
    await saveMutation.mutateAsync(formData);
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
            <button
              onClick={() => setScannerOpen(true)}
              className="btn-secondary"
              style={{ padding: "8px 14px" }}
              title="Escanear código de barras"
            >
              <i className="fa-solid fa-camera"></i>
              {" "}Escanear
            </button>
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
            {isLoading ? (
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
            {Array.from({ length: pagination.totalPages }, (_, i) => i + 1).map((p) => (
              <button
                key={p}
                onClick={() => setPage(p)}
                className={p === pagination.page ? "btn-primary" : "btn-secondary"}
                style={{ padding: "4px 12px", fontSize: "12px" }}
              >
                {p}
              </button>
            ))}
          </div>
        )}
      </div>

      <ScannerModal
        isOpen={scannerOpen}
        onScan={handleScan}
        onClose={() => setScannerOpen(false)}
      />

      <Modal
        isOpen={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setBarcodePrefill(null);
        }}
        title={selectedProduct ? "Editar Producto" : "Nuevo Producto"}
        size="lg"
      >
        <ProductForm
          product={selectedProduct}
          categorias={categorias}
          onSave={handleSave}
          onCancel={() => {
            setModalOpen(false);
            setBarcodePrefill(null);
          }}
          codigoPrefill={!selectedProduct ? barcodePrefill : null}
        />
      </Modal>

      {/* Modal para agregar stock desde escaneo */}
      <Modal
        isOpen={stockModalOpen}
        onClose={() => {
          setStockModalOpen(false);
          setStockModalProduct(null);
        }}
        title="Agregar Stock"
        size="sm"
      >
        {stockModalProduct && (
          <div>
            <p style={{ color: "#d4d4c8", marginBottom: 16, fontSize: 14 }}>
              Producto: <strong>{stockModalProduct.nombre}</strong>
              <br />
              Stock actual:{" "}
              <strong>
                {stockModalProduct.stock}{" "}
                {stockModalProduct.unidadMedida !== "unidad"
                  ? stockModalProduct.unidadMedida
                  : ""}
              </strong>
            </p>
            <div className="form-group">
              <label>Cantidad a agregar</label>
              <input
                type="number"
                value={stockCantidad}
                onChange={(e) => setStockCantidad(e.target.value)}
                min="1"
                autoFocus
                placeholder="Ej: 10"
              />
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 12,
                marginTop: 20,
                paddingTop: 16,
                borderTop: "1px solid #363432",
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setStockModalOpen(false);
                  setStockModalProduct(null);
                }}
                className="btn-secondary"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleConfirmStock}
                className="btn-primary"
              >
                Confirmar
              </button>
            </div>
          </div>
        )}
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
