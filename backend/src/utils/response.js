/**
 * Respuesta estándar de éxito
 */
const success = (
  res,
  data,
  message = "Operación exitosa",
  statusCode = 200,
) => {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
  });
};

/**
 * Respuesta estándar de error
 */
const error = (
  res,
  message = "Error en la operación",
  statusCode = 500,
  details = null,
) => {
  const response = {
    success: false,
    message,
  };

  if (details) {
    response.details = details;
  }

  return res.status(statusCode).json(response);
};

/**
 * Respuesta paginada
 */
const paginated = (
  res,
  data,
  total,
  page,
  limit,
  message = "Operación exitosa",
) => {
  const totalPages = Math.ceil(total / limit);

  return res.status(200).json({
    success: true,
    message,
    data,
    pagination: {
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  });
};

module.exports = {
  success,
  error,
  paginated,
};
