/**
 * Formatting for the vendored desktop UI.
 *
 * THE ONE RULE IN THIS FILE: MONEY IS CENTAVOS IN, ALWAYS.
 *
 * The web formatted `formatCurrency(pesos)` with `Intl.NumberFormat('es-CL', {currency: 'CLP',
 * maximumFractionDigits: 0})` — Chilean pesos, no decimals, because a Chilean peso has none
 * worth showing. This is an Argentine till, so the locale and the currency change, and so does
 * the ARGUMENT: `formatCents(105050)` is $1.050,50, while `formatCents(1050)` is $10,50. A
 * function that silently multiplied its input by a hundred is how a till ends up charging $10 on a
 * $1.000 sale, so the name changed with the contract: every call site passes centavos and says so.
 *
 * `formatCents` is imported from `src/shared/money.js` rather than reimplemented, because that
 * module is in `shared/` precisely so main and the renderer cannot disagree about a total. The
 * web's own rounding was `toFixed(2)` on a float, which is exactly the arithmetic the module
 * exists to prevent.
 */

import { formatCents, formatRate } from "../../../shared/money";
import { formatMilli } from "../../../shared/qty";

/**
 * An amount of pesos, in integer centavos. `$1.050,50`.
 *
 * Argentine grouping, comma for the decimals: `formatCents` builds the dotted thousands and the
 * two-digit tail in integer space, so no float ever gets formatted.
 */
export const formatCentavos = (centavos, opts) => formatCents(centavos, opts);

/** Alias kept because "currency" is what the call sites already import. Same centavos contract. */
export const formatCurrency = formatCentavos;

/** A rate for display. `21` is `21%`, not $21. */
export const formatPorcentaje = (tasa) => formatRate(tasa);

/**
 * A quantity, in thousandths of a unit. `formatMilli(500, {unidad: 'kg'})` is `500 g`.
 *
 * Used for the weigh column: a ticket line for half a kilo of cheese is `500`, and printing
 * "0,5" against a kilogram price is a unit the operator has to do arithmetic about at 6pm.
 */
export const formatCantidad = (milli, opts) => formatMilli(milli, opts);

const DATE_LOCALE = "es-AR";

/** Date-only "YYYY-MM-DD", with no time component. */
const isDateOnly = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);

/**
 * A date, in Argentine day/month order.
 *
 * The date-only shortcut is kept from the web, and it is not cosmetic. `new Date('2026-01-31')` is
 * parsed as UTC midnight, which in Argentina (UTC-3) is 21:00 on the 30th — so a plain
 * `toLocaleDateString` prints the day BEFORE for every date the shop did not have a clock time
 * for. Splitting the string and showing it as written cannot go wrong.
 */
export const formatDate = (date) => {
  if (!date) return "-";

  if (isDateOnly(date)) {
    const [y, m, d] = date.split("-");
    return `${d}/${m}/${y}`;
  }

  return new Date(date).toLocaleString(DATE_LOCALE, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

/** Day/month/year only, same date-only shortcut. */
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

/** A plain number, Argentine grouping. `1234567` is `1.234.567`. */
export const formatNumber = (num) => new Intl.NumberFormat(DATE_LOCALE).format(num || 0);

/** Uppercases the first letter of each word. */
export const capitalizeWords = (str = "") => str.trim().replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Badge classes per status. Both palettes are inline Tailwind classes, so Tailwind has to see
 * these files at build time — which is why the CSS is pointed at this directory rather than at
 * the whole frontend.
 */
export const getStatusColor = (status) => {
  const colors = {
    completada:
      "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
    cancelada: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    anulada: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    pendiente:
      "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
    parcial: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    pagado: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
    abierta: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
    cerrada: "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300",
  };
  return (
    colors[status] ||
    "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300"
  );
};

export const getRolColor = (rol) => {
  const colors = {
    admin: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
    supervisor: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    vendedor: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  };
  return (
    colors[rol] ||
    "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300"
  );
};
