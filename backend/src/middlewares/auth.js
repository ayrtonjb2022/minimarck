const { verifyToken } = require("../utils/generateToken");
const { User } = require("../models/index");
const { error } = require("../utils/response");

/**
 * Middleware: Verificar autenticación (JWT válido)
 */
const auth = async (req, res, next) => {
  try {
    // Obtener token del header
    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
      return error(res, "No se proporcionó token de autenticación", 401);
    }

    // Verificar token
    const decoded = verifyToken(token);
    if (!decoded) {
      return error(res, "Token inválido o expirado", 401);
    }

    // Buscar usuario
    const user = await User.findByPk(decoded.id, {
      attributes: { exclude: ["password", "deletedAt"] },
    });

    if (!user) {
      return error(res, "Usuario no encontrado", 401);
    }

    if (!user.activo) {
      return error(res, "Usuario desactivado", 401);
    }

    // Adjuntar usuario a la request
    req.user = user;
    req.userId = user.id;
    req.userRole = user.rol;
    req.negocioId = user.negocioId;

    next();
  } catch (err) {
    console.error("Error en middleware auth:", err);
    return error(res, "Error de autenticación", 500);
  }
};

module.exports = {
  auth,
};
