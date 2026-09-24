const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Venta = sequelize.define(
  "Venta",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    folio: {
      // `V-${crypto.randomUUID()}` tiene 38 caracteres; 20 desborda en modo
      // estricto (error 1406) en cada Venta.create
      type: DataTypes.STRING(40),
      allowNull: false,
    },
    fecha: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    subtotal: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
      validate: { min: 0 },
    },
    iva: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
      validate: { min: 0 },
    },
    descuento: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
      validate: { min: 0 },
    },
    total: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
      validate: { min: 0 },
    },
    metodoPago: {
      type: DataTypes.ENUM(
        "efectivo",
        "tarjeta",
        "transferencia",
        "credito",
        "mixto",
      ),
      allowNull: false,
      defaultValue: "efectivo",
      field: "metodo_pago",
    },
    estado: {
      type: DataTypes.ENUM("completada", "cancelada", "pendiente"),
      allowNull: false,
      defaultValue: "completada",
    },
    clienteNombre: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: "cliente_nombre",
    },
    clienteDocumento: {
      type: DataTypes.STRING(20),
      allowNull: true,
      field: "cliente_documento",
    },
    observaciones: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "user_id",
      references: { model: "users", key: "id" },
      onDelete: "RESTRICT",
      onUpdate: "CASCADE",
    },
    negocioId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "negocio_id",
      references: { model: "negocios", key: "id" },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    cajaId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "caja_id",
    },
    deudorId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "deudor_id",
    },
    idempotencyKey: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: "idempotency_key",
    },
  },
  {
    tableName: "ventas",
    timestamps: true,
    underscored: true,
    paranoid: true,
    indexes: [
      { fields: ["fecha"] },
      { fields: ["user_id"] },
      { fields: ["caja_id"] },
      { fields: ["deudor_id"] },
      { fields: ["negocio_id"] },
      {
        unique: true,
        fields: ["folio", "negocio_id"],
        where: { deletedAt: null },
      },
      {
        unique: true,
        fields: ["negocio_id", "idempotency_key"],
      },
    ],
  },
);

module.exports = Venta;
