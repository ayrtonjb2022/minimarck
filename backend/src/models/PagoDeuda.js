const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const PagoDeuda = sequelize.define(
  "PagoDeuda",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    monto: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      validate: { min: 0.01 },
    },
    fecha: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    metodoPago: {
      type: DataTypes.ENUM("efectivo", "tarjeta", "transferencia", "mixto"),
      allowNull: false,
      defaultValue: "efectivo",
      field: "metodo_pago",
    },
    referencia: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    observaciones: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    deudorId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "deudor_id",
      references: { model: "clientes_deudores", key: "id" },
      onDelete: "CASCADE",
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
    ventaId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "venta_id",
    },
  },
  {
    tableName: "pagos_deuda",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["deudor_id"] },
      { fields: ["user_id"] },
      { fields: ["negocio_id"] },
      { fields: ["fecha"] },
    ],
  },
);

module.exports = PagoDeuda;
