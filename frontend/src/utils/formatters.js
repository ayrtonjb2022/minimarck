

const CURRENCY_LOCALE = import.meta.env.VITE_CURRENCY_LOCALE || "es-CL";
const CURRENCY = import.meta.env.VITE_CURRENCY || "CLP";

export const formatCurrency = (amount) => {
  return new Intl.NumberFormat(CURRENCY_LOCALE, {
    style: "currency",
    currency: CURRENCY,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount || 0);
};

const DATE_LOCALE = import.meta.env.VITE_CURRENCY_LOCALE || "es-CL";

/** Detecta si es fecha sola "YYYY-MM-DD" sin componente horario */
const isDateOnly = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);

/**
 * Formatea fecha con hora.
 * Si la fecha viene como "YYYY-MM-DD" (date-only, sin hora), la muestra
 * sin pasar por new Date() para evitar el desvío de medianoche UTC → día anterior en Argentina.
 */
export const formatDate = (date) => {
  if (!date) return "-";

  if (isDateOnly(date)) {
    const [y, m, d] = date.split("-");
    return `${d}/${m}/${y}`;
  }

  return new Date(date).toLocaleDateString(DATE_LOCALE, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

/**
 * Formatea fecha corta (solo día/mes/año).
 * Si la fecha viene como "YYYY-MM-DD" (date-only), la muestra directo sin desvío de timezone.
 */
export const formatDateShort = (date) => {
  if (!date) return "-";

  if (isDateOnly(date)) {
    const [y, m, d] = date.split("-");
    return `${d}/${m}/${y}`;
  }

  return new Date(date).toLocaleDateString(DATE_LOCALE, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
};

export const formatNumber = (num) => {
  return new Intl.NumberFormat(DATE_LOCALE).format(num || 0);
};

export const getStatusColor = (status) => {
  const colors = {
    completada:
      "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
    anulada: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    pendiente:
      "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
    parcial: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    pagado:
      "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
    abierta:
      "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
    cerrada: "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300",
  };
  return (
    colors[status] ||
    "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300"
  );
};

/** Capitaliza la primera letra de cada palabra en un string */
export const capitalizeWords = (str = "") => {
  return str.trim().replace(/\b\w/g, (c) => c.toUpperCase());
};

export const getRolColor = (rol) => {
  const colors = {
    admin:
      "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
    supervisor:
      "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    vendedor:
      "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  };
  return (
    colors[rol] ||
    "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300"
  );
};


