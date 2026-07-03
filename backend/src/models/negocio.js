const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Negocio = sequelize.define(
  "Negocio",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    nombre: {
      type: DataTypes.STRING(100),
      allowNull: false,
      validate: {
        notEmpty: true,
        len: [3, 100],
      },
    },
    ruc: {
      type: DataTypes.STRING(20),
      allowNull: true,
      unique: true,
    },
    direccion: {
      type: DataTypes.STRING(255),
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
    website: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    logo: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    tipoComercio: {
      type: DataTypes.ENUM(
        "despensa", "kiosco", "ferreteria", "tienda_ropa",
        "casa_electricidad", "electrodomesticos", "libreria",
        "veterinaria", "regaleria", "otro"
      ),
      allowNull: false,
      defaultValue: "otro",
      field: "tipo_comercio",
    },
    configuracion: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: {},
    },
    activo: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
  },
  {
    tableName: "negocios",
    timestamps: true,
    underscored: true,
    paranoid: true,
  },
);

module.exports = Negocio;
