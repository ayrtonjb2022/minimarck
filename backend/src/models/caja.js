const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Caja = sequelize.define(
  "Caja",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    fechaApertura: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: "fecha_apertura",
    },
    fechaCierre: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "fecha_cierre",
    },
    saldoInicial: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
      field: "saldo_inicial",
      validate: { min: 0 },
    },
    saldoFinal: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      field: "saldo_final",
    },
    totalIngresos: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
      field: "total_ingresos",
      validate: { min: 0 },
    },
    totalEgresos: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
      field: "total_egresos",
      validate: { min: 0 },
    },
    estado: {
      type: DataTypes.ENUM("abierta", "cerrada"),
      allowNull: false,
      defaultValue: "abierta",
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
    usuarioApertura: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "usuario_apertura",
      references: { model: "users", key: "id" },
      onDelete: "RESTRICT",
      onUpdate: "CASCADE",
    },
    usuarioCierre: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "usuario_cierre",
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
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
    tableName: "cajas",
    timestamps: true,
    underscored: true,
    paranoid: true,
    indexes: [
      { fields: ["user_id"] },
      { fields: ["estado"] },
      { fields: ["fecha_apertura"] },
      { fields: ["negocio_id"] },
    ],
  },
);

module.exports = Caja;
