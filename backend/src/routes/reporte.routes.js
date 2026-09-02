const router = require("express").Router();
const { auth } = require("../middlewares/auth");
const { businessScope } = require("../middlewares/businessScope");
const {
  reporteVentas,
  reporteProductosMasVendidos,
  reporteCaja,
  reporteEstadoResultados,
  reporteGerencial,
  reporteAnalisisNegocio,
  reporteStock,
  reporteGastos,
  reporteCompras,
  reporteDeudores,
  reporteImpuestos,
  reportePuntoEquilibrio,
} = require("../controllers/reporte.controller");

// Todas las rutas requieren autenticaciÃ³n
router.use(auth);

// Scope empresarial
router.use(businessScope);

// Reportes
router.get("/ventas", reporteVentas);
router.get("/productos-mas-vendidos", reporteProductosMasVendidos);
router.get("/caja/:cajaId", reporteCaja);
router.get("/estado-resultados", reporteEstadoResultados);
router.get("/gerencial", reporteGerencial);
router.get("/analisis-negocio", reporteAnalisisNegocio);
router.get("/stock", reporteStock);
router.get("/gastos", reporteGastos);
router.get("/compras", reporteCompras);
router.get("/deudores", reporteDeudores);
router.get("/impuestos", reporteImpuestos);
router.get("/punto-equilibrio", reportePuntoEquilibrio);

module.exports = router;
