import React, { useState, useEffect } from "react";

const DebtorForm = ({ deudor, onSave, onCancel }) => {
  const [formData, setFormData] = useState({
    nombre: "",
    documento: "",
    telefono: "",
    email: "",
    direccion: "",
    limiteCredito: "",
    notas: "",
  });
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (deudor) {
      setFormData({
        nombre: deudor.nombre || "",
        documento: deudor.documento || "",
        telefono: deudor.telefono || "",
        email: deudor.email || "",
        direccion: deudor.direccion || "",
        limiteCredito: deudor.limiteCredito || "",
        notas: deudor.notas || "",
      });
    }
  }, [deudor]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: value });
    if (errors[name]) {
      setErrors({ ...errors, [name]: "" });
    }
  };

  const validate = () => {
    const newErrors = {};
    if (!formData.nombre)
      newErrors.nombre = "El nombre del cliente es requerido";
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!validate()) return;

    const submitData = {
      ...formData,
      limiteCredito: parseFloat(formData.limiteCredito) || 0,
    };
    onSave(submitData);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Nombre del Cliente *
        </label>
        <input
          type="text"
          name="nombre"
          value={formData.nombre}
          onChange={handleChange}
          className={`input-field dark:bg-gray-700 dark:border-gray-600 dark:text-white ${errors.nombre ? "border-red-500" : ""}`}
        />
        {errors.nombre && (
          <p className="text-xs text-red-500 mt-1">{errors.nombre}</p>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Documento
          </label>
          <input
            type="text"
            name="documento"
            value={formData.documento}
            onChange={handleChange}
            className="input-field dark:bg-gray-700 dark:border-gray-600 dark:text-white"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Teléfono
          </label>
          <input
            type="text"
            name="telefono"
            value={formData.telefono}
            onChange={handleChange}
            className="input-field dark:bg-gray-700 dark:border-gray-600 dark:text-white"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Email
          </label>
          <input
            type="email"
            name="email"
            value={formData.email}
            onChange={handleChange}
            className="input-field dark:bg-gray-700 dark:border-gray-600 dark:text-white"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Límite de Crédito
          </label>
          <input
            type="number"
            name="limiteCredito"
            value={formData.limiteCredito}
            onChange={handleChange}
            step="0.01"
            min="0"
            className="input-field dark:bg-gray-700 dark:border-gray-600 dark:text-white"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Dirección
        </label>
        <input
          type="text"
          name="direccion"
          value={formData.direccion}
          onChange={handleChange}
          className="input-field dark:bg-gray-700 dark:border-gray-600 dark:text-white"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Notas
        </label>
        <textarea
          name="notas"
          value={formData.notas}
          onChange={handleChange}
          rows={3}
          className="input-field dark:bg-gray-700 dark:border-gray-600 dark:text-white"
        />
      </div>

      <div className="flex justify-end gap-3 pt-4 border-t border-gray-200 dark:border-gray-700">
        <button
          type="button"
          onClick={onCancel}
          className="btn-secondary dark:bg-gray-700 dark:text-white dark:hover:bg-gray-600"
        >
          Cancelar
        </button>
        <button type="submit" className="btn-primary">
          {deudor ? "Actualizar" : "Crear"}
        </button>
      </div>
    </form>
  );
};

export default DebtorForm;
