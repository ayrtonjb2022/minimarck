const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const CuentaCorrienteDeuda = sequelize.define(
  "CuentaCorrienteDeuda",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    nombre: {
      type: DataTypes.STRING(150),
      allowNull: false,
    },
    tipo: {
      type: DataTypes.ENUM("prestamo_mp", "prestamo_bancario", "prestamo_personal", "proveedor", "otro"),
      allowNull: false,
    },
    montoOriginal: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      field: "monto_original",
    },
    saldoPendiente: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      field: "saldo_pendiente",
    },
    tasaInteres: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      field: "tasa_interes",
    },
    cuotasTotales: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "cuotas_totales",
    },
    cuotasPagadas: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      field: "cuotas_pagadas",
    },
    montoCuota: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
      field: "monto_cuota",
    },
    fechaInicio: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "fecha_inicio",
    },
    fechaVencimiento: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "fecha_vencimiento",
    },
    estado: {
      type: DataTypes.ENUM("activo", "pagado", "vencido"),
      defaultValue: "activo",
    },
    contactoNombre: {
      type: DataTypes.STRING(150),
      allowNull: true,
      field: "contacto_nombre",
    },
    contactoTelefono: {
      type: DataTypes.STRING(30),
      allowNull: true,
      field: "contacto_telefono",
    },
    proveedorId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "proveedor_id",
      references: { model: "proveedores", key: "id" },
      onDelete: "SET NULL",
      onUpdate: "CASCADE",
    },
    notas: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    negocioId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "negocio_id",
      references: { model: "negocios", key: "id" },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "user_id",
      references: { model: "users", key: "id" },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
  },
  {
    tableName: "cuentas_corrientes_deudas",
    timestamps: true,
    underscored: true,
    paranoid: false,
    indexes: [
      { fields: ["negocio_id"] },
      { fields: ["estado"] },
      { fields: ["tipo"] },
    ],
  },
);

module.exports = CuentaCorrienteDeuda;
