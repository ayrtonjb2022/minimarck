const { DataTypes, Op } = require("sequelize");
const sequelize = require("../config/database");

const Producto = sequelize.define(
  "Producto",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    nombre: {
      type: DataTypes.STRING(200),
      allowNull: false,
      validate: {
        notEmpty: true,
        len: [2, 200],
      },
    },
    descripcion: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    codigo: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    precio: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
      validate: { min: 0 },
    },
    precioCompra: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: 0,
      field: "precio_compra",
      validate: { min: 0 },
    },
    stock: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      validate: { min: 0 },
    },
    stockMinimo: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 5,
      field: "stock_minimo",
      validate: { min: 0 },
    },
    categoriaId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "categoria_id",
      references: {
        model: "categorias",
        key: "id",
      },
      onDelete: "SET NULL",
      onUpdate: "CASCADE",
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "user_id",
      references: {
        model: "users",
        key: "id",
      },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
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
    activo: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    imagen: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    tieneIva: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      field: "tiene_iva",
    },
    ivaPorcentaje: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      defaultValue: null,
      field: "iva_porcentaje",
    },
    margen: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      defaultValue: null,
    },
    unidadMedida: {
      type: DataTypes.ENUM("unidad", "kg", "g", "l", "ml", "m", "cm", "par", "caja", "pack", "docena"),
      defaultValue: "unidad",
      field: "unidad_medida",
    },
  },
  {
    tableName: "productos",
    timestamps: true,
    underscored: true,
    paranoid: true,
    indexes: [
      {
        unique: true,
        fields: ["codigo", "negocio_id"],
        where: {
          codigo: { [Op.not]: null },
          deletedAt: null,
        },
      },
      {
        fields: ["user_id", "activo"],
      },
      {
        fields: ["categoria_id"],
      },
      {
        fields: ["negocio_id"],
      },
    ],
  },
);

module.exports = Producto;
