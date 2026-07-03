const { User, Negocio, Suscripcion } = require("../models/index");
const { generateToken } = require("../utils/generateToken");
const { success, error } = require("../utils/response");

/**
 * Registro público de usuario (dueño de negocio)
 * POST /api/auth/register
 */
const register = async (req, res) => {
  try {
    const { nombre, email, password, telefono, direccion, nombreNegocio, ruc, tipoComercio } = req.body;

    const existingUser = await User.findOne({ where: { email } });
    if (existingUser) {
      return error(res, "El email ya está registrado", 409);
    }

    const transaction = await User.sequelize.transaction();

    try {
      const negocio = await Negocio.create({
        nombre: nombreNegocio.trim(),
        ruc: ruc || null,
        direccion: direccion || null,
        telefono: telefono || null,
        tipoComercio: tipoComercio || "otro",
        activo: true,
      }, { transaction });

      const user = await User.create({
        nombre: nombre.trim(),
        email,
        password,
        rol: "admin",
        activo: true,
        telefono: telefono || null,
        direccion: direccion || null,
        negocioId: negocio.id,
      }, { transaction });

      await Suscripcion.create({
        plan: "basico",
        maxUsuarios: 2,
        maxProductos: 500,
        activa: true,
        negocioId: negocio.id,
      }, { transaction });

      await transaction.commit();

      const token = generateToken(user);

      return success(
        res,
        {
          token,
          user: user.toJSON(),
          negocio: {
            id: negocio.id,
            nombre: negocio.nombre,
            ruc: negocio.ruc,
            tipoComercio: negocio.tipoComercio,
          },
        },
        "Negocio registrado exitosamente",
        201,
      );
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (err) {
    console.error("Error en register:", err);
    if (err.name === "SequelizeValidationError") {
      return error(res, err.errors.map((e) => e.message).join(", "), 400);
    }
    return error(res, "Error al registrar negocio", 500);
  }
};

/**
 * Login de usuario
 * POST /api/auth/login
 */
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({
      where: { email },
      include: [{
        model: Negocio,
        as: "negocio",
        attributes: ["id", "nombre", "ruc"],
      }],
    });

    if (!user) {
      return error(res, "Credenciales inválidas", 401);
    }

    if (!user.activo) {
      return error(res, "Usuario desactivado, contacte al administrador", 401);
    }

    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return error(res, "Credenciales inválidas", 401);
    }

    await user.update({ ultimoAcceso: new Date() });

    const token = generateToken(user);
    const userData = user.toJSON();

    return success(
      res,
      {
        token,
        user: userData,
      },
      "Login exitoso",
    );
  } catch (err) {
    console.error("Error en login:", err);
    return error(res, "Error al iniciar sesión", 500);
  }
};

/**
 * Obtener perfil del usuario autenticado
 * GET /api/auth/me
 */
const getProfile = async (req, res) => {
  try {
    const user = await User.findByPk(req.userId, {
      attributes: { exclude: ["password", "deletedAt"] },
      include: [{
        model: Negocio,
        as: "negocio",
        attributes: ["id", "nombre", "ruc", "direccion", "telefono", "tipoComercio", "email", "website", "logo"],
      }],
    });

    if (!user) {
      return error(res, "Usuario no encontrado", 404);
    }

    return success(res, user, "Perfil obtenido exitosamente");
  } catch (err) {
    console.error("Error en getProfile:", err);
    return error(res, "Error al obtener perfil", 500);
  }
};

/**
 * Cambiar contraseña
 * PUT /api/auth/change-password
 */
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const user = await User.findByPk(req.userId);

    if (!user) {
      return error(res, "Usuario no encontrado", 404);
    }

    const isPasswordValid = await user.comparePassword(currentPassword);
    if (!isPasswordValid) {
      return error(res, "Contraseña actual incorrecta", 400);
    }

    user.password = newPassword;
    await user.save();

    return success(res, null, "Contraseña actualizada exitosamente");
  } catch (err) {
    console.error("Error en changePassword:", err);
    return error(res, "Error al cambiar contraseña", 500);
  }
};

module.exports = {
  register,
  login,
  getProfile,
  changePassword,
};
