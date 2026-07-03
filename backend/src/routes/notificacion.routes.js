const { Router } = require("express");
const { auth } = require("../middlewares/auth");
const { businessScope } = require("../middlewares/businessScope");
const { getNotificaciones } = require("../controllers/notificacion.controller");

const router = Router();
router.use(auth);
router.use(businessScope);

router.get("/", getNotificaciones);

module.exports = router;
