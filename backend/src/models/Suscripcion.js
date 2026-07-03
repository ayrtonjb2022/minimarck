const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Suscripcion = sequelize.define(
  "Suscripcion",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    plan: {
      type: DataTypes.ENUM("basico", "premium"),
      allowNull: false,
      defaultValue: "basico",
    },
    maxUsuarios: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 2,
      field: "max_usuarios",
    },
    maxProductos: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 14,
      field: "max_productos",
    },
    features: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: {},
    },
    activa: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    fechaInicio: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: "fecha_inicio",
    },
    fechaVencimiento: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "fecha_vencimiento",
    },
    negocioId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "negocio_id",
      references: {
        model: "negocios",
        key: "id",
      },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
  },
  {
    tableName: "suscripciones",
    timestamps: true,
    underscored: true,
  },
);

module.exports = Suscripcion;
