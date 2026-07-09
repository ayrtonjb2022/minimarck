/**
 * Funciones de utilidad para manejo de fechas
 *
 * La columna `fecha` en ventas, compras y pagos_deuda ahora es `date` (no datetime).
 * `new Date()` da hora UTC, entonces para Argentina (UTC-3) las ventas de la tarde/noche
 * quedan con la fecha del día siguiente.
 *
 * Estas funciones devuelven un Date a las 12:00 UTC del día en Argentina,
 * que es seguro para guardar en cualquier columna DATE sin importar la timezone del servidor.
 */

/**
 * Devuelve un objeto Date que representa el mediodía UTC de la fecha actual en Argentina.
 * Esto evita que al guardar en una columna DATE se desvíe por timezone del servidor.
 */
function todayArgentina() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
  });
  const [year, month, day] = formatter.format(now).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

/**
 * Versión para fechas arbitrarias (no solo hoy).
 * Pasa cualquier Date (usualmente del frontend) a un Date seguro para columna DATE.
 * @param {Date|string} date
 */
function toArgentinaDate(date) {
  const d = typeof date === "string" ? new Date(date) : new Date(date);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
  });
  const [year, month, day] = formatter.format(d).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

module.exports = { todayArgentina, toArgentinaDate };
