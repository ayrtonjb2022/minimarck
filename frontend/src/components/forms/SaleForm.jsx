import React, { useState } from "react";
import { formatCurrency } from "../../utils/formatters";
import { METODO_PAGO_LABELS, METODOS_PAGO } from "../../utils/constants";

const METODOS_PAGO_LIST = [
  METODOS_PAGO.EFECTIVO,
  METODOS_PAGO.TARJETA,
  METODOS_PAGO.TRANSFERENCIA,
  METODOS_PAGO.CREDITO,
  METODOS_PAGO.MIXTO,
];

const SaleForm = ({ productos, onSave, onCancel }) => {
  const [items, setItems] = useState([]);
  const [nombre, setNombre] = useState("");
  const [precio, setPrecio] = useState("");
  const [cantidad, setCantidad] = useState(1);
  const [metodoPago, setMetodoPago] = useState(METODOS_PAGO.EFECTIVO);
  const [errors, setErrors] = useState({});

  const handleSelectProducto = (e) => {
    const prod = productos.find((p) => p.id === parseInt(e.target.value));
    if (!prod) return;
    setNombre(prod.nombre);
    setPrecio(prod.precio || "");
    setCantidad(1);
    setErrors({});
  };

  const agregarItem = () => {
    if (!nombre.trim()) { setErrors({ ...errors, nombre: "Nombre requerido" }); return; }
    if (!precio || parseFloat(precio) <= 0) { setErrors({ ...errors, precio: "Precio inválido" }); return; }
    const p = parseFloat(precio);
    const q = parseInt(cantidad) || 1;
    const prodSeleccionado = productos.find((pr) => pr.nombre === nombre.trim());
    if (prodSeleccionado && q > (prodSeleccionado.stock ?? 0)) {
      setErrors({ ...errors, cantidad: `Stock insuficiente. Disponible: ${prodSeleccionado.stock}` });
      return;
    }
    setItems([...items, { productoId: prodSeleccionado?.id, nombre: nombre.trim(), cantidad: q, precioUnitario: p, subtotal: q * p }]);
    setNombre(""); setPrecio(""); setCantidad(1); setErrors({});
  };

  const changeQty = (idx, delta) => {
    const item = items[idx];
    if (!item) return;
    const newQty = item.cantidad + delta;
    if (newQty < 1) { removeItem(idx); return; }
    setItems(items.map((i, ix) =>
      ix === idx ? { ...i, cantidad: newQty, subtotal: newQty * i.precioUnitario } : i
    ));
  };

  const removeItem = (idx) => {
    setItems(items.filter((_, i) => i !== idx));
  };

  const calculateTotal = () => {
    return items.reduce((sum, item) => sum + item.subtotal, 0);
  };

  const validate = () => {
    const newErrors = {};
    if (items.length === 0) newErrors.items = "Agrega al menos un producto";
    if (calculateTotal() <= 0) newErrors.total = "El total debe ser mayor a 0";
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    if (!validate()) return;
    onSave({
      items: items.map(({ productoId, cantidad, precioUnitario, nombre }) => ({ productoId, cantidad, precioUnitario, nombre })),
      metodoPago,
    });
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); agregarItem(); }
  };

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#8992a7", marginBottom: 6 }}>Agregar producto</label>
        {productos.length > 0 && (
          <div className="form-group" style={{ marginBottom: 8 }}>
            <select onChange={handleSelectProducto} defaultValue="">
              <option value="" disabled>Seleccionar del catálogo...</option>
              {productos.filter((p) => p.activo).map((p) => (
                <option key={p.id} value={p.id}>{p.nombre} — ${parseFloat(p.precio||0).toFixed(2)} ({p.stock ?? 0} uds.)</option>
              ))}
            </select>
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <input type="text" value={nombre} onChange={(e) => setNombre(e.target.value)} onKeyDown={handleKeyDown} placeholder="Nombre del producto" className="input-field" style={{ flex: 1 }} />
          <input type="number" min="0" step="0.01" value={precio} onChange={(e) => setPrecio(e.target.value)} onKeyDown={handleKeyDown} placeholder="Precio" className="input-field" style={{ width: 120 }} />
          <input type="number" min="1" value={cantidad} onChange={(e) => setCantidad(e.target.value)} onKeyDown={handleKeyDown} className="input-field" style={{ width: 80 }} />
          <button onClick={agregarItem} className="btn-primary"><i className="fa-solid fa-plus"></i></button>
        </div>
        {errors.nombre && <p style={{ fontSize: 12, color: "#e46885", marginTop: 4 }}>{errors.nombre}</p>}
        {errors.precio && <p style={{ fontSize: 12, color: "#e46885", marginTop: 4 }}>{errors.precio}</p>}
      </div>

      <div style={{ border: "1px solid #363432", borderRadius: 12, overflow: "hidden", marginBottom: 16 }}>
        {items.length === 0 ? (
          <div style={{ textAlign: "center", padding: 20, color: "#6a6a6b", fontSize: 13 }}>Agregá productos usando el formulario de arriba</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ background: "#1d1c19" }}>
                <th style={{ padding: "8px 12px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "#8992a7" }}>Producto</th>
                <th style={{ padding: "8px 12px", textAlign: "center", fontSize: 12, fontWeight: 600, color: "#8992a7" }}>Cant.</th>
                <th style={{ padding: "8px 12px", textAlign: "right", fontSize: 12, fontWeight: 600, color: "#8992a7" }}>Precio</th>
                <th style={{ padding: "8px 12px", textAlign: "right", fontSize: 12, fontWeight: 600, color: "#8992a7" }}>Subtotal</th>
                <th style={{ padding: "8px 12px", textAlign: "center", fontSize: 12, fontWeight: 600, color: "#8992a7" }}></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, idx) => (
                <tr key={item.productoId ?? idx} style={{ borderTop: "1px solid #363432" }}>
                  <td style={{ padding: "8px 12px" }}>{item.nombre}</td>
                  <td style={{ padding: "8px 12px", textAlign: "center" }}>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <button onClick={() => changeQty(idx, -1)} style={{ width: 24, height: 24, borderRadius: "50%", border: "1px solid #363432", background: "#181616", cursor: "pointer", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center", color: "#c5c9c5" }}>-</button>
                      <span style={{ fontWeight: 700, minWidth: 20, textAlign: "center", fontSize: 14, color: "#c5c9c5" }}>{item.cantidad}</span>
                      <button onClick={() => changeQty(idx, 1)} style={{ width: 24, height: 24, borderRadius: "50%", border: "1px solid #363432", background: "#181616", cursor: "pointer", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center", color: "#c5c9c5" }}>+</button>
                    </div>
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "right" }}>{formatCurrency(item.precioUnitario)}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600 }}>{formatCurrency(item.subtotal)}</td>
                  <td style={{ padding: "8px 12px", textAlign: "center" }}>
                    <button onClick={() => removeItem(idx)} style={{ color: "#e46885", background: "none", border: "none", cursor: "pointer", padding: 4 }}>
                      <i className="fa-regular fa-circle-xmark" style={{ fontSize: 18 }}></i>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {errors.items && <p style={{ fontSize: 12, color: "#e46885", marginBottom: 8 }}>{errors.items}</p>}

      <div className="form-group">
        <label>Método de Pago</label>
        <select value={metodoPago} onChange={(e) => setMetodoPago(e.target.value)}>
          {METODOS_PAGO_LIST.map((key) => (
            <option key={key} value={key}>{METODO_PAGO_LABELS[key]}</option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#1d1c19", padding: "12px 16px", borderRadius: 10, margin: "16px 0", border: "1px solid #363432" }}>
        <span style={{ fontWeight: 600, color: "#8992a7", fontSize: 14 }}>Total:</span>
        <span style={{ fontSize: 24, fontWeight: 700, color: "#7e9cd8" }}>{formatCurrency(calculateTotal())}</span>
      </div>
      {errors.total && <p style={{ fontSize: 12, color: "#e46885", marginBottom: 8 }}>{errors.total}</p>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" onClick={onCancel} className="btn-secondary">Cancelar</button>
        <button onClick={handleSubmit} className="btn-success"><i className="fa-solid fa-check"></i> Registrar Venta</button>
      </div>
    </div>
  );
};

export default SaleForm;
