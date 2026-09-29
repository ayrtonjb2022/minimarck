/**
 * Quantities, as integer thousandths. The counterpart to `money.js` for the other half of a
 * sale: money is centavos, quantity is milli.
 *
 * WHY THOUSANDTHS: the desktop schema stores `productos.stock_milli` and
 * `ventas_detalles.cantidad_milli`. A shop sells 500 grams of cheese, not "0.5 of a unit", and
 * a scale reads grams. Storing quantity in the product's own unit would mean 500 for a gram
 * product and 0.5 for a kilo product, so the same number would mean two different things
 * depending on which row it came from and arithmetic on it would be wrong by a factor of a
 * thousand. A single fixed scale makes every comparison a plain integer comparison.
 *
 * THE WEB CANNOT DO THIS AT ALL. `ventas_detalles.cantidad` is `INTEGER` in the Sequelize model
 * and the POS sends a whole number, so a half-kilo line is stored as `1` unit at a prorated
 * price. That is the bug this module exists to not reproduce. See `DIVERGENCES.md`.
 *
 * PARSING IS STRING-BASED, for the same reason `money.js` parses digit-wise:
 * `parseFloat('0.29') * 1000` is `289.99999999999994`, and 290 grams of rice is not 289.9999
 * grams. The regex reads the digits directly, so what the operator typed is what is stored.
 *
 * AT MOST THREE DECIMALS. 1/1000 of a unit is the resolution the scale offers; a fourth decimal
 * is either a typo or a unit mistake, and silently rounding it is how a half kilo becomes a
 * third of a kilo with no record that anything was lost.
 */

export class QtyError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'QtyError'
    this.code = code
    this.status = status
  }
}

/** 1 unit === 1000 milli. The ONLY place this scale is written down. */
export const QTY_SCALE = 1000

/**
 * `10 ** 12` milli is `10 ** 9` units, and the line total at the largest money column this app
 * allows (`MAX_CENTS`) keeps a line under `MAX_CENTS * QTY_SCALE`, so the multiplication in
 * `lineTotalCentavos` cannot leave the safe-integer range. Anything larger did not come from a
 * scale; it is a bug or an injection.
 */
export const MAX_MILLI = 10 ** 12

/**
 * At most one decimal separator of at most THREE digits, and no other separator.
 *
 * `1.000` IS ACCEPTED, and it means one thousand milli — one unit. This is the one place where
 * quantity cannot do what `money.js` does, and the reason is structural: money limits itself to
 * TWO decimals, so a third digit is unambiguously a thousands separator and it can be refused.
 * Quantity needs THREE, because one gram of a kilo product is 0.001 kg and a shop that cannot sell
 * a gram cannot weigh produce. With three digits allowed, `1.000` is genuinely ambiguous between
 * "one thousand" and "one", and there is no way to tell them apart.
 *
 * So the ambiguity is resolved by a STATED RULE instead of a guess: the separator is always a
 * DECIMAL point, never a thousands separator. The other half of the fix is on the display side —
 * `formatMilli` groups with a space, so a grouped quantity cannot be typed back into this regex
 * as a different number. Between the two, a mistyped quantity is either exact or refused, and
 * never silently a thousand times off.
 */
const MILLI_INPUT = /^(\d*)(?:([.,])(\d{1,3}))?$/

/** True only for a plain safe integer. Booleans and numeric strings are rejected on purpose. */
export function isMilli(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= MAX_MILLI
}

/**
 * Convert operator input to an integer number of milli. Accepts a decimal string (`'0,5'`,
 * `'0.500'`, `'2'`) or a JS number, and returns a safe integer.
 *
 * A number is routed through `String()` and parsed digit-wise, so `0.29` becomes `290` and not
 * `289.99999999999994`.
 */
export function toMilli(input, label = 'cantidad') {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new QtyError('QTY_NOT_FINITE', `${label} no es un número finito: ${input}`)
    }
    // `String(1e21)` is "1e+21". Exponential notation has no place digits, so it cannot be
    // parsed here and is refused rather than silently mangled.
    if (/[eE]/.test(String(input))) {
      throw new QtyError('QTY_EXPONENTIAL', `${label} excede el rango representable: ${input}`)
    }
    return toMilli(String(input), label)
  }

  if (typeof input !== 'string') {
    throw new QtyError('QTY_TYPE', `${label} debe ser texto o número, recibido: ${typeof input}`)
  }

  const text = input.trim()
  if (text === '') {
    throw new QtyError('QTY_EMPTY', `${label} está vacío`)
  }

  const match = MILLI_INPUT.exec(text)
  if (!match) {
    throw new QtyError(
      'QTY_FORMAT',
      `${label} no es una cantidad válida: "${text}". Use hasta 3 decimales y sin separador de miles ` +
        `(ej. 0.5, 0,500 o 2).`
    )
  }

  const [, intPart, , decPart] = match
  if (intPart === '' && decPart === undefined) {
    throw new QtyError('QTY_FORMAT', `${label} no es una cantidad válida: "${text}"`)
  }

  const whole = Number(intPart === '' ? '0' : intPart)
  const fraction = Number((decPart ?? '').padEnd(3, '0'))
  const milli = whole * QTY_SCALE + fraction

  if (!Number.isSafeInteger(milli) || milli > MAX_MILLI) {
    throw new QtyError('QTY_RANGE', `${label} fuera de rango: "${text}"`)
  }
  // Through `assertMilli` so `toMilli('0.000')` yields `0`, not `-0`.
  return assertMilli(milli, label)
}

/**
 * Assert a value is already milli, and NORMALISE it on the way out.
 *
 * `0` is deliberately allowed here and refused at the call site instead: the schema says
 * `cantidad_milli >= 1`, so a zero-quantity line is a caller error with its own message
 * ("cantidad inválida", the web's wording), not a storage error. Keeping the check here means
 * `assertMilli` stays a pure type assertion and can be used on a balance that is legitimately 0.
 */
export function assertMilli(value, label = 'cantidad') {
  if (!isMilli(value)) {
    throw new QtyError(
      'QTY_NOT_MILLI',
      `${label} debe ser un entero de milésimas, recibido: ${JSON.stringify(value)}. ` +
        'Usá toMilli() en el borde.'
    )
  }
  return value === 0 ? 0 : value
}

/**
 * Round half away from zero. Same rule and same reason as `money.js`: `Math.round(-0.5)` is
 * `-0`, so a credit and a debit of equal magnitude would round in opposite directions, and in a
 * ledger that asymmetry is a real defect. Duplicated rather than imported because `money.js`
 * deliberately keeps its own rounding PRIVATE — the two modules must not grow a dependency on
 * each other's internals, and the rule is three lines.
 */
function roundHalfAway(value) {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

/**
 * The price of one LINE, in centavos, from a per-unit price and a quantity in milli.
 *
 * `precioUnitarioCentavos * cantidadMilli / QTY_SCALE`, rounded half away from zero.
 *
 * The rounding is unavoidable and its magnitude is bounded by construction: a per-unit price of
 * P cents and a quantity of M/1000 units give P*M/1000 cents, which is an integer only when P
 * * 1000 divides evenly. A $3.33 product sold by weight at 290 g is 96.57 cents of real money and
 * 97 cents of recorded money — a rounding of a rounding, which is why it is named, here, rather
 * than left to whichever arithmetic the caller happened to write.
 *
 * NOTE THE ASYMMETRY IS AVOIDED BY ROUNDING HERE AND NEVER PER UNIT: a cancellation does not
 * recompute the line from the unit price, it returns the recorded line total. So a rounded line
 * is reversed by the same integer, and the pair nets to exactly zero.
 */
export function lineTotalCentavos(precioUnitarioCentavos, cantidadMilli, { label = 'línea' } = {}) {
  const precio = assertCentsLike(precioUnitarioCentavos, `${label}: precio unitario`)
  const milli = assertMilli(cantidadMilli, `${label}: cantidad`)
  if (milli < 1) {
    throw new QtyError('QTY_LINE_ZERO', `${label}: la cantidad debe ser mayor a cero`)
  }
  const exact = (precio * milli) / QTY_SCALE
  const total = roundHalfAway(exact)
  if (!Number.isSafeInteger(total)) {
    throw new QtyError('QTY_LINE_RANGE', `${label}: el total de la línea excede el rango seguro`)
  }
  return total === 0 ? 0 : total
}

/**
 * `money.js` owns the assertion that a value is cents, and it throws `MoneyError` on a float.
 * This module must not import it — `money.js` is loaded by the renderer for formatting, and a
 * quantity calculation has no business pulling formatting into main. So the check is stated
 * once, here, in the one line it needs: a price that is not a safe integer never reached the
 * money module and is a bug at the boundary above.
 */
function assertCentsLike(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new QtyError(
      'QTY_PRICE_NOT_CENTS',
      `${label} debe ser un entero de centavos, recibido: ${JSON.stringify(value)}`
    )
  }
  return value === 0 ? 0 : value
}

/**
 * How many milli ONE of this unit is worth: 1000 for a weight measured in kg, 1 for anything
 * already at its own resolution.
 *
 * This is the web's `escalaUnidad` (kilo/litre -> 1000, else 1), narrowed to the units the
 * desktop schema actually allows and spelled out instead of regex-matched, because a regex over
 * a free-text column is a silent 1 for a unit it has never heard of. `unidad_medida` is CHECK
 * constrained to twelve values, so an exhaustive map is not aspirational — it is total.
 */
const UNIDAD_ESCALA = Object.freeze({
  kg: 1000,
  l: 1000,
  g: 1,
  ml: 1,
  unidad: 1,
  m: 1,
  cm: 1,
  par: 1,
  caja: 1,
  pack: 1,
  docena: 1
})

export function escalaUnidad(unidad) {
  if (typeof unidad !== 'string') return 1
  const scale = UNIDAD_ESCALA[unidad.trim().toLowerCase()]
  if (scale === undefined) {
    throw new QtyError(
      'QTY_UNIDAD_DESCONOCIDA',
      `unidad de medida desconocida: "${unidad}". El esquema permite: ${Object.keys(UNIDAD_ESCALA).join(', ')}`
    )
  }
  return scale
}

/** The sub-unit used when a quantity is BELOW one whole of its own unit: `g` for `kg`, `ml` for `l`. */
const UNIDAD_SUB = Object.freeze({ kg: 'g', l: 'ml' })

/**
 * Render a quantity for a receipt or a line item: `500 g`, `1 kg`, `2 unidades`.
 *
 * THE GROUPING SEPARATOR IS A SPACE, and that is not a style choice. `formatCents` groups with
 * `.` because money's two separators are DIFFERENT characters — `.` groups, `,` decimals — so
 * `$1.050,50` cannot be misread as one thousand and fifty. A quantity has only ONE separator
 * character and it is the decimal point, so grouping with `.` would render 12.500 g as a string
 * that parses back as ONE AND A HALF grams. A space is not a character `toMilli` accepts, so
 * re-typing a grouped quantity produces a clear `QTY_FORMAT` error instead of a silent factor of
 * a thousand.
 */
export function formatMilli(milli, { unidad = 'unidad', grouping = true } = {}) {
  const value = assertMilli(milli, 'formatMilli')
  const scale = escalaUnidad(unidad)
  const negativo = value < 0
  const abs = Math.abs(value)
  const digitos = (n) => (grouping ? String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : String(n))

  // A whole number of the base unit reads better in the base unit (1 kg, not 1000 g).
  if (scale > 1 && abs >= scale && abs % scale === 0) {
    return `${negativo ? '-' : ''}${digitos(abs / scale)} ${unidad}`
  }

  const sub = scale > 1 ? (UNIDAD_SUB[unidad.trim().toLowerCase()] ?? unidad) : unidad
  return `${negativo ? '-' : ''}${digitos(abs)} ${sub}`
}
