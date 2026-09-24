const User = require("./user");
const Categoria = require("./Categoria");
const Producto = require("./producto");
const Venta = require("./venta");
const VentaDetalle = require("./venta.detalle");
const Caja = require("./caja");
const MovimientoCaja = require("./MovimientoCaja");
const ClienteDeudor = require("./clienteDeudor");
const PagoDeuda = require("./PagoDeuda");
const Negocio = require("./negocio");
const Suscripcion = require("./Suscripcion");
const Proveedor = require("./Proveedor");
const Compra = require("./Compra");
const CompraDetalle = require("./CompraDetalle");
const Auditoria = require("./Auditoria");
const CuentaContable = require("./cuentaContable");
const AsientoContable = require("./asientoContable");
const DetalleAsiento = require("./detalleAsiento");
const CuentaCorrienteDeuda = require("./cuentaCorrienteDeuda");
const PagoDeudaContabilidad = require("./pagoDeudaContabilidad");

// ========== ASOCIACIONES NO CIRCULARES ==========

// Negocio <-> User
User.belongsTo(Negocio, { foreignKey: "negocioId", as: "negocio" });
Negocio.hasMany(User, { foreignKey: "negocioId", as: "usuarios", onDelete: "SET NULL" });

// Negocio <-> Suscripcion (1:1)
Suscripcion.belongsTo(Negocio, { foreignKey: "negocioId", as: "negocio" });
Negocio.hasOne(Suscripcion, { foreignKey: "negocioId", as: "suscripcion", onDelete: "CASCADE" });

// Negocio <-> Categoria
Categoria.belongsTo(Negocio, { foreignKey: "negocioId", as: "negocio" });
Negocio.hasMany(Categoria, { foreignKey: "negocioId", as: "categorias", onDelete: "CASCADE" });

// Negocio <-> Producto
Producto.belongsTo(Negocio, { foreignKey: "negocioId", as: "negocio" });
Negocio.hasMany(Producto, { foreignKey: "negocioId", as: "productos", onDelete: "CASCADE" });

// Negocio <-> Venta
Venta.belongsTo(Negocio, { foreignKey: "negocioId", as: "negocio" });
Negocio.hasMany(Venta, { foreignKey: "negocioId", as: "ventas", onDelete: "CASCADE" });

// Negocio <-> Caja
Caja.belongsTo(Negocio, { foreignKey: "negocioId", as: "negocio" });
Negocio.hasMany(Caja, { foreignKey: "negocioId", as: "cajas", onDelete: "CASCADE" });

// Negocio <-> MovimientoCaja
MovimientoCaja.belongsTo(Negocio, { foreignKey: "negocioId", as: "negocio" });
Negocio.hasMany(MovimientoCaja, { foreignKey: "negocioId", as: "movimientosCaja", onDelete: "CASCADE" });

// Negocio <-> ClienteDeudor
ClienteDeudor.belongsTo(Negocio, { foreignKey: "negocioId", as: "negocio" });
Negocio.hasMany(ClienteDeudor, { foreignKey: "negocioId", as: "clientesDeudores", onDelete: "CASCADE" });

// Negocio <-> PagoDeuda
PagoDeuda.belongsTo(Negocio, { foreignKey: "negocioId", as: "negocio" });
Negocio.hasMany(PagoDeuda, { foreignKey: "negocioId", as: "pagosDeuda", onDelete: "CASCADE" });

// Negocio <-> Proveedor
Proveedor.belongsTo(Negocio, { foreignKey: "negocioId", as: "negocio" });
Negocio.hasMany(Proveedor, { foreignKey: "negocioId", as: "proveedores", onDelete: "CASCADE" });

// Negocio <-> Compra
Compra.belongsTo(Negocio, { foreignKey: "negocioId", as: "negocio" });
Negocio.hasMany(Compra, { foreignKey: "negocioId", as: "compras", onDelete: "CASCADE" });

// Negocio <-> Auditoria
Auditoria.belongsTo(Negocio, { foreignKey: "negocioId", as: "negocio" });
Negocio.hasMany(Auditoria, { foreignKey: "negocioId", as: "auditorias", onDelete: "CASCADE" });

// Categoria <-> User
Categoria.belongsTo(User, { foreignKey: "userId", as: "usuario" });
User.hasMany(Categoria, { foreignKey: "userId", as: "categorias", onDelete: "CASCADE" });

// Producto
Producto.belongsTo(User, { foreignKey: "userId", as: "usuario" });
User.hasMany(Producto, { foreignKey: "userId", as: "productos", onDelete: "CASCADE" });
Producto.belongsTo(Categoria, { foreignKey: "categoriaId", as: "categoria" });
Categoria.hasMany(Producto, { foreignKey: "categoriaId", as: "productos", onDelete: "SET NULL" });

// Venta (solo relación con User)
Venta.belongsTo(User, { foreignKey: "userId", as: "usuario" });
User.hasMany(Venta, { foreignKey: "userId", as: "ventas", onDelete: "RESTRICT" });

// VentaDetalle
VentaDetalle.belongsTo(Venta, { foreignKey: "ventaId", as: "venta" });
Venta.hasMany(VentaDetalle, { foreignKey: "ventaId", as: "detalles", onDelete: "CASCADE" });
VentaDetalle.belongsTo(Producto, { foreignKey: "productoId", as: "producto" });
Producto.hasMany(VentaDetalle, { foreignKey: "productoId", as: "ventaDetalles", onDelete: "RESTRICT" });

// Caja (relaciones con User)
Caja.belongsTo(User, { foreignKey: "userId", as: "propietario" });
User.hasMany(Caja, { foreignKey: "userId", as: "cajas", onDelete: "RESTRICT" });
Caja.belongsTo(User, { foreignKey: "usuarioApertura", as: "usuarioQueAbre" });
Caja.belongsTo(User, { foreignKey: "usuarioCierre", as: "usuarioQueCierra" });

// MovimientoCaja
MovimientoCaja.belongsTo(Caja, { foreignKey: "cajaId", as: "caja" });
Caja.hasMany(MovimientoCaja, { foreignKey: "cajaId", as: "movimientos", onDelete: "CASCADE" });
MovimientoCaja.belongsTo(User, { foreignKey: "userId", as: "usuario" });
User.hasMany(MovimientoCaja, { foreignKey: "userId", as: "movimientosCaja", onDelete: "RESTRICT" });

// ClienteDeudor
ClienteDeudor.belongsTo(User, { foreignKey: "userId", as: "propietario" });
User.hasMany(ClienteDeudor, { foreignKey: "userId", as: "clientesDeudores", onDelete: "CASCADE" });

// PagoDeuda
PagoDeuda.belongsTo(ClienteDeudor, { foreignKey: "deudorId", as: "deudor" });
ClienteDeudor.hasMany(PagoDeuda, { foreignKey: "deudorId", as: "pagos", onDelete: "CASCADE" });
PagoDeuda.belongsTo(User, { foreignKey: "userId", as: "usuario" });
User.hasMany(PagoDeuda, { foreignKey: "userId", as: "pagosDeuda", onDelete: "RESTRICT" });

// Proveedor <-> Compra
Compra.belongsTo(Proveedor, { foreignKey: "proveedorId", as: "proveedor" });
Proveedor.hasMany(Compra, { foreignKey: "proveedorId", as: "compras", onDelete: "SET NULL" });

// Compra <-> User
Compra.belongsTo(User, { foreignKey: "userId", as: "usuario" });
User.hasMany(Compra, { foreignKey: "userId", as: "compras", onDelete: "RESTRICT" });

// CompraDetalle
CompraDetalle.belongsTo(Compra, { foreignKey: "compraId", as: "compra" });
Compra.hasMany(CompraDetalle, { foreignKey: "compraId", as: "detalles", onDelete: "CASCADE" });
CompraDetalle.belongsTo(Producto, { foreignKey: "productoId", as: "producto" });
Producto.hasMany(CompraDetalle, { foreignKey: "productoId", as: "compraDetalles", onDelete: "RESTRICT" });

// Auditoria
Auditoria.belongsTo(User, { foreignKey: "userId", as: "usuario" });
User.hasMany(Auditoria, { foreignKey: "userId", as: "auditorias", onDelete: "SET NULL" });

// ========== CONTABILIDAD ==========

// Negocio <-> CuentaContable
CuentaContable.belongsTo(Negocio, { foreignKey: "negocioId", as: "negocio" });
Negocio.hasMany(CuentaContable, { foreignKey: "negocioId", as: "cuentasContables", onDelete: "CASCADE" });

// CuentaContable <-> User
CuentaContable.belongsTo(User, { foreignKey: "userId", as: "usuario" });
User.hasMany(CuentaContable, { foreignKey: "userId", as: "cuentasContables", onDelete: "CASCADE" });

// CuentaContable self-referencing (parent → sub-cuentas)
CuentaContable.hasMany(CuentaContable, { foreignKey: "parentId", as: "hijas", onDelete: "SET NULL" });
CuentaContable.belongsTo(CuentaContable, { foreignKey: "parentId", as: "padre" });

// Negocio <-> AsientoContable
AsientoContable.belongsTo(Negocio, { foreignKey: "negocioId", as: "negocio" });
Negocio.hasMany(AsientoContable, { foreignKey: "negocioId", as: "asientosContables", onDelete: "CASCADE" });

// AsientoContable <-> User
AsientoContable.belongsTo(User, { foreignKey: "userId", as: "usuario" });
User.hasMany(AsientoContable, { foreignKey: "userId", as: "asientosContables", onDelete: "CASCADE" });

// AsientoContable <-> DetalleAsiento
DetalleAsiento.belongsTo(AsientoContable, { foreignKey: "asientoContableId", as: "asiento" });
AsientoContable.hasMany(DetalleAsiento, { foreignKey: "asientoContableId", as: "detalles", onDelete: "CASCADE" });

// DetalleAsiento <-> CuentaContable
DetalleAsiento.belongsTo(CuentaContable, { foreignKey: "cuentaContableId", as: "cuenta" });
CuentaContable.hasMany(DetalleAsiento, { foreignKey: "cuentaContableId", as: "detallesAsiento" });

// DetalleAsiento <-> Negocio
DetalleAsiento.belongsTo(Negocio, { foreignKey: "negocioId", as: "negocio" });

// Negocio <-> CuentaCorrienteDeuda
CuentaCorrienteDeuda.belongsTo(Negocio, { foreignKey: "negocioId", as: "negocio" });
Negocio.hasMany(CuentaCorrienteDeuda, { foreignKey: "negocioId", as: "cuentasCorrientesDeudas", onDelete: "CASCADE" });

// CuentaCorrienteDeuda <-> User
CuentaCorrienteDeuda.belongsTo(User, { foreignKey: "userId", as: "usuario" });
User.hasMany(CuentaCorrienteDeuda, { foreignKey: "userId", as: "cuentasCorrientesDeudas", onDelete: "CASCADE" });

// CuentaCorrienteDeuda <-> Proveedor (optional)
CuentaCorrienteDeuda.belongsTo(Proveedor, { foreignKey: "proveedorId", as: "proveedor" });

// CuentaCorrienteDeuda <-> PagoDeudaContabilidad
PagoDeudaContabilidad.belongsTo(CuentaCorrienteDeuda, { foreignKey: "cuentaCorrienteDeudaId", as: "deuda" });
CuentaCorrienteDeuda.hasMany(PagoDeudaContabilidad, { foreignKey: "cuentaCorrienteDeudaId", as: "pagos", onDelete: "CASCADE" });

// PagoDeudaContabilidad <-> User
PagoDeudaContabilidad.belongsTo(User, { foreignKey: "userId", as: "usuario" });
User.hasMany(PagoDeudaContabilidad, { foreignKey: "userId", as: "pagosDeudaContabilidad", onDelete: "CASCADE" });

// PagoDeudaContabilidad <-> Negocio
PagoDeudaContabilidad.belongsTo(Negocio, { foreignKey: "negocioId", as: "negocio" });

module.exports = {
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
  CuentaContable,
  AsientoContable,
  DetalleAsiento,
  CuentaCorrienteDeuda,
  PagoDeudaContabilidad,
};
