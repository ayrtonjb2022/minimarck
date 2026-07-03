const { Negocio } = require("../models/index");
const { success, error } = require("../utils/response");

const getNegocio = async (req, res) => {
  try {
    const negocioId = req.businessId || req.user?.negocioId;
    if (!negocioId) return error(res, "Usuario no asociado a un negocio", 403);

    const negocio = await Negocio.findByPk(negocioId);
    if (!negocio) return error(res, "Negocio no encontrado", 404);

    return success(res, negocio);
  } catch (err) {
    console.error("Error en getNegocio:", err);
    return error(res, "Error al obtener negocio", 500);
  }
};

const updateNegocio = async (req, res) => {
  try {
    const negocioId = req.businessId || req.user?.negocioId;
    if (!negocioId) return error(res, "Usuario no asociado a un negocio", 403);

    const negocio = await Negocio.findByPk(negocioId);
    if (!negocio) return error(res, "Negocio no encontrado", 404);

    const {
      nombre,
      ruc,
      direccion,
      telefono,
      email,
      website,
      logo,
      tipoComercio,
      configuracion,
    } = req.body;

    const updateData = {};
    if (nombre !== undefined) updateData.nombre = nombre;
    if (ruc !== undefined) updateData.ruc = ruc || null;
    if (direccion !== undefined) updateData.direccion = direccion || null;
    if (telefono !== undefined) updateData.telefono = telefono || null;
    if (email !== undefined) updateData.email = email || null;
    if (website !== undefined) updateData.website = website || null;
    if (logo !== undefined) updateData.logo = logo || null;
    if (tipoComercio !== undefined) updateData.tipoComercio = tipoComercio || "otro";
    if (configuracion !== undefined) {
      updateData.configuracion = {
        ...(negocio.configuracion || {}),
        ...configuracion,
      };
    }

    await negocio.update(updateData);
    return success(res, negocio, "Negocio actualizado exitosamente");
  } catch (err) {
    console.error("Error en updateNegocio:", err);
    return error(res, "Error al actualizar negocio", 500);
  }
};

module.exports = { getNegocio, updateNegocio };
