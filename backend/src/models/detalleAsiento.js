const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DetalleAsiento = sequelize.define(
  "DetalleAsiento",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    asientoContableId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "asiento_contable_id",
      references: { model: "asientos_contables", key: "id" },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    cuentaContableId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "cuenta_contable_id",
      references: { model: "cuentas_contables", key: "id" },
      onDelete: "RESTRICT",
      onUpdate: "CASCADE",
    },
    debe: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 0,
    },
    haber: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 0,
    },
    descripcion: {
      type: DataTypes.STRING(200),
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
  },
  {
    tableName: "detalles_asientos",
    timestamps: true,
    underscored: true,
    paranoid: false,
    indexes: [
      { fields: ["asiento_contable_id"] },
      { fields: ["cuenta_contable_id"] },
    ],
  },
);

module.exports = DetalleAsiento;
