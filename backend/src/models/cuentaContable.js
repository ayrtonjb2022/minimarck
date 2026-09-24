const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const CuentaContable = sequelize.define(
  "CuentaContable",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    codigo: {
      type: DataTypes.STRING(20),
      allowNull: false,
      unique: true,
    },
    nombre: {
      type: DataTypes.STRING(150),
      allowNull: false,
    },
    tipo: {
      type: DataTypes.ENUM("activo", "pasivo", "capital", "ingreso", "gasto"),
      allowNull: false,
    },
    descripcion: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    parentId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "parent_id",
      references: { model: "cuentas_contables", key: "id" },
      onDelete: "SET NULL",
      onUpdate: "CASCADE",
    },
    activo: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
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
    tableName: "cuentas_contables",
    timestamps: true,
    underscored: true,
    paranoid: false,
    indexes: [
      { fields: ["negocio_id"] },
      { fields: ["codigo"] },
      { fields: ["tipo"] },
    ],
  },
);

module.exports = CuentaContable;
