const router = require("express").Router();
const { auth } = require("../middlewares/auth");
const { businessScope } = require("../middlewares/businessScope");
const {
  getAll,
  getById,
  create,
  update,
  remove,
} = require("../controllers/categoria.controller");

// Todas las rutas requieren autenticaciÃƒÆ’Ã‚Â³n
router.use(auth);

// Scope empresarial
router.use(businessScope);

// Listar categorÃƒÆ’Ã‚Â­as
router.get("/", getAll);

// Obtener categorÃƒÆ’Ã‚Â­a por ID
router.get("/:id", getById);

// Crear categorÃƒÆ’Ã‚Â­a (admin y supervisor)
router.post("/", create);

// Actualizar categorÃƒÆ’Ã‚Â­a
router.put(
  "/:id",
  update,
);

// Eliminar categorÃƒÆ’Ã‚Â­a
router.delete(
  "/:id",
  remove,
);

module.exports = router;
