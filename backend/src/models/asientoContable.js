const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const AsientoContable = sequelize.define(
  "AsientoContable",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    fecha: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    descripcion: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    tipo: {
      type: DataTypes.ENUM("ingreso", "egreso", "ajuste", "apertura"),
      allowNull: false,
    },
    referencia: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    montoTotal: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      field: "monto_total",
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
    tableName: "asientos_contables",
    timestamps: true,
    underscored: true,
    paranoid: false,
    indexes: [
      { fields: ["negocio_id"] },
      { fields: ["fecha"] },
      { fields: ["tipo"] },
    ],
  },
);

module.exports = AsientoContable;
