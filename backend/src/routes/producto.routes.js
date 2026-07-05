const router = require("express").Router();
const { auth } = require("../middlewares/auth");
const { businessScope } = require("../middlewares/businessScope");
const {
  getAll,
  getById,
  getByCode,
  create,
  update,
  remove,
} = require("../controllers/producto.controller");

// Todas las rutas requieren autenticaciÃƒÆ’Ã‚Â³n
router.use(auth);

// Scope empresarial
router.use(businessScope);

// Listar productos (scope por negocio)
router.get("/", getAll);

// Buscar por código de barras (va antes de /:id para que no compita)
router.get("/codigo/:codigo", getByCode);

// Obtener producto por ID
router.get("/:id", getById);

// Crear producto (cualquier rol autenticado)
router.post("/", create);

// Actualizar producto
router.put("/:id", update);

// Eliminar producto
router.delete("/:id", remove);

module.exports = router;
