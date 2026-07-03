const router = require("express").Router();
const { auth } = require("../middlewares/auth");
const { businessScope } = require("../middlewares/businessScope");
const {
  reporteVentas,
  reporteProductosMasVendidos,
  reporteCaja,
  reporteEstadoResultados,
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

module.exports = router;
