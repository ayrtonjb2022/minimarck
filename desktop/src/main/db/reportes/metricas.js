import { IpcError } from '../../bridge/errors.js'
import { assertCents } from '../../../shared/money.js'

/**
 * The arithmetic every report shares: the per-account-type sign, safe division, and rounding.
 *
 * THE SIGN RULE, which is the reason this file is not just three lines of helpers. A ledger stores
 * two columns per account per entry, `debe_centavos` and `haber_centavos`, and a single expression
 * — `SUM(debe) - SUM(haber)` — turns all of them into a number that is meaningful for some account
 * types and backwards for others. The web states the correct convention in prose at
 * `contabilidad.controller.js:480-484` and implements it at lines 502-517, and it is reproduced
 * here as a table rather than as an expression, because an expression cannot carry a per-type
 * sign:
 *
 *     activo   ->  debe - haber    an asset is what the shop OWES itself: cash, stock, a receivable
 *     pasivo   ->  haber - debe    a liability is what the shop owes OTHERS: a supplier, a loan
 *     capital  ->  haber - debe    equity is contributed on the credit side
 *     ingreso  ->  haber           revenue is recognised on the credit side
 *     gasto    ->  debe            an expense is recognised on the debit side
 *
 * A debt the shop genuinely owes is `haber 8000, debe 0`, and `debe - haber` calls that
 * `-8000`. Printed as a liability, that is `-$80,00` for money the shop is holding on someone
 * else's behalf — the ledger's sign is telling the truth and the report is not. This is a real
 * bug this project already shipped, which is why the rule is a lookup keyed on the exact
 * `cuentas_contables.tipo` values the schema CHECKs over, and why an unknown type is a THROW.
 *
 * IT THROWS RATHER THAN DEFAULTING. A silent `return debe - haber` fallback for an unrecognised
 * type is the original bug with one fewer line of code: the schema allows five values today and
 * a sixth — a `pasivo` spelled `Pasivo`, a new `patrimonio` — would come back with the wrong
 * sign and no error. Forcing the choice at the point where the sign is decided is the only place
 * it can still be made by somebody who knows the answer.
 */

/** The five types `cuentas_contables.tipo` CHECKs over, mapped to how a balance is read off. */
export const SIGNO_POR_TIPO = Object.freeze({
  // Debe-normal: what the shop has.
  activo: (debe, haber) => debe - haber,
  gasto: (debe, haber) => debe - haber,
  // Haber-normal: what the shop owes, and what came in.
  pasivo: (debe, haber) => haber - debe,
  capital: (debe, haber) => haber - debe,
  ingreso: (debe, haber) => haber
})

/**
 * The signed balance of one account, in centavos, read the way its TYPE is meant to be read.
 *
 * Throws `REPORTE_TIPO_CUENTA_DESCONOCIDO` for a type with no stated meaning. That is a loud
 * failure on purpose: a balance sheet is a claim about the shop's money, and the one number in it
 * that must never be a guess is the sign of a liability.
 */
export function saldoDeTipo(tipo, debeCentavos, haberCentavos) {
  const leer = Object.prototype.hasOwnProperty.call(SIGNO_POR_TIPO, tipo)
    ? SIGNO_POR_TIPO[tipo]
    : null
  if (!leer) {
    throw new IpcError(
      'REPORTE_TIPO_CUENTA_DESCONOCIDO',
      500,
      `No hay regla de signo para el tipo de cuenta ${JSON.stringify(tipo)}. ` +
        `El esquema permite: ${Object.keys(SIGNO_POR_TIPO).join(', ')}. ` +
        'Definí el signo antes de que un reporte lo invente.'
    )
  }
  return assertCents(leer(debeCentavos, haberCentavos), `saldo de ${tipo}`)
}

/** Every `SUM()` that can be NULL returns 0 through here, so no figure is ever null money. */
export function centavos(value, etiqueta = 'total') {
  return assertCents(value ?? 0, etiqueta)
}

/** Whole units, never a float: a count of sales, of days, of products. */
export function entero(value, etiqueta = 'cantidad') {
  const n = value ?? 0
  if (!Number.isSafeInteger(n)) {
    throw new IpcError('REPORTE_CANTIDAD_INVALIDA', 500, `${etiqueta} no es un entero: ${value}`)
  }
  return n
}

/**
 * An average in centavos, rounded half away from zero — so a credit and a debit of equal
 * magnitude round the same way, which is the same rule `money.js` uses everywhere else and for
 * the same reason.
 *
 * The sum arrives as an integer, not a pesos float that has already lost its cents, so the whole
 * average is integer arithmetic. `cantidad === 0` is `0` and not a throw: "no sales yet" is a
 * state a new shop is in on its first morning, and a report that cannot describe it is a report
 * the owner learns to distrust.
 */
export function promedioCentavos(totalCentavos, cantidad, etiqueta = 'promedio') {
  const total = centavos(totalCentavos, etiqueta)
  const n = entero(cantidad, `${etiqueta}: cantidad`)
  if (n <= 0) return 0
  return assertCents(redondearMedioLejos(total / n), etiqueta)
}

function redondearMedioLejos(valor) {
  return valor < 0 ? -Math.round(-valor) : Math.round(valor)
}

/**
 * A RATE, rounded to `decimales` and guaranteed finite. Rates are not money and are not centavos:
 * `formatRate` exists in `money.js` precisely because `21` means `21%`, not 21 cents, and forcing
 * a margin through `toCents` would turn 21,5% into 2150.
 *
 * `null` in, `null` out — a margin over no sales is unknown, not zero, and a report that says
 * "0%" for a shop that has not sold anything is stating something false. `NaN` and `Infinity`
 * cannot reach JSON: `JSON.stringify` turns them into `null` silently, so a client would see the
 * same `null` for "unknown" and for "the computation broke", and nothing could tell them apart.
 */
export function tasa(valor, decimales = 2) {
  if (valor === null || valor === undefined) return null
  const n = Number(valor)
  if (!Number.isFinite(n)) return null
  const f = 10 ** decimales
  return Math.round(n * f) / f
}

/**
 * Percentage change from `anterior` to `actual`, or `null` when there is no base to divide by.
 *
 * `Math.abs(anterior)` in the denominator, not `anterior`: the same formula has to be able to
 * express "losses grew" without a sign flip, and `(-50 - 20) / 20` is -350% while
 * `(-50 - 20) / -20` is +150%, which is a gain the shop did not have. The absolute value is what
 * makes the number mean "how much bigger, in either direction".
 */
export function variacionPct(actual, anterior) {
  const a = Number(anterior)
  const b = Number(actual)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null
  return tasa(((b - a) / Math.abs(a)) * 100)
}

/**
 * The difference between two rates, in PERCENTAGE POINTS rather than percent.
 *
 * THE NULL GUARD IS EXPLICIT AND IT IS NOT REDUNDANT. `Number(null)` is `0`, not `NaN`, so a
 * previous period with no revenue — whose margin `margenPct` correctly reported as `null` — would
 * otherwise be read as a margin of exactly 0%. On a shop's first day that turns "there is no
 * previous margin to compare against" into "your margin improved by 40 points", which is a false
 * claim about a real business, printed with a green arrow next to it. `variacionPct` gets the
 * right answer by accident, because its zero-base check happens to catch the same `0`; this one
 * had no such accident available to it.
 */
export function diferenciaPuntos(actual, anterior) {
  if (actual === null || actual === undefined) return null
  if (anterior === null || anterior === undefined) return null
  const a = Number(actual)
  const b = Number(anterior)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return tasa(a - b)
}

/**
 * A margin as a rate, from an integer amount of revenue in centavos and an integer cost.
 *
 * Deliberately takes the revenue as the base and nothing else, because the two reports that both
 * show a margin have to agree on what revenue MEANS. The web disagrees with itself here:
 * `reporteGerencial` divides by `ventasTotales` and `reporteAnalisisNegocio` divides by
 * `subtotalVentas` — one includes IVA, the other does not — so the same shop on the same day is
 * shown two different margins on two tabs. The desktop records `subtotal_centavos` and
 * `costo_unitario_centavos` on every line, so it can value the sale net of tax, and it does that
 * everywhere. See `DIVERGENCES.md`.
 */
export function margenPct(ingresosCentavos, costoCentavos) {
  const ingresos = centavos(ingresosCentavos, 'margen: ingresos')
  const costo = centavos(costoCentavos, 'margen: costo')
  if (ingresos === 0) return null
  return tasa(((ingresos - costo) / ingresos) * 100)
}

/**
 * A percentage of an amount in centavos, used for the share columns the comparison tables carry.
 * `0 / 0` is `null` rather than `0` for the same reason a margin over no revenue is.
 *
 * The name is `participacionPct` and NOT `participationPct`, which is what it was briefly
 * exported as. Every other identifier in this file is Spanish, the doc comment above said
 * `participacionPct`, and nothing imported it yet — so the typo was invisible at every layer
 * except the one that reads the export list, and it would have surfaced as
 * `participacionPct is not a function` inside whichever report reached for the share column
 * first. A misspelling that costs nothing until the day somebody calls it is the expensive kind.
 */
export function participacionPct(parteCentavos, totalCentavos) {
  const parte = centavos(parteCentavos, 'participación: parte')
  const total = centavos(totalCentavos, 'participación: total')
  if (total === 0) return null
  return tasa((parte / total) * 100)
}
