const { Producto, Caja, Negocio } = require("../models/index");
const { success, error } = require("../utils/response");
const { Op } = require("sequelize");
const sequelize = require("../config/database");

const getNotificaciones = async (req, res) => {
  try {
    const negocioId = req.businessId || req.user?.negocioId;
    console.log("[Notificaciones] negocioId:", negocioId);
    const result = [];

    // Productos con stock bajo (stock <= stockMinimo)
    const bajoStock = await Producto.findAll({
      where: {
        negocioId,
        activo: true,
        stock: { [Op.lte]: sequelize.col("stock_minimo") },
      },
      order: [["stock", "ASC"]],
      limit: 5,
      attributes: ["id", "nombre", "stock", "stockMinimo"],
    });

    if (bajoStock.length > 0) {
      result.push({
        tipo: "stock_bajo",
        mensaje: bajoStock.length === 1
          ? `"${bajoStock[0].nombre}" tiene stock bajo (${bajoStock[0].stock} / ${bajoStock[0].stockMinimo})`
          : `${bajoStock.map(p => `"${p.nombre}"`).join(', ')} tienen stock bajo`,
        data: bajoStock.map((p) => ({ id: p.id, nombre: p.nombre, stock: p.stock, stockMinimo: p.stockMinimo })),
      });
    }

    // Alertas de caja (según configuración del negocio)
    const negocio = await Negocio.findByPk(negocioId, { attributes: ["configuracion"] });
    const config = negocio?.configuracion || {};
    console.log("[Notificaciones] config:", JSON.stringify(config));
    const alertaMin = parseFloat(config.alertaCajaMin);
    const alertaMax = parseFloat(config.alertaCajaMax);
    console.log("[Notificaciones] alertaMin:", alertaMin, "alertaMax:", alertaMax);

    if (alertaMin != null || alertaMax != null) {
      const caja = await Caja.findOne({ where: { negocioId, estado: "abierta" } });
      console.log("[Notificaciones] caja abierta:", caja?.id, caja ? "encontrada" : "NO HAY");
      if (caja) {
        const saldoActual = parseFloat(caja.saldoInicial) + parseFloat(caja.totalIngresos) - parseFloat(caja.totalEgresos);
        console.log("[Notificaciones] saldoActual:", saldoActual);
        if (alertaMin != null && saldoActual < alertaMin) {
          result.push({
            tipo: "caja_baja",
            mensaje: `Saldo en caja ($${saldoActual.toFixed(2)}) por debajo del mínimo ($${alertaMin.toFixed(2)})`,
            data: { saldoActual, alertaMin },
          });
        }
        if (alertaMax != null && saldoActual > alertaMax) {
          console.log("[Notificaciones] SUPERO EL MAXIMO!");
          result.push({
            tipo: "caja_alta",
            mensaje: `Saldo en caja ($${saldoActual.toFixed(2)}) superó el máximo ($${alertaMax.toFixed(2)})`,
            data: { saldoActual, alertaMax },
          });
        }
      }
    }

    console.log("[Notificaciones] resultado:", result.length, "notificaciones");
    return success(res, result);
  } catch (err) {
    console.error("Error en getNotificaciones:", err);
    return error(res, "Error al obtener notificaciones", 500);
  }
};

module.exports = { getNotificaciones };
