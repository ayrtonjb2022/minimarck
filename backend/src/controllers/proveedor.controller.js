const { Proveedor } = require("../models/index");
const { success, error, paginated } = require("../utils/response");

const getAll = async (req, res) => {
  try {
    const { page = 1, limit = 20, search, activo } = req.query;
    const offset = (page - 1) * limit;
    const where = { ...req.filterCondition };

    if (search) {
      where.nombre = { [require("sequelize").Op.like]: `%${search}%` };
    }
    if (activo !== undefined) {
      where.activo = activo === "true";
    }

    const { rows, count } = await Proveedor.findAndCountAll({
      where,
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [["nombre", "ASC"]],
    });

    return paginated(res, rows, count, parseInt(page), parseInt(limit));
  } catch (err) {
    console.error("Error en proveedor.getAll:", err);
    return error(res, "Error al obtener proveedores", 500);
  }
};

const getById = async (req, res) => {
  try {
    const proveedor = await Proveedor.findOne({
      where: { id: req.params.id, ...req.filterCondition },
    });
    if (!proveedor) return error(res, "Proveedor no encontrado", 404);
    return success(res, proveedor);
  } catch (err) {
    console.error("Error en proveedor.getById:", err);
    return error(res, "Error al obtener proveedor", 500);
  }
};

const create = async (req, res) => {
  try {
    const data = { ...req.body, negocioId: req.businessId || req.user.negocioId };
    const proveedor = await Proveedor.create(data);
    return success(res, proveedor, "Proveedor creado exitosamente", 201);
  } catch (err) {
    if (err.name === "SequelizeValidationError") {
      return error(res, err.errors.map((e) => e.message).join(", "), 400);
    }
    console.error("Error en proveedor.create:", err);
    return error(res, "Error al crear proveedor", 500);
  }
};

const update = async (req, res) => {
  try {
    const proveedor = await Proveedor.findOne({
      where: { id: req.params.id, ...req.filterCondition },
    });
    if (!proveedor) return error(res, "Proveedor no encontrado", 404);
    await proveedor.update(req.body);
    return success(res, proveedor, "Proveedor actualizado exitosamente");
  } catch (err) {
    if (err.name === "SequelizeValidationError") {
      return error(res, err.errors.map((e) => e.message).join(", "), 400);
    }
    console.error("Error en proveedor.update:", err);
    return error(res, "Error al actualizar proveedor", 500);
  }
};

const remove = async (req, res) => {
  try {
    const proveedor = await Proveedor.findOne({
      where: { id: req.params.id, ...req.filterCondition },
    });
    if (!proveedor) return error(res, "Proveedor no encontrado", 404);
    await proveedor.destroy();
    return success(res, null, "Proveedor eliminado exitosamente");
  } catch (err) {
    console.error("Error en proveedor.remove:", err);
    return error(res, "Error al eliminar proveedor", 500);
  }
};

module.exports = { getAll, getById, create, update, remove };
