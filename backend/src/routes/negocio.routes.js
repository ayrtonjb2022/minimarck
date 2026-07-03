const { Router } = require("express");
const { auth } = require("../middlewares/auth");
const { businessScope } = require("../middlewares/businessScope");
const { getNegocio, updateNegocio } = require("../controllers/negocio.controller");

const router = Router();

router.use(auth);
router.use(businessScope);

router.get("/", getNegocio);
router.put("/", updateNegocio);

module.exports = router;
