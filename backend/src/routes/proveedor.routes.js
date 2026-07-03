const { Router } = require("express");
const { auth } = require("../middlewares/auth");
const { businessScope } = require("../middlewares/businessScope");
const controller = require("../controllers/proveedor.controller");

const router = Router();

router.use(auth);
router.use(businessScope);

router.get("/", controller.getAll);
router.get("/:id", controller.getById);
router.post("/", controller.create);
router.put("/:id", controller.update);
router.delete("/:id", controller.remove);

module.exports = router;
