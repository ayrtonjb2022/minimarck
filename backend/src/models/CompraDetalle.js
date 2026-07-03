const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const CompraDetalle = sequelize.define(
  "CompraDetalle",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    cantidad: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: { min: 1 },
    },
    precioUnitario: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      field: "precio_unitario",
      validate: { min: 0 },
    },
    subtotal: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      validate: { min: 0 },
    },
    compraId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "compra_id",
      references: { model: "compras", key: "id" },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    productoId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "producto_id",
      references: { model: "productos", key: "id" },
      onDelete: "RESTRICT",
      onUpdate: "CASCADE",
    },
  },
  {
    tableName: "compras_detalles",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["compra_id"] },
      { fields: ["producto_id"] },
    ],
  },
);

module.exports = CompraDetalle;
