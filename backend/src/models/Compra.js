const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Compra = sequelize.define(
  "Compra",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    folio: {
      type: DataTypes.STRING(50),
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
    estado: {
      type: DataTypes.ENUM("pendiente", "completada", "cancelada"),
      allowNull: false,
      defaultValue: "pendiente",
    },
    observaciones: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    proveedorId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "proveedor_id",
      references: { model: "proveedores", key: "id" },
      onDelete: "SET NULL",
      onUpdate: "CASCADE",
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
  },
  {
    tableName: "compras",
    timestamps: true,
    underscored: true,
    paranoid: true,
    indexes: [
      { fields: ["fecha"] },
      { fields: ["proveedor_id"] },
      { fields: ["user_id"] },
      { fields: ["negocio_id"] },
    ],
  },
);

module.exports = Compra;
