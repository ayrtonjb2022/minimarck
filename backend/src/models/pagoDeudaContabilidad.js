const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const PagoDeudaContabilidad = sequelize.define(
  "PagoDeudaContabilidad",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    cuentaCorrienteDeudaId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "cuenta_corriente_deuda_id",
      references: { model: "cuentas_corrientes_deudas", key: "id" },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    monto: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
    },
    fecha: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    metodoPago: {
      type: DataTypes.STRING(30),
      allowNull: false,
      field: "metodo_pago",
    },
    numeroCuota: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "numero_cuota",
    },
    observaciones: {
      type: DataTypes.TEXT,
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
    tableName: "pagos_deuda_contabilidad",
    timestamps: true,
    underscored: true,
    paranoid: false,
    indexes: [
      { fields: ["cuenta_corriente_deuda_id"] },
      { fields: ["fecha"] },
    ],
  },
);

module.exports = PagoDeudaContabilidad;
