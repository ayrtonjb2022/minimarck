const express = require("express");
const router = express.Router();
const { auth } = require("../middlewares/auth");
const { businessScope } = require("../middlewares/businessScope");
const { getUsers } = require("../controllers/user.controller");

router.get("/", auth, businessScope, getUsers);

module.exports = router;
