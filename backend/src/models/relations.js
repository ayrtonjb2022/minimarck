const {
  User,
  Categoria,
  Producto,
  Venta,
  VentaDetalle,
  Caja,
  MovimientoCaja,
  ClienteDeudor,
  PagoDeuda,
  Negocio,
  Suscripcion,
  Proveedor,
  Compra,
  CompraDetalle,
  Auditoria,
} = require("./index");

const setupCircularRelations = () => {
  console.log("Configurando relaciones circulares...");

  // Venta <-> Caja
  Venta.belongsTo(Caja, { foreignKey: "cajaId", as: "caja" });
  Caja.hasMany(Venta, { foreignKey: "cajaId", as: "ventas", onDelete: "SET NULL" });

  // Venta <-> ClienteDeudor
  Venta.belongsTo(ClienteDeudor, { foreignKey: "deudorId", as: "deudor" });
  ClienteDeudor.hasMany(Venta, { foreignKey: "deudorId", as: "ventas", onDelete: "SET NULL" });

  // MovimientoCaja <-> Venta
  MovimientoCaja.belongsTo(Venta, { foreignKey: "ventaId", as: "venta" });
  Venta.hasMany(MovimientoCaja, { foreignKey: "ventaId", as: "movimientosCaja", onDelete: "SET NULL" });

  // PagoDeuda <-> Venta
  PagoDeuda.belongsTo(Venta, { foreignKey: "ventaId", as: "venta" });
  Venta.hasMany(PagoDeuda, { foreignKey: "ventaId", as: "pagosDeuda", onDelete: "SET NULL" });

  // MovimientoCaja <-> Compra (disabled - compras create movimientos via "Pagar" button)

  console.log("Relaciones circulares configuradas correctamente");
};

module.exports = setupCircularRelations;
