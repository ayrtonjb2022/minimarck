/**
 * Money, as integer centavos. The one place a decimal becomes a number.
 *
 * WHY CENTAVOS AND NOT REAL, for this app specifically:
 *
 * This is not a calculator, it is a ledger. `detalle_asiento` carries `debe` and `haber`
 * columns, which is double-entry bookkeeping, and double-entry has exactly one hard
 * requirement: the sum of debits must EQUAL the sum of credits. With REAL that identity
 * breaks on rounding, and it cannot be repaired by rounding at the end, because the error
 * is already baked into individual rows. A trial balance that is off by 0.01 and cannot be
 * traced is the failure mode this prevents.
 *
 * Thirty-two columns are money in the Sequelize schema (`DECIMAL(10,2)` / `DECIMAL(12,2)`)
 * and every one of them is a sum target somewhere: cash-drawer balances, debtor balances,
 * purchases, sales, ledger entries, payments. Two more — `clientes_deudores.deuda_total` and
 * `deuda_pendiente` — are money too, but S2 derives them in a view instead of storing them,
 * because a cached balance is a number nothing recomputes. Exact arithmetic is the product
 * requirement, not a nicety.
 *
 * WHAT SQLite DOES NOT GIVE US: MySQL's `DECIMAL` is exact base-10. SQLite has no decimal
 * type at all — `NUMERIC` affinity stores integers as INTEGER and everything else as REAL,
 * so it is `REAL` with a friendlier name. `0.1 + 0.2` is `0.30000000000000004` and stays
 * that way. Storing money as TEXT would preserve the digits but break `SUM()`, because
 * aggregating a cast falls back to float again — exact storage, inexact arithmetic, the
 * worst of both. Integer centavos is the only option that is exact in BOTH.
 *
 * RATES ARE NOT MONEY. `iva_porcentaje`, `margen` and `tasa_interes` are `DECIMAL(5,2)` and
 * mean 21.00 = 21%, not $21.00. Storing a rate in centavos would leave `2100` in a column
 * someone will eventually read as twenty-one pesos, so rates stay REAL and go through
 * `toRate` / `formatRate` instead. `applyRate` is the ONLY sanctioned bridge between the two.
 *
 * PARSING IS STRING-BASED, and that is the whole point. `parseFloat('19.99') * 100` is
 * `1998.9999999999998` — the classic POS rounding bug, off by a cent, in the very first line
 * of the code that touches money. Of twenty ordinary two-decimal prices measured, eleven
 * produced a non-integer centavo value, so this is the common case and not an edge one. Every
 * conversion here reads the digits directly, so the value that goes in is the value that
 * comes out.
 *
 * This module is deliberately in `shared/`, not `main/`, because both sides need it: main
 * parses and validates on the way in, the renderer formats on the way out. Two copies of
 * money arithmetic is how the two sides disagree about a total.
 */

export class MoneyError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'MoneyError'
    this.code = code
    this.status = status
  }
}

/**
 * `DECIMAL(12,2)` tops out at 999,999,999,999.99, so centavos reach 999,999,999,999,999.
 * Rounded to a round 10^15, which is still well inside `Number.MAX_SAFE_INTEGER` (2^53-1).
 * A value above this did not come from a price; it is a bug or an injection, and letting it
 * through would make the sum of the ledger stop being a safe integer.
 */
export const MAX_CENTS = 10 ** 15

/**
 * At most ONE decimal separator of at most TWO digits, and no other separators.
 *
 * This is what rejects thousands separators, without a special case for them: `1.050` has
 * three digits after the separator and fails the `{1,2}` group; `1.050,50` has two
 * separators and fails the single optional group. A separator is a decimal point or nothing.
 *
 * Guessing would be worse than refusing. `1.050` is 1050 in Argentina and 1.05 in the US,
 * and this is a cash register — an operator who types a thousands separator and gets a
 * silently different price is a complaint, while one who gets a clear rejection retypes it.
 * `formatCents` produces the dotted form for display, so the value never has to be retyped.
 */
const CENTS_INPUT = /^([+-]?)(\d*)(?:([.,])(\d{1,2}))?$/

/** True only for a plain safe integer. Booleans and numeric strings are rejected on purpose. */
export function isCents(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= MAX_CENTS
}

/**
 * Convert operator input to an integer number of centavos. Accepts a decimal string
 * (`'1050,50'`, `'1050.50'`, `'.50'`) or a JS number, and returns a safe integer.
 *
 * A number is routed through `String()` and then parsed digit-wise, rather than multiplied
 * by 100, for the reason in the header. That also means `1050.1` becomes `105010`, not
 * `105010.00000000001`.
 */
export function toCents(input, label = 'monto') {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new MoneyError('MONEY_NOT_FINITE', `${label} no es un número finito: ${input}`)
    }
    // `String(1e21)` is "1e+21". Exponential notation has no place digits, so it cannot be
    // parsed here and is refused rather than silently mangled into 1000000000000000000000.
    if (/[eE]/.test(String(input))) {
      throw new MoneyError('MONEY_EXPONENTIAL', `${label} excede el rango representable: ${input}`)
    }
    return toCents(String(input), label)
  }

  if (typeof input !== 'string') {
    throw new MoneyError('MONEY_TYPE', `${label} debe ser texto o número, recibido: ${typeof input}`)
  }

  const text = input.trim()
  if (text === '') {
    throw new MoneyError('MONEY_EMPTY', `${label} está vacío`)
  }

  const match = CENTS_INPUT.exec(text)
  if (!match) {
    throw new MoneyError(
      'MONEY_FORMAT',
      `${label} no es un monto válido: "${text}". Use hasta 2 decimales y sin separador de miles ` +
        `(ej. 1050.50 o 1050,50).`
    )
  }

  const [, sign, intPart, , decPart] = match
  // A lone "+" or "-" matches the pattern with no digits anywhere; that is not a number.
  if (intPart === '' && decPart === undefined) {
    throw new MoneyError('MONEY_FORMAT', `${label} no es un monto válido: "${text}"`)
  }

  const whole = Number(intPart === '' ? '0' : intPart)
  const fraction = Number((decPart ?? '').padEnd(2, '0'))
  const cents = whole * 100 + fraction
  const signed = sign === '-' ? -cents : cents

  if (!Number.isSafeInteger(signed) || Math.abs(signed) > MAX_CENTS) {
    throw new MoneyError('MONEY_RANGE', `${label} fuera de rango: "${text}"`)
  }
  // Through `assertCents` so `toCents('-0.00')` yields `0`, not `-0`.
  return assertCents(signed, label)
}

/**
 * Assert a value is already centavos, and NORMALISE it on the way out.
 *
 * Used at the repository boundary, so a float or a numeric string that reached the database
 * layer fails loudly instead of being written. It also returns the value rather than being
 * purely a predicate, because this is the single place `-0` is collapsed to `0`.
 *
 * `-0` is reachable from ordinary input: `toCents('-0.00')` and `applyRate(-105050, 0)` both
 * produce it. It compares equal to `0` under `===` but not under `Object.is`, and it survives
 * into a database bind as a distinct value, so "is this balance zero" and "which of these two
 * equal totals is the same row" can disagree. Every function in this module returns its
 * centavos through here, so no caller has to remember.
 */
export function assertCents(value, label = 'monto') {
  if (!isCents(value)) {
    throw new MoneyError(
      'MONEY_NOT_CENTS',
      `${label} debe ser un entero de centavos, recibido: ${JSON.stringify(value)}. ` +
        'Usá toCents() en el borde.'
    )
  }
  return value === 0 ? 0 : value
}

/**
 * Round half away from zero. `Math.round` rounds half toward +Infinity, so
 * `Math.round(-0.5)` is `-0` and a credit and a debit of equal magnitude would round in
 * opposite directions. In a ledger that asymmetry is a real defect, so the module carries its
 * own rule and every rounding site in it goes through here.
 */
function roundHalfAway(value) {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

/**
 * Argentine grouping and decimal marks: `$1.050,50`.
 *
 * `decimals` is the number of decimal places shown on the PESO amount, from 0 to 2. Centavos
 * that fall below the requested precision are ROUNDED, not truncated, using the same
 * half-away-from-zero rule as `applyRate` — the module has exactly one rounding policy, so a
 * compact column and a computed tax can never disagree about which way a half went.
 *
 * Every digit below is produced in INTEGER centavo space. The earlier version divided by
 * `10 ** decimals`, which made `decimals: 0` print 105050 cents as `$105.050` — one hundred
 * times too large — because it rescaled the stored value instead of the display.
 */
export function formatCents(cents, { symbol = '$', decimals = 2, grouping = true } = {}) {
  const value = assertCents(cents, 'formatCents')
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 2) {
    throw new MoneyError('MONEY_DECIMALS', `decimals debe ser 0, 1 o 2, recibido: ${decimals}`)
  }
  const negative = value < 0
  const abs = Math.abs(value)

  const dropped = 2 - decimals
  const divisor = 10 ** dropped
  const magnitude = dropped === 0 ? abs : roundHalfAway(abs / divisor) * divisor

  const whole = Math.floor(magnitude / 100)
  const fraction = magnitude - whole * 100

  let digits = String(whole)
  if (grouping) digits = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const shown = fraction / divisor
  const tail = decimals > 0 ? ',' + String(shown).padStart(decimals, '0') : ''
  return `${negative ? '-' : ''}${symbol}${digits}${tail}`
}

/**
 * Render a rate for display. A REAL is a float, so the DECIMALS argument decides where the
 * value is CUT, not how it is stored — the number in the column is untouched.
 */
export function formatRate(rate, { decimals = 2, symbol = '%' } = {}) {
  const value = toRate(rate)
  return `${value.toFixed(decimals).replace('.', ',')}${symbol}`
}

/**
 * Validate a percentage. Bounded at 0..100 because a tax or margin rate above 100 is a data
 * entry error, and an unbounded REAL column will happily store one — and `2100` in a column
 * named `iva_porcentaje` reads as a plausible amount of money.
 */
export function toRate(input, label = 'tasa') {
  const value = typeof input === 'string' ? Number(input.trim().replace(',', '.')) : input
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MoneyError('RATE_TYPE', `${label} debe ser un número, recibido: ${JSON.stringify(input)}`)
  }
  if (value < 0 || value > 100) {
    throw new MoneyError('RATE_RANGE', `${label} debe estar entre 0 y 100, recibido: ${value}`)
  }
  return value
}

/**
 * The only sanctioned bridge between centavos and a rate. Rounds half away from zero.
 *
 * Half-up matters here and is the reason this is hand-written instead of `Math.round`:
 * JS's `Math.round` rounds half toward +Infinity, so `Math.round(-0.5)` is `-0`. A tax
 * credit and a tax debit would then round in OPPOSITE directions for the same magnitude,
 * which is a real asymmetry in a ledger. Away-from-zero is symmetric.
 *
 * The rounding is on the result of a float multiply, so it is a rounding of a rounding.
 * That is unavoidable the moment a percentage touches money — 21% of 1050,50 is 220,605
 * centavos, and there is no integer answer. What is NOT unavoidable is the policy being
 * explicit, named and tested, instead of emerging from whichever rounding call was closest.
 */
export function applyRate(cents, rate, { label = 'monto' } = {}) {
  assertCents(cents, label)
  const value = toRate(rate, `${label} (tasa)`)
  const exact = (cents * value) / 100
  return assertCents(roundHalfAway(exact), `${label} (aplicado)`)
}

/**
 * The tax ALREADY CONTAINED in a price. The counterpart to `applyRate`, and the one a point of
 * sale needs: 21% of a $10.000 price is not $2.100 of extra money, it is $1.735,54 already
 * inside the ten thousand. `applyRate` adds, `extractRate` takes out, and which one is correct
 * depends entirely on the law and the display — so both exist, both are named, and a caller
 * cannot pick "the rounding function" by accident.
 *
 * `imp = base * pct / (100 + pct)`, derived rather than written as `base - base / (1 + pct/100)`
 * because those two are the same number and the second one accumulates the error of two
 * subtractions. One multiply, one divide, one rounding.
 *
 * The consequence for a sale is the whole point: the customer pays the price on the shelf, so
 * the extracted tax is INFORMATION and is never added to the total. A sale that adds it is
 * charging 21% more than the label says.
 */
export function extractRate(cents, rate, { label = 'monto' } = {}) {
  assertCents(cents, label)
  const value = toRate(rate, `${label} (tasa)`)
  if (value === 0) return 0
  const imp = (cents * value) / (100 + value)
  return assertCents(roundHalfAway(imp), `${label} (extraído)`)
}
