const { Router } = require("express");
const { auth } = require("../middlewares/auth");
const { businessScope } = require("../middlewares/businessScope");
const controller = require("../controllers/compra.controller");

const router = Router();

router.use(auth);
router.use(businessScope);

router.get("/", controller.getAll);
router.get("/:id", controller.getById);
router.post("/", controller.create);
router.put("/:id", controller.update);
router.put("/:id/cancelar", controller.cancel);

module.exports = router;
