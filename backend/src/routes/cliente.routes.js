const router = require("express").Router();
const { auth } = require("../middlewares/auth");
const { businessScope } = require("../middlewares/businessScope");
const {
  getAll,
  getById,
  create,
  update,
  remove,
} = require("../controllers/deudor.controller");

router.use(auth);
router.use(businessScope);

router.get("/", getAll);
router.get("/:id", getById);
router.post("/", create);
router.put("/:id", update);
router.delete("/:id", remove);

module.exports = router;
