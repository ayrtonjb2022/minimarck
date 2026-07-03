const { error } = require("../utils/response");

const businessScope = (req, res, next) => {
  try {
    const negocioId = req.user?.negocioId;
    if (!negocioId) {
      return error(res, "Usuario no asociado a un negocio", 403);
    }

    req.businessId = negocioId;
    req.filterCondition = {
      ...(req.filterCondition || {}),
      negocioId,
    };

    next();
  } catch (err) {
    console.error("Error en businessScope:", err);
    return error(res, "Error al verificar ámbito del negocio", 500);
  }
};

module.exports = { businessScope };
