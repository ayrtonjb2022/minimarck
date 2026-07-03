const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const VentaDetalle = sequelize.define(
  "VentaDetalle",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    cantidad: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        min: 1,
      },
    },
    precioUnitario: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      field: "precio_unitario", // ← Importante: nombre en DB
      validate: {
        min: 0,
      },
    },
    nombreProducto: {
      type: DataTypes.STRING(200),
      allowNull: true,
      field: "nombre_producto",
    },
    descuento: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
      validate: {
        min: 0,
      },
    },
    subtotal: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      validate: {
        min: 0,
      },
    },
    ventaId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "venta_id", // ← Importante: nombre en DB
      references: {
        model: "ventas",
        key: "id",
      },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    productoId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "producto_id",
      references: {
        model: "productos",
        key: "id",
      },
      onDelete: "SET NULL",
      onUpdate: "CASCADE",
    },
  },
  {
    tableName: "ventas_detalles",
    timestamps: true,
    underscored: true,
    indexes: [
      {
        fields: ["venta_id"], // ← Usar snake_case
      },
      {
        fields: ["producto_id"], // ← Usar snake_case
      },
    ],
  },
);

module.exports = VentaDetalle;
