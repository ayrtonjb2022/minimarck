const router = require("express").Router();
const { auth } = require("../middlewares/auth");
const { businessScope } = require("../middlewares/businessScope");
const { getStats } = require("../controllers/dashboard.controller");

// Todas las rutas requieren autenticaciÃ³n
router.use(auth);

// Scope empresarial
router.use(businessScope);

router.get("/stats", getStats);

module.exports = router;
