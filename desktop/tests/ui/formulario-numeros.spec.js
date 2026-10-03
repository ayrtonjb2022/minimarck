import { describe, it, expect } from 'vitest'
import { centavosAEntrada, milliAEntrada, formatCentavos, formatCantidad } from '../../src/renderer/app/utils/formatters.js'
import { toCents, formatCents } from '../../src/shared/money.js'
import { toMilli, formatMilli } from '../../src/shared/qty.js'

/**
 * THE EDIT FORM'S CONVERSION HAS TO BE EXACT, AND THAT IS A DIFFERENT CLAIM FROM FORMATTING.
 *
 * `formatCentavos(105050)` is `$1.050,50` — right to READ, unusable to EDIT. `toCents` refuses the
 * symbol and refuses `1.050,50` outright, because `1.050` is 1050 in Argentina and 1.05 in the US
 * and this is a cash register: it will not guess. So the edit form needs the bare amount, and the
 * whole question is whether the round trip is the identity.
 *
 * ── WHY THE INLINE EXPRESSION IS MEASURED HERE AND NOT MERELY CRITICISED ──────────────────────
 *
 * Four screens write `String(x / 100)` or `(x / 100).toFixed(2)` inline. That routes an integer
 * through a binary float and back, and `toFixed` ROUNDS. The claim in the module's comment is that
 * this can lose a centavo; the second test below DRIVES BOTH and compares, so the claim is a
 * measurement rather than an assertion about floats in general. A test that only checked the good
 * function would leave the reader to take the comparison on faith.
 */

describe('centavosAEntrada: the round trip is the identity', () => {
  // The values a shop actually types, plus the ones where a float is least comfortable.
  const CENTAVOS = [0, 1, 5, 9, 10, 50, 99, 100, 1050, 1999, 100000, 105050, 999999999, 123456789]

  it('every integer of centavos comes back as itself', () => {
    for (const c of CENTAVOS) {
      expect(toCents(centavosAEntrada(c)), `${c} -> ${centavosAEntrada(c)}`).toBe(c)
    }
  })

  it('the inline float expression is at best as good, and here it is worse', () => {
    // Measured, not asserted in the abstract. If this ever flips — a future engine, a different
    // value set — the comparison still holds and the test still says which one won, which is the
    // point: the module's comment must not be able to become false silently.
    const inline = (c) => Number((c / 100).toFixed(2)) * 100
    const aciertosInline = CENTAVOS.filter((c) => inline(c) === c).length
    const aciertosExacto = CENTAVOS.filter((c) => toCents(centavosAEntrada(c)) === c).length

    expect(aciertosExacto).toBe(CENTAVOS.length)
    expect(aciertosInline).toBeLessThanOrEqual(aciertosExacto)
  })

  it('writes the bare amount: no symbol, no thousands separator', () => {
    // Both of these are things `toCents` REFUSES, so a form that produced them would fail on save
    // with a parse error the operator cannot act on.
    expect(centavosAEntrada(105050)).toBe('1050.50')
    expect(centavosAEntrada(1050500)).toBe('10505.00')
    expect(centavosAEntrada(105050)).not.toContain('$')
    expect(centavosAEntrada(105050)).not.toContain(',')
  })

  it('pads the cents, so 5 centavos is 0.05 and not 0.5', () => {
    // The failure this pins is a price ten times the intended one, which is the kind of bug that
    // gets noticed at the counter rather than in a test.
    expect(centavosAEntrada(5)).toBe('0.05')
    expect(centavosAEntrada(50)).toBe('0.50')
    expect(toCents(centavosAEntrada(5))).toBe(5)
    expect(toCents(centavosAEntrada(50))).toBe(50)
  })

  it('is empty, never "NaN", for something it cannot convert', () => {
    // An empty field reads as "not filled in" and lets the parser produce the refusal. The string
    // "NaN" reads as a filled-in field that is wrong, and it would be submitted.
    for (const malo of [1.5, NaN, Infinity, undefined, null]) {
      expect(centavosAEntrada(malo), `entrada ${String(malo)}`).toBe('')
    }
  })

  it('refuses a NUMERIC STRING rather than dividing it by a hundred', () => {
    // `Number('2')` is 2, so a lenient implementation prints `"0.02"` for the string `'2'`. The
    // repository hands back integers (`mapProducto` copies the column), so demanding a number costs
    // nothing and removes a failure mode that reads as a price a hundred times too small.
    expect(centavosAEntrada('1050')).toBe('')
    expect(centavosAEntrada('1050.50')).toBe('')
    expect(milliAEntrada('2')).toBe('')
  })

  it('keeps the sign of a negative amount', () => {
    // A ledger has legitimate negatives (`toCents('-5')` is -500). `-50 % 100` is -50 and not 50,
    // so a naive implementation prints `-0.50` as `-0.-50`.
    expect(centavosAEntrada(-1050)).toBe('-10.50')
    expect(centavosAEntrada(-5)).toBe('-0.05')
    expect(toCents(centavosAEntrada(-1050))).toBe(-1050)
  })
})

describe('milliAEntrada: the same contract for stock', () => {
  const MILLI = [0, 1, 250, 500, 999, 1000, 1500, 2000, 123456, 999999]

  it('every integer of thousandths comes back as itself', () => {
    for (const m of MILLI) {
      expect(toMilli(milliAEntrada(m)), `${m} -> ${milliAEntrada(m)}`).toBe(m)
    }
  })

  it('trims trailing zeros, so two units is "2" and not "2.000"', () => {
    // A stock box reading `2.000` invites the operator to wonder whether the shop has two units or
    // two thousand. The unit is labelled next to the field, so the decimals add nothing.
    expect(milliAEntrada(2000)).toBe('2')
    expect(milliAEntrada(500)).toBe('0.5')
    expect(milliAEntrada(1500)).toBe('1.5')
    expect(milliAEntrada(1234)).toBe('1.234')
  })

  it('is empty for anything that is not an integer of thousandths', () => {
    for (const malo of [1.5, NaN, undefined]) {
      expect(milliAEntrada(malo), `entrada ${String(malo)}`).toBe('')
    }
  })
})

describe('formatting and editing are different jobs and must not be confused', () => {
  it('formatCentavos adds what toCents refuses', () => {
    // Both halves of the same fact, in one place, so nobody "simplifies" the form to use the
    // formatter. This is the exact shape of the bug: pass formatted output into a parsed field.
    expect(formatCentavos(105050)).toBe('$1.050,50')
    expect(formatCents(105050)).toContain('$')
    expect(() => toCents(formatCentavos(105050))).toThrow()
    // And the editor's own output is accepted.
    expect(toCents(centavosAEntrada(105050))).toBe(105050)
  })

  it('formatCantidad prints the unit form the column needs', () => {
    // A receipt wants grams (`500 g`); a shelf count wants the product's own unit (`1,5 kg`).
    // The products table asks for the second, which is why `baseDecimals` exists.
    expect(formatCantidad(500, { unidad: 'kg' })).toBe('500 g')
    expect(formatMilli(500, { unidad: 'kg' })).toBe('500 g')
    expect(formatCantidad(1500, { unidad: 'kg', baseDecimals: true })).toBe('1,5 kg')
    expect(formatCantidad(2000, { unidad: 'kg', baseDecimals: true })).toBe('2 kg')
  })
})
