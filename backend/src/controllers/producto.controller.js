const { Producto, Categoria, VentaDetalle, Suscripcion } = require("../models/index");
const { success, error, paginated } = require("../utils/response");
const { Op } = require("sequelize");
const sequelize = require("../config/database");

/**
 * Obtener todos los productos
 * GET /api/productos
 */
const getAll = async (req, res) => {
  try {
    const { page = 1, limit = 20, search, categoriaId, minStock } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const where = {
      ...req.filterCondition,
      activo: true,
    };

    if (search) {
      where[Op.or] = [
        { nombre: { [Op.like]: `%${search}%` } },
        { codigo: { [Op.like]: `%${search}%` } },
      ];
    }

    if (categoriaId) {
      where.categoriaId = parseInt(categoriaId);
    }

    if (minStock === "true") {
      where.stock = { [Op.lte]: sequelize.col("stockMinimo") };
    }

    const { count, rows } = await Producto.findAndCountAll({
      where,
      include: [
        {
          model: Categoria,
          as: "categoria",
          attributes: ["id", "nombre"],
        },
      ],
      limit: parseInt(limit),
      offset: offset,
      order: [["nombre", "ASC"]],
    });

    return paginated(res, rows, count, parseInt(page), parseInt(limit));
  } catch (err) {
    console.error("Error en getAll productos:", err);
    return error(res, "Error al obtener productos: " + err.message, 500);
  }
};

/**
 * Obtener producto por ID
 * GET /api/productos/:id
 */
const getById = async (req, res) => {
  try {
    const producto = await Producto.findOne({
      where: { id: req.params.id, ...req.filterCondition },
      include: [{ model: Categoria, as: "categoria", attributes: ["id", "nombre"] }],
    });
    if (!producto) return error(res, "Producto no encontrado", 404);
    return success(res, producto, "Producto obtenido exitosamente");
  } catch (err) {
    console.error("Error en getById producto:", err);
    return error(res, "Error al obtener producto: " + err.message, 500);
  }
};

/**
 * Crear producto
 * POST /api/productos
 */
const create = async (req, res) => {
  try {
    const {
      nombre,
      descripcion,
      codigo,
      precio,
      precioCompra,
      stock,
      stockMinimo,
      categoriaId,
      imagen,
      tieneIva,
      ivaPorcentaje,
      margen,
      unidadMedida,
    } = req.body;

    if (!nombre) {
      return error(res, "El nombre es requerido", 400);
    }

    if (!precio || parseFloat(precio) <= 0) {
      return error(res, "El precio debe ser mayor a 0", 400);
    }
    const precioFinal = parseFloat(precio);
    const precioCompraVal = precioCompra ? parseFloat(precioCompra) : 0;

    // Verificar límite de productos según plan
    const negocioId = req.businessId || req.user?.negocioId;
    const suscripcion = await Suscripcion.findOne({ where: { negocioId } });
    const maxProductos = suscripcion?.maxProductos || 500;
    const productoCount = await Producto.count({ where: { negocioId, activo: true } });
    if (productoCount >= maxProductos) {
      return error(res, `Has alcanzado el límite de ${maxProductos} productos de tu plan ${suscripcion?.plan || "básico"}. Actualizá a Premium para agregar más productos.`, 403);
    }

    // Verificar código único
    if (codigo) {
      const existing = await Producto.findOne({
        where: {
          codigo: codigo,
          negocioId: req.businessId || req.user?.negocioId,
          activo: true,
        },
      });
      if (existing) {
        return error(res, "Ya existe un producto con este código", 400);
      }
    }

    // Verificar nombre duplicado
    const existingName = await Producto.findOne({
      where: {
        nombre: nombre,
        userId: req.userId,
        negocioId: req.businessId || req.user?.negocioId,
        activo: true,
      },
    });
    if (existingName) {
      return error(res, "Ya existe un producto con este nombre", 400);
    }

    const producto = await Producto.create({
      nombre,
      descripcion: descripcion || null,
      codigo: codigo || null,
      precio: precioFinal,
      precioCompra: precioCompraVal,
      stock: stock ? parseInt(stock) : 0,
      stockMinimo: stockMinimo ? parseInt(stockMinimo) : 5,
      categoriaId: categoriaId ? parseInt(categoriaId) : null,
      imagen: imagen || null,
      tieneIva: tieneIva || false,
      ivaPorcentaje: tieneIva ? parseFloat(ivaPorcentaje ?? 0) : null,
      margen: margen ? parseFloat(margen) : null,
      unidadMedida: unidadMedida || "unidad",
      negocioId: req.businessId || req.user?.negocioId,
      userId: req.userId,
    });

    return success(res, producto, "Producto creado exitosamente", 201);
  } catch (err) {
    console.error("Error en create producto:", err);
    return error(res, "Error al crear producto: " + err.message, 500);
  }
};

/**
 * Actualizar producto
 * PUT /api/productos/:id
 */
const update = async (req, res) => {
  try {
    const producto = await Producto.findOne({
      where: { id: req.params.id, ...req.filterCondition },
    });
    if (!producto) return error(res, "Producto no encontrado", 404);
    const {
      nombre,
      descripcion,
      codigo,
      precio,
      precioCompra,
      stock,
      stockMinimo,
      categoriaId,
      activo,
      imagen,
      tieneIva,
      ivaPorcentaje,
      margen,
      unidadMedida,
    } = req.body;

    // Verificar código único (si cambió)
    if (codigo && codigo !== producto.codigo) {
      const existing = await Producto.findOne({
        where: {
          codigo,
          negocioId: req.businessId || req.user?.negocioId,
          id: { [Op.ne]: producto.id },
          activo: true,
        },
      });
      if (existing) {
        return error(res, "Ya existe un producto con este código", 400);
      }
    }

    // Verificar nombre duplicado (si cambió)
    if (nombre && nombre !== producto.nombre) {
      const existingName = await Producto.findOne({
        where: {
          nombre,
          userId: req.userId,
          negocioId: req.businessId || req.user?.negocioId,
          id: { [Op.ne]: producto.id },
          activo: true,
        },
      });
      if (existingName) {
        return error(res, "Ya existe un producto con este nombre", 400);
      }
    }

    await producto.update({
      nombre: nombre || producto.nombre,
      descripcion:
        descripcion !== undefined ? descripcion : producto.descripcion,
      codigo: codigo !== undefined ? (codigo || null) : producto.codigo,
      precio: precio !== undefined ? parseFloat(precio) : producto.precio,
      precioCompra: precioCompra !== undefined ? parseFloat(precioCompra) : producto.precioCompra,
      stock: stock !== undefined ? parseInt(stock) : producto.stock,
      stockMinimo:
        stockMinimo !== undefined
          ? parseInt(stockMinimo)
          : producto.stockMinimo,
      categoriaId:
        categoriaId !== undefined
          ? categoriaId
            ? parseInt(categoriaId)
            : null
          : producto.categoriaId,
      activo: activo !== undefined ? activo : producto.activo,
      imagen: imagen !== undefined ? imagen : producto.imagen,
      tieneIva: tieneIva !== undefined ? tieneIva : producto.tieneIva,
      ivaPorcentaje: tieneIva ? parseFloat(ivaPorcentaje ?? 0) : producto.tieneIva ? producto.ivaPorcentaje : null,
      margen: margen !== undefined ? parseFloat(margen) : producto.margen,
      unidadMedida: unidadMedida !== undefined && unidadMedida !== "" ? unidadMedida : producto.unidadMedida,
    });

    return success(res, producto, "Producto actualizado exitosamente");
  } catch (err) {
    console.error("Error en update producto:", err);
    return error(res, "Error al actualizar producto: " + err.message, 500);
  }
};

/**
 * Buscar producto por código de barras
 * GET /api/productos/codigo/:codigo
 */
const getByCode = async (req, res) => {
  try {
    const producto = await Producto.findOne({
      where: {
        codigo: req.params.codigo,
        ...req.filterCondition,
        activo: true,
      },
      include: [{ model: Categoria, as: "categoria", attributes: ["id", "nombre"] }],
    });
    if (!producto) return error(res, "Producto no encontrado", 404);
    return success(res, producto, "Producto encontrado");
  } catch (err) {
    console.error("Error en getByCode producto:", err);
    return error(res, "Error al buscar producto: " + err.message, 500);
  }
};

/**
 * Eliminar producto (soft delete)
 * DELETE /api/productos/:id
 */
const remove = async (req, res) => {
  try {
    const producto = await Producto.findOne({
      where: { id: req.params.id, ...req.filterCondition },
    });
    if (!producto) return error(res, "Producto no encontrado", 404);

    // Verificar si tiene ventas asociadas
    const ventasCount = await VentaDetalle.count({
      where: { productoId: producto.id },
    });

    if (ventasCount > 0) {
      if (process.env.NODE_ENV === "development") {
        console.log(
          `⚠️ Eliminando producto con ${ventasCount} ventas asociadas (SOFT DELETE)`,
        );
        await producto.destroy();
        return success(res, null, "Producto eliminado exitosamente");
      }

      return error(
        res,
        "No se puede eliminar el producto porque tiene ventas asociadas",
        400,
      );
    }

    await producto.destroy();
    return success(res, null, "Producto eliminado exitosamente");
  } catch (err) {
    console.error("Error en remove producto:", err);
    return error(res, "Error al eliminar producto: " + err.message, 500);
  }
};

module.exports = {
  getAll,
  getById,
  getByCode,
  create,
  update,
  remove,
};




