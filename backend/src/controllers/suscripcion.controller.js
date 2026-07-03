const { Suscripcion } = require("../models/index");
const { success, error } = require("../utils/response");

const PLANES = [
  {
    id: "basico",
    nombre: "Básico",
    precio: 0,
    maxProductos: 500,
    maxUsuarios: 1,
    features: ["POS básico", "Hasta 500 productos", "Reportes visuales", "Gestión de caja"],
  },
  {
    id: "premium",
    nombre: "Premium",
    precio: 29.99,
    maxProductos: 99999,
    maxUsuarios: 1,
    features: ["POS completo", "Productos ilimitados", "Reportes avanzados", "Gestión de caja", "Soporte prioritario", "Exportación de datos (Excel/PDF)"],
  },
];

const getActual = async (req, res) => {
  try {
    const negocioId = req.businessId || req.user.negocioId;
    if (!negocioId) return error(res, "Usuario no asociado a un negocio", 403);

    const suscripcion = await Suscripcion.findOne({ where: { negocioId } });
    if (!suscripcion) return error(res, "Suscripción no encontrada", 404);
    return success(res, suscripcion);
  } catch (err) {
    console.error("Error en suscripcion.getActual:", err);
    return error(res, "Error al obtener suscripción", 500);
  }
};

const cambiarPlan = async (req, res) => {
  try {
    const { plan } = req.body;
    const negocioId = req.businessId || req.user.negocioId;

    const planValido = PLANES.find((p) => p.id === plan);
    if (!planValido) return error(res, "Plan inválido", 400);

    const suscripcion = await Suscripcion.findOne({ where: { negocioId } });
    if (!suscripcion) return error(res, "Suscripción no encontrada", 404);

    await suscripcion.update({
      plan: planValido.id,
      maxProductos: planValido.maxProductos,
      maxUsuarios: planValido.maxUsuarios,
      features: planValido.features,
    });

    return success(res, suscripcion, "Plan actualizado exitosamente");
  } catch (err) {
    console.error("Error en suscripcion.cambiarPlan:", err);
    return error(res, "Error al cambiar plan", 500);
  }
};

const getPlanes = async (req, res) => {
  return success(res, PLANES, "Planes obtenidos exitosamente");
};

module.exports = { getActual, cambiarPlan, getPlanes };
