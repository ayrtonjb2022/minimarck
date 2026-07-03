const { User } = require("../models");
const { paginated, error } = require("../utils/response");

// ── GET /users ───────────────────────────────────────────
const getUsers = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;

    const { count, rows } = await User.findAndCountAll({
      where: { ...req.filterCondition },
      attributes: { exclude: ["password"] },
      order: [["createdAt", "DESC"]],
      limit,
      offset,
    });

    return paginated(res, rows, count, page, limit, "Usuarios obtenidos correctamente.");
  } catch (err) {
    console.error("[user.controller] getUsers:", err);
    return error(res, "Error al obtener usuarios.");
  }
};

module.exports = { getUsers };
