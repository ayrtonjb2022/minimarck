const { Categoria, Producto } = require("../models/index");
const { success, error, paginated } = require("../utils/response");
const { Op } = require("sequelize");

/**
 * Obtener todas las categorías
 * GET /api/categorias
 */
const getAll = async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const where = {
      ...req.filterCondition,
      activo: true,
    };

    if (search) {
      where.nombre = { [Op.like]: `%${search}%` };
    }

    const { count, rows } = await Categoria.findAndCountAll({
      where,
      limit: parseInt(limit),
      offset: offset,
      order: [["nombre", "ASC"]],
    });

    return paginated(res, rows, count, parseInt(page), parseInt(limit));
  } catch (err) {
    console.error("Error en getAll categorías:", err);
    return error(res, "Error al obtener categorías: " + err.message, 500);
  }
};

/**
 * Obtener categoría por ID
 * GET /api/categorias/:id
 */
const getById = async (req, res) => {
  try {
    const categoria = await Categoria.findOne({
      where: { id: req.params.id, ...req.filterCondition },
    });
    if (!categoria) return error(res, "Categoría no encontrada", 404);
    return success(res, categoria, "Categoría obtenida exitosamente");
  } catch (err) {
    console.error("Error en getById categoría:", err);
    return error(res, "Error al obtener categoría: " + err.message, 500);
  }
};

/**
 * Crear categoría
 * POST /api/categorias
 */
const create = async (req, res) => {
  try {
    const { nombre, descripcion } = req.body;

    if (!nombre) {
      return error(res, "El nombre de la categoría es requerido", 400);
    }

    // Verificar si ya existe una categoría con ese nombre para este usuario
    const existing = await Categoria.findOne({
      where: {
        nombre,
        userId: req.userId,
        negocioId: req.businessId || req.user?.negocioId,
        activo: true,
      },
    });

    if (existing) {
      return error(res, "Ya existe una categoría con este nombre", 400);
    }

    const categoria = await Categoria.create({
      nombre,
      descripcion: descripcion || null,
      negocioId: req.businessId || req.user?.negocioId,
      userId: req.userId,
    });

    return success(res, categoria, "Categoría creada exitosamente", 201);
  } catch (err) {
    console.error("Error en create categoría:", err);
    return error(res, "Error al crear categoría: " + err.message, 500);
  }
};

/**
 * Actualizar categoría
 * PUT /api/categorias/:id
 */
const update = async (req, res) => {
  try {
    const categoria = await Categoria.findOne({
      where: { id: req.params.id, ...req.filterCondition },
    });
    if (!categoria) return error(res, "Categoría no encontrada", 404);
    const { nombre, descripcion, activo } = req.body;

    // Verificar si ya existe otra categoría con ese nombre
    if (nombre && nombre !== categoria.nombre) {
      const existing = await Categoria.findOne({
        where: {
          nombre,
          userId: req.userId,
          negocioId: req.businessId || req.user?.negocioId,
          id: { [Op.ne]: categoria.id },
          activo: true,
        },
      });

      if (existing) {
        return error(res, "Ya existe otra categoría con este nombre", 400);
      }
    }

    await categoria.update({
      nombre: nombre || categoria.nombre,
      descripcion:
        descripcion !== undefined ? descripcion : categoria.descripcion,
      activo: activo !== undefined ? activo : categoria.activo,
    });

    return success(res, categoria, "Categoría actualizada exitosamente");
  } catch (err) {
    console.error("Error en update categoría:", err);
    return error(res, "Error al actualizar categoría: " + err.message, 500);
  }
};

/**
 * ✅ CORREGIDO: Eliminar categoría (soft delete)
 * DELETE /api/categorias/:id
 */
const remove = async (req, res) => {
  try {
    const categoria = await Categoria.findOne({
      where: { id: req.params.id, ...req.filterCondition },
    });
    if (!categoria) return error(res, "Categoría no encontrada", 404);

    // Verificar si tiene productos asociados
    const productosCount = await Producto.count({
      where: { categoriaId: categoria.id, activo: true },
    });

    if (productosCount > 0) {
      if (process.env.NODE_ENV === "development") {
        console.log(
          `⚠️ Eliminando categoría con ${productosCount} productos asociados (SOFT DELETE)`,
        );

        await Producto.destroy({
          where: { categoriaId: categoria.id },
          force: false,
        });

        await categoria.destroy();
        return success(res, null, "Categoría eliminada exitosamente");
      }

      return error(
        res,
        "No se puede eliminar la categoría porque tiene productos asociados",
        400,
      );
    }

    await categoria.destroy();
    return success(res, null, "Categoría eliminada exitosamente");
  } catch (err) {
    console.error("Error en remove categoría:", err);
    return error(res, "Error al eliminar categoría: " + err.message, 500);
  }
};

module.exports = {
  getAll,
  getById,
  create,
  update,
  remove,
};











