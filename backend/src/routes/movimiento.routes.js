const router = require("express").Router();
const { auth } = require("../middlewares/auth");
const { businessScope } = require("../middlewares/businessScope");
const {
  create,
  getByCaja,
  getResumen,
} = require("../controllers/movimiento.controller");

// Todas las rutas requieren autenticaciÃƒÆ’Ã‚Â³n
router.use(auth);

// Scope empresarial
router.use(businessScope);

// Registrar movimiento
router.post("/", create);

// Obtener movimientos por caja
router.get("/caja/:cajaId", getByCaja);

// Resumen de movimientos
router.get("/resumen/:cajaId", getResumen);

module.exports = router;
