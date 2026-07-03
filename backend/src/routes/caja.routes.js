const router = require("express").Router();
const { auth } = require("../middlewares/auth");
const { businessScope } = require("../middlewares/businessScope");
const {
  abrirCaja,
  cerrarCaja,
  getCajaActiva,
  getAll,
  getById,
  getSaldoGeneral,
} = require("../controllers/caja.controller");

// Todas las rutas requieren autenticaciÃƒÆ’Ã‚Â³n
router.use(auth);

// Scope empresarial
router.use(businessScope);

// Rutas especÃƒÆ’Ã‚Â­ficas primero
router.get("/saldo-general", getSaldoGeneral);
router.get("/activa", getCajaActiva);
router.post("/apertura", abrirCaja);
router.put("/cierre/:id", cerrarCaja);

// Rutas generales
router.get("/", getAll);
router.get("/:id", getById);

module.exports = router;
