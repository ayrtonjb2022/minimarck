const router = require("express").Router();
const { auth } = require("../middlewares/auth");
const { businessScope } = require("../middlewares/businessScope");
const {
  getAll,
  getById,
  create,
  update,
  remove,
  registrarPago,
  getPagos,
} = require("../controllers/deudor.controller");

// ========== MIDDLEWARES DE SEGURIDAD ==========

// Todas las rutas requieren autenticaciÃƒÆ’Ã‚Â³n
router.use(auth);

// Scope empresarial
router.use(businessScope);

// ========== RUTAS PRINCIPALES ==========

// GET /api/deudores - Listar todos
router.get("/", getAll);

// POST /api/deudores - Crear nuevo
router.post("/", create);

// GET /api/deudores/:id - Obtener uno
router.get("/:id", getById);

// PUT /api/deudores/:id - Actualizar
router.put(
  "/:id",
  update,
);

// DELETE /api/deudores/:id - Eliminar
router.delete(
  "/:id",
  remove,
);

// ========== RUTAS DE PAGOS ==========

// POST /api/deudores/:id/pagos - Registrar pago
router.post(
  "/:id/pagos",
  registrarPago,
);

// GET /api/deudores/:id/pagos - Ver historial de pagos
router.get(
  "/:id/pagos",
  getPagos,
);

module.exports = router;
