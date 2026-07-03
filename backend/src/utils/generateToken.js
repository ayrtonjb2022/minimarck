const jwt = require("jsonwebtoken");

/**
 * Genera un token JWT para el usuario
 */
const generateToken = (user) => {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret === "cambia_esto_por_un_secreto_muy_largo_y_aleatorio" || secret.length < 20) {
    throw new Error(
      "JWT_SECRET no configurado correctamente. Generá un secreto real con: openssl rand -hex 64"
    );
  }

  const payload = {
    id: user.id,
    email: user.email,
    rol: user.rol,
    negocioId: user.negocioId,
  };

  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
};

/**
 * Verifica un token JWT
 */
const verifyToken = (token) => {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return null;
  }
};

module.exports = {
  generateToken,
  verifyToken,
};
