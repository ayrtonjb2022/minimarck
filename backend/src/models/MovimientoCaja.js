const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const MovimientoCaja = sequelize.define(
  "MovimientoCaja",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    tipo: {
      type: DataTypes.ENUM("ingreso", "egreso"),
      allowNull: false,
    },
    concepto: {
      type: DataTypes.STRING(200),
      allowNull: false,
      validate: { notEmpty: true, len: [3, 200] },
    },
    monto: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      validate: { min: 0.01 },
    },
    saldoAnterior: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      field: "saldo_anterior",
    },
    saldoNuevo: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      field: "saldo_nuevo",
    },
    referencia: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    cajaId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "caja_id",
      references: { model: "cajas", key: "id" },
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
    tableName: "movimientos_caja",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["caja_id"] },
      { fields: ["user_id"] },
      { fields: ["tipo"] },
      { fields: ["negocio_id"] },
      { fields: ["created_at"] },
    ],
  },
);

module.exports = MovimientoCaja;
