import React, { useState } from "react";
import { formatCurrency } from "../../utils/formatters";
import { METODO_PAGO_LABELS, METODOS_PAGO } from "../../utils/constants";

const PaymentForm = ({ deudor, onSave, onCancel }) => {
  const [formData, setFormData] = useState({
    monto: "",
    metodoPago: METODOS_PAGO.EFECTIVO,
    referencia: "",
    observaciones: "",
  });
  const [errors, setErrors] = useState({});

  const saldoPendiente = deudor?.deudaPendiente || 0;

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: value });
    if (errors[name]) {
      setErrors({ ...errors, [name]: "" });
    }
  };

  const validate = () => {
    const newErrors = {};
    if (!formData.monto) {
      newErrors.monto = "El monto es requerido";
    } else if (parseFloat(formData.monto) <= 0) {
      newErrors.monto = "El monto debe ser mayor a 0";
    } else if (parseFloat(formData.monto) > saldoPendiente) {
      newErrors.monto = `El monto no puede exceder el saldo pendiente (${formatCurrency(saldoPendiente)})`;
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!validate()) return;

    onSave({
      monto: parseFloat(formData.monto),
      metodoPago: formData.metodoPago,
      referencia: formData.referencia,
      observaciones: formData.observaciones,
    });
  };

  return (
    <form onSubmit={handleSubmit}>
      <div style={{ background: "#1d1c19", borderRadius: 12, padding: 16, marginBottom: 16, border: "1px solid #363432" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 13, color: "#8992a7" }}>Cliente:</span>
          <span style={{ fontWeight: 500, fontSize: 14, color: "#c5c9c5" }}>{deudor?.nombre}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
          <span style={{ fontSize: 13, color: "#8992a7" }}>Saldo Pendiente:</span>
          <span style={{ fontWeight: 700, color: "#e46885" }}>{formatCurrency(saldoPendiente)}</span>
        </div>
      </div>

      <div className="form-group">
        <label>Monto del Pago *</label>
        <input type="number" name="monto" value={formData.monto} onChange={handleChange} step="0.01" min="0.01" max={saldoPendiente}
          placeholder={`Máximo: ${formatCurrency(saldoPendiente)}`} className={errors.monto ? "error" : ""} />
        {errors.monto && <p style={{ fontSize: 12, color: "#e46885", marginTop: 4 }}>{errors.monto}</p>}
      </div>

      <div className="form-group">
        <label>Método de Pago</label>
        <select name="metodoPago" value={formData.metodoPago} onChange={handleChange}>
          {Object.entries(METODO_PAGO_LABELS).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
      </div>

      <div className="form-group">
        <label>Referencia</label>
        <input type="text" name="referencia" value={formData.referencia} onChange={handleChange} placeholder="N° de comprobante, voucher, etc." />
      </div>

      <div className="form-group">
        <label>Observaciones</label>
        <textarea name="observaciones" value={formData.observaciones} onChange={handleChange} rows={3} placeholder="Opcional - Detalle del pago" />
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 16, borderTop: "1px solid #363432", marginTop: 8 }}>
        <button type="button" onClick={onCancel} className="btn-secondary">Cancelar</button>
        <button type="submit" className="btn-success">Registrar Pago</button>
      </div>
    </form>
  );
};

export default PaymentForm;
