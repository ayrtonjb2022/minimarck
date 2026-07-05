import React, { useState, useEffect } from "react";
import ScannerModal from "../common/ScannerModal";

const PRICE_MODE = { PRECIO: "precio", MARGEN: "margen" };

const ProductForm = ({ product, categorias, onSave, onCancel, codigoPrefill }) => {
  const [formData, setFormData] = useState({
    nombre: "",
    descripcion: "",
    codigo: "",
    categoriaId: "",
    precioCompra: "",
    precio: "",
    margen: "",
    tieneIva: false,
    ivaPorcentaje: "",
    imagen: "",
    stock: "",
    stockMinimo: "",
    unidadMedida: "unidad",
  });
  const [priceMode, setPriceMode] = useState(PRICE_MODE.PRECIO);
  const [errors, setErrors] = useState({});
  const [scannerOpen, setScannerOpen] = useState(false);

  useEffect(() => {
    if (product) {
      setFormData({
        nombre: product.nombre || "",
        descripcion: product.descripcion || "",
        codigo: product.codigo || "",
        categoriaId: product.categoriaId || "",
        precioCompra: product.precioCompra || "",
        precio: product.precio || "",
        margen: product.margen || "",
        tieneIva: product.tieneIva || false,
        ivaPorcentaje: product.ivaPorcentaje || "",
        imagen: product.imagen || "",
        stock: product.stock || "",
        stockMinimo: product.stockMinimo || "",
        unidadMedida: product.unidadMedida || "unidad",
      });
      if (product.margen) setPriceMode(PRICE_MODE.MARGEN);
    } else if (codigoPrefill) {
      setFormData((prev) => ({ ...prev, codigo: codigoPrefill }));
    }
  }, [product, codigoPrefill]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData({ ...formData, [name]: type === "checkbox" ? checked : value });
    if (errors[name]) setErrors({ ...errors, [name]: "" });
  };

  const validate = () => {
    const newErrors = {};
    if (!formData.nombre) newErrors.nombre = "El nombre es requerido";
    if (priceMode === PRICE_MODE.PRECIO) {
      if (!formData.precio) newErrors.precio = "El precio de venta es requerido";
      else if (parseFloat(formData.precio) <= 0) newErrors.precio = "Debe ser mayor a 0";
    } else {
      if (!formData.margen) newErrors.margen = "El margen es requerido";
      else if (parseFloat(formData.margen) <= 0) newErrors.margen = "Debe ser mayor a 0";
    }
    if (formData.stock && parseInt(formData.stock) < 0) newErrors.stock = "El stock no puede ser negativo";
    if (formData.tieneIva && (!formData.ivaPorcentaje || parseFloat(formData.ivaPorcentaje) <= 0))
      newErrors.ivaPorcentaje = "Ingresá el porcentaje de IVA";
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!validate()) return;
    const precioCompra = parseFloat(formData.precioCompra) || 0;
    let precioFinal = priceMode === PRICE_MODE.PRECIO ? parseFloat(formData.precio) || 0 : 0;
    if (priceMode === PRICE_MODE.MARGEN && precioCompra > 0) {
      precioFinal = precioCompra * (1 + (parseFloat(formData.margen) || 0) / 100);
    }
    const submitData = {
      nombre: formData.nombre,
      descripcion: formData.descripcion,
      codigo: formData.codigo,
      categoriaId: formData.categoriaId ? parseInt(formData.categoriaId) : null,
      precioCompra,
      precio: precioFinal,
      margen: formData.margen ? parseFloat(formData.margen) : null,
      stock: parseInt(formData.stock) || 0,
      stockMinimo: parseInt(formData.stockMinimo) || 0,
      tieneIva: formData.tieneIva,
      ivaPorcentaje: formData.tieneIva && formData.ivaPorcentaje ? parseFloat(formData.ivaPorcentaje) : null,
      imagen: formData.imagen || null,
      unidadMedida: formData.unidadMedida,
    };
    onSave(submitData);
  };

  const previewPrecio = priceMode === PRICE_MODE.MARGEN && formData.precioCompra && formData.margen
    ? (parseFloat(formData.precioCompra) * (1 + parseFloat(formData.margen) / 100)).toFixed(2)
    : null;

  return (
    <form onSubmit={handleSubmit}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="form-group">
          <label>Nombre *</label>
          <input type="text" name="nombre" value={formData.nombre} onChange={handleChange} className={errors.nombre ? "error" : ""} />
          {errors.nombre && <p style={{ fontSize: 12, color: "#e46885", marginTop: 4 }}>{errors.nombre}</p>}
        </div>
        <div className="form-group">
          <label>Código</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input type="text" name="codigo" value={formData.codigo} onChange={handleChange} style={{ flex: 1 }} />
            <button type="button" onClick={() => setScannerOpen(true)} className="btn-secondary" title="Escanear código de barras" style={{ padding: "6px 12px" }}>
              <i className="fa-solid fa-camera"></i>
            </button>
          </div>
        </div>
      </div>

      <div className="form-group">
        <label>Descripción</label>
        <textarea name="descripcion" value={formData.descripcion} onChange={handleChange} rows={3} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="form-group">
          <label>Categoría</label>
          <select name="categoriaId" value={formData.categoriaId} onChange={handleChange}>
            <option value="">Sin categoría</option>
            {categorias.map((cat) => (<option key={cat.id} value={cat.id}>{cat.nombre}</option>))}
          </select>
        </div>
        <div className="form-group">
          <label>URL de imagen</label>
          <input type="text" name="imagen" value={formData.imagen} onChange={handleChange} placeholder="https://ejemplo.com/imagen.jpg" />
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="form-group">
          <label>Precio Compra ($)</label>
          <input type="number" name="precioCompra" value={formData.precioCompra} onChange={handleChange} step="0.01" min="0" />
        </div>

        <div className="form-group">
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>Precio Venta</span>
            <button type="button" onClick={() => setPriceMode(priceMode === PRICE_MODE.PRECIO ? PRICE_MODE.MARGEN : PRICE_MODE.PRECIO)}
              style={{ fontSize: 11, padding: "2px 8px", borderRadius: 6, border: "1px solid #363432", background: "#1d1c19", cursor: "pointer", color: "#8992a7" }}>
              {priceMode === PRICE_MODE.PRECIO ? "Usar margen %" : "Usar precio"}
            </button>
          </label>
          {priceMode === PRICE_MODE.PRECIO ? (
            <>
              <input type="number" name="precio" value={formData.precio} onChange={handleChange} step="0.01" min="0" className={errors.precio ? "error" : ""} />
              {errors.precio && <p style={{ fontSize: 12, color: "#e46885", marginTop: 4 }}>{errors.precio}</p>}
            </>
          ) : (
            <>
              <input type="number" name="margen" value={formData.margen} onChange={handleChange} step="0.1" min="0" placeholder="Ej: 30" className={errors.margen ? "error" : ""} />
              {errors.margen && <p style={{ fontSize: 12, color: "#e46885", marginTop: 4 }}>{errors.margen}</p>}
              {previewPrecio && <p style={{ fontSize: 12, color: "#6a9589", marginTop: 4 }}>Precio sugerido: ${previewPrecio}</p>}
            </>
          )}
        </div>

        <div className="form-group">
          <label>Unidad de medida</label>
          <select name="unidadMedida" value={formData.unidadMedida} onChange={handleChange}>
            <option value="unidad">Unidad</option>
            <option value="kg">Kilogramo (kg)</option>
            <option value="g">Gramo (g)</option>
            <option value="l">Litro (l)</option>
            <option value="ml">Mililitro (ml)</option>
            <option value="m">Metro (m)</option>
            <option value="cm">Centímetro (cm)</option>
            <option value="par">Par</option>
            <option value="caja">Caja</option>
            <option value="pack">Pack</option>
            <option value="docena">Docena</option>
          </select>
        </div>

        <div className="form-group">
          <label>Stock</label>
          <input type="number" name="stock" value={formData.stock} onChange={handleChange} min="0" className={errors.stock ? "error" : ""} />
          {errors.stock && <p style={{ fontSize: 12, color: "#e46885", marginTop: 4 }}>{errors.stock}</p>}
        </div>

        <div className="form-group">
          <label>Stock Mínimo</label>
          <input type="number" name="stockMinimo" value={formData.stockMinimo} onChange={handleChange} min="0" />
        </div>
      </div>

      <div className="form-group" style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: "#1d1c19", borderRadius: 8, border: "1px solid #363432" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", margin: 0 }}>
          <input type="checkbox" name="tieneIva" checked={formData.tieneIva} onChange={handleChange} style={{ width: 18, height: 18 }} />
          <span style={{ fontWeight: 600, fontSize: 14 }}>Tiene IVA</span>
        </label>
        {formData.tieneIva && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 8 }}>
            <input type="number" name="ivaPorcentaje" value={formData.ivaPorcentaje} onChange={handleChange} step="0.1" min="0" max="100"
              placeholder="21 %" className={errors.ivaPorcentaje ? "error" : ""}
              style={{ width: 100 }} />
            <span style={{ fontSize: 13, color: "#8992a7" }}>%</span>
            {errors.ivaPorcentaje && <p style={{ fontSize: 12, color: "#e46885", margin: 0 }}>{errors.ivaPorcentaje}</p>}
          </div>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 20, paddingTop: 16, borderTop: "1px solid #363432" }}>
        <button type="button" onClick={onCancel} className="btn-secondary">Cancelar</button>
        <button type="submit" className="btn-primary">{product ? "Actualizar" : "Crear"}</button>
      </div>

      <ScannerModal
        isOpen={scannerOpen}
        onScan={(codigo) => {
          setFormData({ ...formData, codigo });
          setScannerOpen(false);
        }}
        onClose={() => setScannerOpen(false)}
      />
    </form>
  );
};

export default ProductForm;
