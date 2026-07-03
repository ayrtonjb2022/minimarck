import React, { useState, useEffect } from "react";
import { categoriasAPI } from "../api/categorias";
import Modal from "../components/common/Modal";
import ConfirmDialog from "../components/common/ConfirmDialog";
import { toast } from "react-toastify";


const Categorias = () => {
  const [categorias, setCategorias] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [categoryToDelete, setCategoryToDelete] = useState(null);
  const [formData, setFormData] = useState({ nombre: "", descripcion: "" });
  const [errors, setErrors] = useState({});

  useEffect(() => {
    fetchCategorias();
  }, []);

  const fetchCategorias = async () => {
    try {
      setLoading(true);
      const response = await categoriasAPI.listar();
      setCategorias(response.data?.data || []);
    } catch (error) {
      toast.error("Error al cargar categorías");
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = () => {
    setSelectedCategory(null);
    setFormData({ nombre: "", descripcion: "" });
    setErrors({});
    setModalOpen(true);
  };

  const handleEdit = (category) => {
    setSelectedCategory(category);
    setFormData({
      nombre: category.nombre,
      descripcion: category.descripcion || "",
    });
    setErrors({});
    setModalOpen(true);
  };

  const handleDelete = (category) => {
    setCategoryToDelete(category);
    setConfirmOpen(true);
  };

  const confirmDelete = async () => {
    try {
      await categoriasAPI.eliminar(categoryToDelete.id);
      toast.success("Categoría eliminada exitosamente");
      fetchCategorias();
    } catch (error) {
      toast.error("Error al eliminar categoría");
    }
    setConfirmOpen(false);
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: value });
    if (errors[name]) {
      setErrors({ ...errors, [name]: "" });
    }
  };

  const validate = () => {
    const newErrors = {};
    if (!formData.nombre) newErrors.nombre = "El nombre es requerido";
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;

    try {
      const data = { ...formData, nombre: formData.nombre };
      if (selectedCategory) {
        await categoriasAPI.actualizar(selectedCategory.id, data);
        toast.success("Categoría actualizada exitosamente");
      } else {
        await categoriasAPI.crear(data);
        toast.success("Categoría creada exitosamente");
      }
      setModalOpen(false);
      fetchCategorias();
    } catch (error) {
      toast.error(
        error.response?.data?.message || "Error al guardar categoría",
      );
    }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", flexWrap: "wrap", gap: "10px" }}>
        <h3 style={{ fontSize: "16px", fontWeight: 600 }}>Categorías</h3>
        <button onClick={handleCreate} className="btn-primary">
          <i className="fa-solid fa-plus"></i>
          Nueva Categoría
        </button>
      </div>

      {loading ? (
        <div className="card">Cargando...</div>
      ) : categorias.length === 0 ? (
        <div className="card">No hay categorías registradas</div>
      ) : (
        <div className="grid-3">
          {categorias.map((cat, idx) => (
            <div className="card" key={cat.id}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
                <div style={{
                  width:44, height:44, borderRadius:"50%",
                  background:"var(--kanagawa-bg-alt)",
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontSize:"20px", color:"var(--kanagawa-blue)", flexShrink:0,
                }}>
                  <i className="fa-solid fa-tag"></i>
                </div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: "14px" }}>{cat.nombre}</div>
                  {cat.descripcion && (
                    <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>{cat.descripcion}</div>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
                <span className="status active-s">
                  <span className="dot"></span>
                  Activo
                </span>
                <span style={{ fontSize: "12px", color: "#64748b" }}>
                  <i className="fa-solid fa-boxes" style={{ marginRight: "4px" }}></i>
                  {cat.productoCount ?? 0} productos
                </span>
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <button onClick={() => handleEdit(cat)} className="btn-secondary" style={{ padding: "4px 10px", fontSize: "12px" }}>
                  <i className="fa-solid fa-edit"></i> Editar
                </button>
                <button onClick={() => handleDelete(cat)} className="btn-danger" style={{ padding: "4px 10px", fontSize: "12px" }}>
                  <i className="fa-solid fa-trash"></i> Eliminar
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={selectedCategory ? "Editar Categoría" : "Nueva Categoría"}
      >
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Nombre *</label>
            <input
              type="text"
              name="nombre"
              value={formData.nombre}
              onChange={handleChange}
              className={errors.nombre ? "" : ""}
            />
            {errors.nombre && (
              <div style={{ fontSize: "12px", color: "#ef4444", marginTop: "4px" }}>{errors.nombre}</div>
            )}
          </div>
          <div className="form-group">
            <label>Descripción</label>
            <textarea
              name="descripcion"
              value={formData.descripcion}
              onChange={handleChange}
              rows={3}
            />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", paddingTop: "16px", borderTop: "1px solid #e9edf2" }}>
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="btn-secondary"
            >
              Cancelar
            </button>
            <button type="submit" className="btn-primary">
              {selectedCategory ? "Actualizar" : "Crear"}
            </button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={confirmDelete}
        title="Eliminar Categoría"
        message={`¿Estás seguro de eliminar la categoría "${categoryToDelete?.nombre}"?`}
      />
    </div>
  );
};

export default Categorias;
