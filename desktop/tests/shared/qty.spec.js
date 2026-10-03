import { describe, it, expect } from 'vitest'
import {
  QTY_SCALE,
  QtyError,
  assertMilli,
  costoPromedioCentavos,
  escalaUnidad,
  formatMilli,
  isMilli,
  lineTotalCentavos,
  toMilli
} from '../../src/shared/qty.js'
import { extractRate } from '../../src/shared/money.js'

/**
 * These tests assert INVARIANTS, not a table of cases copied off the implementation.
 *
 * The invariants are: a quantity is a safe integer in thousandths, a quantity typed by a person
 * becomes exactly the number they typed, and a line's money is the exact product of its price and
 * its quantity with ONE named rounding step. The last one is the one a real sale depends on —
 * 500 grams of a $2.000/kilo product is $100.00, and if that line is off by a centavo the shop's
 * drawer is off by a centavo for every kilo it ever weighs.
 */

describe('toMilli — operator input becomes an exact integer', () => {
  it('converts the decimal forms a scale or a keyboard produces', () => {
    expect(toMilli('0.5')).toBe(500)
    expect(toMilli('0,5')).toBe(500)
    expect(toMilli('0.500')).toBe(500)
    expect(toMilli('0.001')).toBe(1)
    expect(toMilli('1')).toBe(1000)
    expect(toMilli('2')).toBe(2000)
    expect(toMilli('.5')).toBe(500)
    expect(toMilli(1)).toBe(1000)
    expect(toMilli(0.5)).toBe(500)
    expect(toMilli(2.5)).toBe(2500)
  })

  it('does not lose a digit to float arithmetic', () => {
    // The whole reason this module parses digit-wise. Of the 9 999 two-decimal values under 100,
    // 145 do not survive `x * 1000` as an integer: `2.01 * 1000` is 2009.9999999999998, so a
    // truncation sells 2.01 kg and takes 2.009 kg off the shelf.
    expect(2.01 * 1000).not.toBe(2010)
    expect(Math.floor(2.01 * 1000)).toBe(2009)
    expect(toMilli('2.01')).toBe(2010)
    expect(toMilli('0.29')).toBe(290)
    expect(toMilli('1.15')).toBe(1150)
    expect(toMilli('8.29')).toBe(8290)
  })

  it('collapses a zero to +0, never -0', () => {
    // `-0` survives into a bind as a distinct value, so "is this zero" and "are these the same
    // row" can disagree. `Object.is` is the assertion that catches it; `toBe` would not.
    expect(Object.is(toMilli('0.000'), 0)).toBe(true)
    expect(Object.is(toMilli('0'), 0)).toBe(true)
  })

  it('refuses a fourth decimal rather than rounding it away', () => {
    // 1 mg of a scale that reads grams is a unit mistake, and silently rounding it is how half a
    // kilo becomes a third of a kilo with no record that anything was lost.
    expect(() => toMilli('0.0001')).toThrow(QtyError)
    expect(() => toMilli('0.0001')).toThrow(/3 decimales/)
  })

  it('reads the separator as a decimal point, always, and says so in the rule', () => {
    // Quantity cannot refuse this the way money does: money caps itself at two decimals so a
    // third digit is unambiguously a thousands separator, and quantity needs three because one
    // gram of a kilo product is 0.001. So `1.000` is one unit, by a stated rule rather than a
    // guess. `formatMilli` groups with a space so this form never comes back typed in.
    expect(toMilli('1.000')).toBe(1000)
    expect(toMilli('1,000')).toBe(1000)
  })

  it('refuses negative and non-finite quantities', () => {
    expect(() => toMilli('-1')).toThrow(QtyError)
    expect(() => toMilli(NaN)).toThrow(QtyError)
    expect(() => toMilli(Infinity)).toThrow(QtyError)
    expect(() => toMilli(1e21)).toThrow(QtyError)
    expect(() => toMilli('')).toThrow(QtyError)
    expect(() => toMilli(null)).toThrow(QtyError)
    expect(() => toMilli({})).toThrow(QtyError)
  })
})

describe('assertMilli — the type boundary', () => {
  it('rejects a float, a numeric string and a boolean', () => {
    expect(() => assertMilli(500.5)).toThrow(QtyError)
    expect(() => assertMilli('500')).toThrow(QtyError)
    expect(() => assertMilli(true)).toThrow(QtyError)
    expect(() => assertMilli(null)).toThrow(QtyError)
  })

  it('accepts zero, because a stock level of zero is legitimate', () => {
    expect(isMilli(0)).toBe(true)
    expect(assertMilli(0)).toBe(0)
  })
})

describe('lineTotalCentavos — the price of one line', () => {
  it('is exact when the arithmetic divides evenly', () => {
    // $2.000/kg at 500 g. This is THE fractional sale, and it must be $100.00 exactly.
    expect(lineTotalCentavos(20000, 500)).toBe(10000)
    expect(lineTotalCentavos(20000, 1000)).toBe(20000)
    expect(lineTotalCentavos(20000, 1500)).toBe(30000)
    expect(lineTotalCentavos(1000, 1)).toBe(1)
  })

  it('rounds half away from zero, symmetrically', () => {
    // 333 cents x 500 milli = 166.5 -> 167. Math.round(166.5) is also 167, but Math.round on the
    // NEGATIVE side is not, and a ledger where a credit and a debit round differently is broken.
    expect(lineTotalCentavos(333, 500)).toBe(167)
    expect(Math.round(-166.5)).toBe(-166) // what this module must NOT do
    expect(lineTotalCentavos(333, 500)).toBe(167)
  })

  it('refuses a price that is not centavos, so a float cannot reach the ledger', () => {
    expect(() => lineTotalCentavos(200.5, 500)).toThrow(QtyError)
    expect(() => lineTotalCentavos('20000', 500)).toThrow(QtyError)
  })

  it('refuses a zero-quantity line, which is not a small sale', () => {
    expect(() => lineTotalCentavos(20000, 0)).toThrow(QtyError)
  })

  it('keeps a whole number of units behaving like units', () => {
    // 1 kg of a $2.000 product, and 1 unit of a $2.000 product, are the same number of centavos.
    expect(lineTotalCentavos(20000, QTY_SCALE)).toBe(20000)
  })
})

/**
 * The moving average a purchase folds into `productos.precio_compra_centavos`.
 *
 * The invariant under test is NOT "the arithmetic matches the formula" — the formula is in the
 * implementation and copying it into a test proves nothing. The invariants are the three that
 * actually decide whether a shop's cost of goods is true:
 *
 *   1. WEIGHTED, NOT LAST-PRICE. Receiving a cheaper lot must drag the average DOWN towards it,
 *      and by the fraction the lot represents of the pile. A last-price-wins cost passes a test
 *      that only checks the new price landed, and then misreports the margin of everything already
 *      on the shelf.
 *   2. EXACT AT THE TOP OF THE RANGE. `stock_milli` reaches 1e12 and a cost 1e15, so the product
 *      is 1e27. In doubles that is a different number, not a rounded one.
 *   3. HALF AWAY FROM ZERO, once, named. The same rule as every other centavo in this codebase.
 */
describe('costoPromedioCentavos — the moving average a purchase writes', () => {

  it('weights the new lot against the stock already on the shelf', () => {
    // 3 units at 12000, then 2 at 15000 -> (3*12000 + 2*15000) / 5 = 13200.
    expect(costoPromedioCentavos(3 * QTY_SCALE, 12000, 2 * QTY_SCALE, 15000)).toBe(13200)
    // The same numbers weighted the other way round is a DIFFERENT answer, and that is the point:
    // 2 units at 15000 and 3 at 12000, restocked in that order, still equals 13200.
    expect(costoPromedioCentavos(2 * QTY_SCALE, 15000, 3 * QTY_SCALE, 12000)).toBe(13200)
  })

  it('drags the average towards a cheaper lot without pretending the shelf was never bought', () => {
    // 1 unit at 12000, receive 3 at 8000 -> (12000 + 3*8000)/4 = 9000, NOT 8000.
    const promedio = costoPromedioCentavos(QTY_SCALE, 12000, 3 * QTY_SCALE, 8000)
    expect(promedio).toBe(9000)
    expect(promedio).not.toBe(8000)
    // A lot too small to move the average moves it only a little: +1 at 0 on a 1000-unit pile.
    expect(costoPromedioCentavos(1000 * QTY_SCALE, 10000, QTY_SCALE, 0)).toBe(9990)
  })

  it('is the new price itself on an empty shelf, and leaves a full one alone on no movement', () => {
    // Nothing on the shelf: the pile cost exactly what this lot cost.
    expect(costoPromedioCentavos(0, 0, 5 * QTY_SCALE, 7400)).toBe(7400)
    // Same price twice in a row is the identity, which is the regression guard for "fold the lot
    // in" having become "overwrite the cost".
    expect(costoPromedioCentavos(7 * QTY_SCALE, 7400, 3 * QTY_SCALE, 7400)).toBe(7400)
  })

  it('stays exact where a double silently loses a centavo', () => {
    // A real pair of legal inputs, found by search over the schema's own ranges. The exact
    // average is ...107 and the double arithmetic gives ...108: ONE centavo, in the cost of
    // goods, on stock that never existed in any real shop but IS permitted by the schema.
    const stock = 175369461060
    const costoAntes = 146392909492051
    const cantidad = 696125
    const costoNuevo = 455817
    expect(costoPromedioCentavos(stock, costoAntes, cantidad, costoNuevo)).toBe(146392328391107)

    // The naive double version, side by side, so the test cannot pass by luck. NOTE: doubles and
    // the exact answer AGREE on plenty of extreme inputs — the first values tried here agreed to
    // the centavo. That is the whole argument for not relying on it: the error is not a visible
    // failure, it is a coin flip that lands wrong sometimes, and "sometimes" is not a property a
    // shop's margin can be built on.
    const ingenuo = Math.round(
      (stock * costoAntes + cantidad * costoNuevo) / (stock + cantidad)
    )
    expect(ingenuo).toBe(146392328391108)
    expect(ingenuo).not.toBe(146392328391107)

    // The top of both schema ranges still answers, exactly, without throwing on the range check.
    expect(costoPromedioCentavos(1e12, 1e15, 1, 1e15)).toBe(1e15)
  })

  it('rounds one half away from zero, the same way as every other centavo', () => {
    // 1 milli at 1000 + 1 milli at 1001, over 2 milli: exactly 1000.5 cents.
    // 1001 here; `Math.round` agrees, and this case exists to pin the RULE the next one breaks.
    expect(costoPromedioCentavos(1, 1000, 1, 1001)).toBe(1001)
    // 3 milli at 1000 + 1 milli at 1001, over 4 milli: 1000.25 -> 1000.
    expect(costoPromedioCentavos(3, 1000, 1, 1001)).toBe(1000)
    // And the half that distinguishes the two rules: 1000.5 must NOT land on the even 1000.
    expect(costoPromedioCentavos(1, 1000, 1, 1001)).not.toBe(1000)
  })

  it('refuses the inputs that have no average, rather than answering with a division by zero', () => {
    expect(() => costoPromedioCentavos(0, 0, 0, 1000)).toThrow(QtyError)
    expect(() => costoPromedioCentavos(0, 0, 0, 1000)).toThrow(/mayor a cero/)
    // A negative balance is not a "lower average", it is a corrupted stock column.
    expect(() => costoPromedioCentavos(-QTY_SCALE, 1000, QTY_SCALE, 1000)).toThrow(QtyError)
    expect(() => costoPromedioCentavos(QTY_SCALE, -1, QTY_SCALE, 1000)).toThrow(QtyError)
    // And the type boundary is the same one the rest of the module keeps.
    expect(() => costoPromedioCentavos(1000.5, 1000, QTY_SCALE, 1000)).toThrow(QtyError)
    expect(() => costoPromedioCentavos(QTY_SCALE, '1000', QTY_SCALE, 1000)).toThrow(QtyError)
  })
})

describe('escalaUnidad and formatMilli', () => {
  it('knows how many milli one of each unit is worth', () => {
    expect(escalaUnidad('kg')).toBe(1000)
    expect(escalaUnidad('l')).toBe(1000)
    expect(escalaUnidad('g')).toBe(1)
    expect(escalaUnidad('ml')).toBe(1)
    expect(escalaUnidad('unidad')).toBe(1)
    expect(escalaUnidad('KG')).toBe(1000)
  })

  it('refuses a unit the schema does not allow, rather than defaulting it to 1', () => {
    // A silent 1 for an unknown unit is how 2 kilos becomes 2 grams.
    expect(() => escalaUnidad('arroba')).toThrow(QtyError)
    expect(() => escalaUnidad('arroba')).toThrow(/unidad de medida desconocida/)
  })

  it('prints the sub-unit below one whole unit and the unit above it', () => {
    expect(formatMilli(500, { unidad: 'kg' })).toBe('500 g')
    expect(formatMilli(1, { unidad: 'kg' })).toBe('1 g')
    expect(formatMilli(1000, { unidad: 'kg' })).toBe('1 kg')
    expect(formatMilli(2000, { unidad: 'kg' })).toBe('2 kg')
    expect(formatMilli(1500, { unidad: 'kg' })).toBe('1 500 g')
    expect(formatMilli(250, { unidad: 'l' })).toBe('250 ml')
    expect(formatMilli(3, { unidad: 'unidad' })).toBe('3 unidad')
    expect(formatMilli(12500, { unidad: 'g' })).toBe('12 500 g')
  })

  it('groups with a space, so a printed quantity cannot be re-typed as a different one', () => {
    // The safety property. Money groups with `.` because its decimal mark is `,`; a quantity has
    // ONE separator and it is the decimal point, so a `.` group would make `12.500 g` parse as
    // 1.5 g. A space is not in the input grammar, so re-typing a printed quantity is an error.
    expect(formatMilli(12500, { unidad: 'g' })).toBe('12 500 g')
    expect(() => toMilli('12 500')).toThrow(QtyError)
    // And the number alone is NOT the quantity: 12500 in the quantity field is 12 500 UNITS, and
    // it is the unit in the printed form that says grams. A bare `12500` is a different sale.
    expect(toMilli('12500')).toBe(12_500_000)
    expect(toMilli('12.5')).toBe(12_500)
  })
})

describe('the two halves of a sale agree with each other', () => {
  it('a half kilo of a product with 21% tax extracts 21% of the line, and the total is untouched', () => {
    // 500 g of a $2.000/kg product: the line is $100.00, the tax inside it is $17.36, and what the
    // customer pays is still $100.00. A sale that ADDS the extracted tax charges 21% over the
    // shelf price, which is the bug this pairing exists to make impossible.
    const linea = lineTotalCentavos(20000, 500)
    expect(linea).toBe(10000)
    const iva = extractRate(linea, 21)
    expect(iva).toBe(1736)
    expect(linea).toBe(10000)
  })

  it('extractRate is the inverse in direction, not in value, of applyRate', () => {
    // 21% of $10.000 is $2.100 EXTRA. 21% INSIDE $10.000 is $1.735,54. Both are correct for their
    // own question, and mixing them up is a 20% error on every price.
    expect(extractRate(10000, 21)).toBe(1736)
    expect(extractRate(0, 21)).toBe(0)
    expect(extractRate(10000, 0)).toBe(0)
  })
})
