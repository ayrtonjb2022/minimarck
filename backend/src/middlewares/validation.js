const { validationResult, body } = require("express-validator");

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }
  next();
};

// Validación de contraseña segura
const validatePassword = (field = "password") => {
  return body(field)
    .isLength({ min: 8 })
    .withMessage("La contraseña debe tener al menos 8 caracteres")
    .matches(/[A-Z]/)
    .withMessage("La contraseña debe tener al menos una mayúscula")
    .matches(/[a-z]/)
    .withMessage("La contraseña debe tener al menos una minúscula")
    .matches(/[0-9]/)
    .withMessage("La contraseña debe tener al menos un número")
    .matches(/[!@#$%^&*(),.?":{}|<>]/)
    .withMessage("La contraseña debe tener al menos un símbolo");
};

// Validación de email
const validateEmail = (field = "email") => {
  return body(field).isEmail().withMessage("Email inválido").normalizeEmail();
};

module.exports = {
  validate,
  validatePassword,
  validateEmail,
};
