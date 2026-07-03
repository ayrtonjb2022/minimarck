const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Auditoria = sequelize.define(
  "Auditoria",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    tabla: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    registroId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "registro_id",
    },
    accion: {
      type: DataTypes.ENUM("CREATE", "UPDATE", "DELETE"),
      allowNull: false,
    },
    valoresAnteriores: {
      type: DataTypes.JSON,
      allowNull: true,
      field: "valores_anteriores",
    },
    valoresNuevos: {
      type: DataTypes.JSON,
      allowNull: true,
      field: "valores_nuevos",
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "user_id",
    },
    negocioId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "negocio_id",
    },
    direccionIp: {
      type: DataTypes.STRING(45),
      allowNull: true,
      field: "direccion_ip",
    },
  },
  {
    tableName: "auditoria",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["tabla"] },
      { fields: ["registro_id"] },
      { fields: ["user_id"] },
      { fields: ["negocio_id"] },
      { fields: ["created_at"] },
    ],
  },
);

module.exports = Auditoria;
