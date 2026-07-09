const {
  Venta,
  Producto,
  ClienteDeudor,
  VentaDetalle,
} = require("../models/index");
const { success, error } = require("../utils/response");
const { Op, Sequelize } = require("sequelize");
const sequelize = require("../config/database");

/**
 * Obtener estadísticas del dashboard
 * GET /api/dashboard/stats
 */
const getStats = async (req, res) => {
  try {
    const { periodo = "month" } = req.query;
    const filterCondition = req.filterCondition || {};

    let whereVenta = { estado: "completada", ...filterCondition };
    let whereProducto = { ...filterCondition };
    let whereDeudor = { ...filterCondition };

    let fechaInicio = new Date();
    if (periodo === "day") {
      fechaInicio.setHours(0, 0, 0, 0);
    } else if (periodo === "week") {
      fechaInicio.setDate(fechaInicio.getDate() - 7);
    } else if (periodo === "month") {
      fechaInicio.setMonth(fechaInicio.getMonth() - 1);
    } else if (periodo === "year") {
      fechaInicio.setFullYear(fechaInicio.getFullYear() - 1);
    }

    whereVenta.fecha = { [Op.gte]: fechaInicio.toISOString().slice(0, 10) };

    // 1. Estadísticas de ventas
    const totalVentas = (await Venta.count({ where: whereVenta })) || 0;
    const totalIngresos =
      (await Venta.sum("total", { where: whereVenta })) || 0;

    // 2. Productos más vendidos — columnas calificadas con nombre del modelo
    const topProductos = await VentaDetalle.findAll({
      attributes: [
        "productoId",
        [
          Sequelize.fn("SUM", Sequelize.col("VentaDetalle.cantidad")),
          "totalVendido",
        ],
        [
          Sequelize.fn("SUM", Sequelize.col("VentaDetalle.subtotal")),
          "totalIngresos",
        ],
      ],
      include: [
        {
          model: Producto,
          as: "producto",
          attributes: ["id", "nombre", "codigo", "precio", "stock"],
        },
        {
          model: Venta,
          as: "venta",
          attributes: [],
          where: {
            fecha: { [Op.gte]: fechaInicio.toISOString().slice(0, 10) },
            estado: "completada",
            ...filterCondition,
          },
        },
      ],
      group: ["productoId", "producto.id"],
      order: [
        [Sequelize.fn("SUM", Sequelize.col("VentaDetalle.cantidad")), "DESC"],
      ],
      limit: 5,
    });

    // 3. Estadísticas de productos
    const totalProductos =
      (await Producto.count({ where: { ...whereProducto, activo: true } })) ||
      0;
    const sinStock =
      (await Producto.count({
        where: { ...whereProducto, stock: 0, activo: true },
      })) || 0;
    const bajoStock =
      (await Producto.count({
        where: {
          ...whereProducto,
          activo: true,
          stockMinimo: { [Op.gt]: 0 },
          [Op.and]: Sequelize.literal("Producto.stock <= Producto.stock_minimo"),
        },
      })) || 0;

    // 4. Clientes deudores
    const totalDeudores =
      (await ClienteDeudor.count({
        where: { ...whereDeudor, activo: true },
      })) || 0;
    const totalDeuda =
      (await ClienteDeudor.sum("deudaPendiente", {
        where: { ...whereDeudor, activo: true },
      })) || 0;

    // 5. Ventas por método de pago
    const ventasPorMetodo = await Venta.findAll({
      where: whereVenta,
      attributes: [
        "metodoPago",
        [Sequelize.fn("COUNT", Sequelize.col("Venta.id")), "cantidad"],
        [Sequelize.fn("SUM", Sequelize.col("Venta.total")), "total"],
      ],
      group: ["metodoPago"],
    });

    // 6. Ventas diarias (últimos 7 días)
    const sieteDiasAtras = new Date();
    sieteDiasAtras.setDate(sieteDiasAtras.getDate() - 6);
    sieteDiasAtras.setHours(0, 0, 0, 0);

    const diasSemana = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
    const ventasDiarias = await Venta.findAll({
      attributes: [
        [Sequelize.fn("DATE", Sequelize.col("fecha")), "dia"],
        [Sequelize.fn("SUM", Sequelize.col("total")), "total"],
      ],
      where: {
        ...whereVenta,
        fecha: { [Op.gte]: sieteDiasAtras.toISOString().slice(0, 10) },
      },
      group: [Sequelize.fn("DATE", Sequelize.col("fecha"))],
      order: [[Sequelize.fn("DATE", Sequelize.col("fecha")), "ASC"]],
      raw: true,
    });

    const mapaDiario = {};
    ventasDiarias.forEach((v) => {
      if (v.dia) mapaDiario[v.dia] = parseFloat(v.total) || 0;
    });

    const diarias = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const dayIndex = d.getDay();
      diarias.push({
        day: diasSemana[dayIndex],
        value: mapaDiario[key] || 0,
      });
    }

    // 7. Ventas recientes
    const ventasRecientes = await Venta.findAll({
      where: { ...filterCondition },
      order: [["createdAt", "DESC"]],
      limit: 5,
      attributes: ["id", "folio", "total", "estado", "createdAt"],
      include: [
        {
          model: ClienteDeudor,
          as: "deudor",
          attributes: ["nombre"],
        },
      ],
    });

    const recientes = ventasRecientes.map((v) => ({
      folio: v.folio || `V${v.id}`,
      clienteNombre: v.deudor?.nombre || "Mostrador",
      total: parseFloat(v.total) || 0,
      estado: v.estado,
    }));

    return success(res, {
      ventas: {
        total: totalVentas || 0,
        ingresos: parseFloat(totalIngresos) || 0,
        porMetodo: ventasPorMetodo || [],
        diarias,
        recientes,
      },
      productos: {
        total: totalProductos || 0,
        sinStock: sinStock || 0,
        bajoStock: bajoStock || 0,
        topVendidos: topProductos || [],
      },
      deudores: {
        total: totalDeudores || 0,
        deudaTotal: parseFloat(totalDeuda) || 0,
      },
    });
  } catch (err) {
    console.error("Error en getStats:", err);
    return error(res, "Error al obtener estadísticas: " + err.message, 500);
  }
};

module.exports = {
  getStats,
};
