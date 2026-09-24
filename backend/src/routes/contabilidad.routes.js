const { Router } = require("express");
const { auth } = require("../middlewares/auth");
const { businessScope } = require("../middlewares/businessScope");
const controller = require("../controllers/contabilidad.controller");

const router = Router();

router.use(auth);
router.use(businessScope);

// Cuentas contables
router.get("/cuentas", controller.listarCuentas);
router.post("/cuentas", controller.crearCuenta);
router.put("/cuentas/:id", controller.actualizarCuenta);
router.delete("/cuentas/:id", controller.eliminarCuenta);

// Asientos contables
router.get("/asientos", controller.listarAsientos);
router.post("/asientos", controller.crearAsiento);
router.get("/asientos/:id", controller.obtenerAsiento);
router.delete("/asientos/:id", controller.eliminarAsiento);

// Deudas
router.get("/deudas", controller.listarDeudas);
router.post("/deudas", controller.crearDeuda);
router.put("/deudas/:id", controller.actualizarDeuda);
router.post("/deudas/:id/pagos", controller.registrarPagoDeuda);
router.get("/deudas/:id/pagos", controller.listarPagosDeuda);

// Balance y Dashboard
router.get("/balance", controller.obtenerBalance);
router.get("/dashboard", controller.dashboard);

module.exports = router;
