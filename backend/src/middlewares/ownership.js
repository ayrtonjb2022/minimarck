const { error } = require("../utils/response");

/**
 * Middleware: Solo verifica que el recurso pertenezca al mismo negocio
 */
const checkOwnership = (model, param = "id") => {
  return async (req, res, next) => {
    try {
      const resourceId = req.params[param];
      if (!resourceId) {
        return error(res, "ID del recurso no proporcionado", 400);
      }

      const resource = await model.findByPk(resourceId);
      if (!resource) {
        return error(res, "Recurso no encontrado", 404);
      }

      const resourceNegocioId = resource.negocioId;
      if (resourceNegocioId && req.negocioId && resourceNegocioId !== req.negocioId) {
        return error(res, "Recurso no pertenece a este negocio", 403);
      }

      req.resource = resource;
      next();
    } catch (error) {
      console.error("Error en checkOwnership:", error);
      return error(res, "Error al verificar propiedad", 500);
    }
  };
};

/**
 * Middleware: Filtra resultados por negocio
 */
const filterByUser = () => {
  return async (req, res, next) => {
    try {
      req.filterCondition = {
        ...(req.filterCondition || {}),
        userId: req.userId,
      };
      next();
    } catch (error) {
      console.error("Error en filterByUser:", error);
      return error(res, "Error al aplicar filtro de usuario", 500);
    }
  };
};

module.exports = {
  checkOwnership,
  filterByUser,
};
