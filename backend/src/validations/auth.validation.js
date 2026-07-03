const { body, validationResult } = require("express-validator");

const validateRegister = [
  body("nombre")
    .notEmpty().withMessage("El nombre es requerido")
    .isLength({ min: 2, max: 100 }).withMessage("El nombre debe tener entre 2 y 100 caracteres")
    .trim()
    .escape(),

  body("email")
    .notEmpty().withMessage("El email es requerido")
    .isEmail().withMessage("Email inválido")
    .normalizeEmail()
    .trim(),

  body("password")
    .notEmpty().withMessage("La contraseña es requerida")
    .isLength({ min: 6, max: 100 }).withMessage("La contraseña debe tener al menos 6 caracteres"),

  body("nombreNegocio")
    .notEmpty().withMessage("El nombre del negocio es requerido")
    .isLength({ min: 3, max: 100 }).withMessage("El nombre del negocio debe tener entre 3 y 100 caracteres")
    .trim()
    .escape(),

  body("ruc")
    .optional({ values: "falsy" })
    .isLength({ min: 8, max: 20 }).withMessage("El RUC debe tener entre 8 y 20 caracteres")
    .trim()
    .escape(),

  body("telefono")
    .optional({ values: "falsy" })
    .isLength({ min: 8, max: 20 }).withMessage("El teléfono debe tener entre 8 y 20 caracteres")
    .trim(),

  body("direccion")
    .optional({ values: "falsy" })
    .isLength({ min: 5, max: 255 }).withMessage("La dirección debe tener entre 5 y 255 caracteres")
    .trim()
    .escape(),

  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: "Error de validación",
        errors: errors.array().map((e) => ({
          field: e.path,
          message: e.msg,
        })),
      });
    }
    next();
  },
];

const validateLogin = [
  body("email")
    .notEmpty().withMessage("El email es requerido")
    .isEmail().withMessage("Email inválido")
    .normalizeEmail()
    .trim(),

  body("password")
    .notEmpty().withMessage("La contraseña es requerida"),

  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: "Error de validación",
        errors: errors.array().map((e) => e.msg),
      });
    }
    next();
  },
];

module.exports = { validateRegister, validateLogin };

