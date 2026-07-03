const { Router } = require("express");
const { auth } = require("../middlewares/auth");
const { businessScope } = require("../middlewares/businessScope");
const controller = require("../controllers/suscripcion.controller");

const router = Router();

router.use(auth);
router.use(businessScope);

router.get("/actual", controller.getActual);
router.post("/", controller.cambiarPlan);
router.get("/planes", controller.getPlanes);

module.exports = router;
