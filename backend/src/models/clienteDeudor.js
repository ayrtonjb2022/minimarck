const { DataTypes, Op } = require("sequelize");
const sequelize = require("../config/database");

const ClienteDeudor = sequelize.define(
  "ClienteDeudor",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    nombre: {
      type: DataTypes.STRING(100),
      allowNull: false,
      validate: { notEmpty: true, len: [2, 100] },
    },
    documento: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    telefono: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    email: {
      type: DataTypes.STRING(100),
      allowNull: true,
      validate: { isEmail: true },
    },
    direccion: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    deudaTotal: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
      field: "deuda_total",
      validate: { min: 0 },
    },
    deudaPendiente: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
      field: "deuda_pendiente",
      validate: { min: 0 },
    },
    limiteCredito: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      field: "limite_credito",
      validate: { min: 0 },
    },
    notas: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "user_id",
      references: { model: "users", key: "id" },
      onDelete: "CASCADE",
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
    activo: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
  },
  {
    tableName: "clientes_deudores",
    timestamps: true,
    underscored: true,
    paranoid: true,
    indexes: [
      {
        unique: true,
        fields: ["documento", "negocio_id"],
        where: {
          documento: { [Op.not]: null },
          deletedAt: null,
        },
      },
      {
        fields: ["user_id"],
      },
      {
        fields: ["negocio_id"],
      },
    ],
  },
);

module.exports = ClienteDeudor;
