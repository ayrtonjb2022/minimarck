const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const {
  register,
  login,
  getProfile,
  changePassword,
} = require("../controllers/auth.controller");
const { auth } = require("../middlewares/auth");
const { validate, validatePassword } = require("../middlewares/validation");
const { validateRegister, validateLogin } = require("../validations/auth.validation");

// Saltar rate limiting en desarrollo (evita falsos 429 durante tests/desarrollo)
const skipEnDesarrollo = () => process.env.NODE_ENV === "development";

// Rate limiting específico para registro (5 intentos cada 15 min)
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skip: skipEnDesarrollo,
  message: {
    success: false,
    message: "Demasiados intentos de registro. Por favor, intente más tarde.",
  },
});

// Rate limiting específico para login (10 intentos cada 15 min)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skip: skipEnDesarrollo,
  message: {
    success: false,
    message: "Demasiados intentos de inicio de sesión. Por favor, intente más tarde.",
  },
});

// Rutas públicas
router.post("/register", registerLimiter, validateRegister, register);
router.post("/login", loginLimiter, validateLogin, login);

// Rutas protegidas
router.get("/me", auth, getProfile);
router.put("/change-password", auth, validatePassword("newPassword"), validate, changePassword);

module.exports = router;
