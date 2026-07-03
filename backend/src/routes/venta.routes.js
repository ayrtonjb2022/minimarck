const router = require("express").Router();
const { auth } = require("../middlewares/auth");
const { businessScope } = require("../middlewares/businessScope");
const { create, getAll, getById } = require("../controllers/venta.controller");

// Todas las rutas requieren autenticaciÃƒÆ’Ã‚Â³n
router.use(auth);

// Scope empresarial
router.use(businessScope);

// Crear venta
router.post("/", create);

// Listar ventas
router.get("/", getAll);

// Obtener venta por ID
router.get("/:id", getById);

module.exports = router;
