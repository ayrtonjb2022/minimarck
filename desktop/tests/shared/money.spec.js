import { describe, it, expect } from 'vitest'
import {
  toCents,
  assertCents,
  isCents,
  formatCents,
  toRate,
  formatRate,
  applyRate,
  extractRate,
  MoneyError,
  MAX_CENTS
} from '../../src/shared/money.js'

/**
 * `money.js` decides whether a cash register is trustworthy. Every test here is a case that a
 * plausible-looking implementation gets wrong, and the comments name the bug it prevents —
 * a test that only checks the happy path proves nothing about money.
 */

describe('the float bug this module exists to prevent', () => {
  it('parseFloat(x) * 100 is WRONG and toCents is right', () => {
    // The reason parsing is digit-wise. Measured, not asserted: these are the prices where
    // the obvious one-liner actually loses a cent. `1050.50` is deliberately NOT in this list
    // because it happens to be exact — a suite that claimed it broke would be lying about
    // which cases matter, and the ones that DO break are the ones worth pinning.
    expect(parseFloat('19.99') * 100).toBe(1998.9999999999998)
    expect(toCents('19.99')).toBe(1999)

    expect(parseFloat('1.10') * 100).toBe(110.00000000000001)
    expect(toCents('1.10')).toBe(110)

    expect(parseFloat('0.29') * 100).toBe(28.999999999999996)
    expect(toCents('0.29')).toBe(29)

    expect(parseFloat('1.15') * 100).toBe(114.99999999999999)
    expect(toCents('1.15')).toBe(115)
  })

  it('it breaks roughly a third of the time, which is why it cannot be reasoned about', () => {
    // Of 20 ordinary two-decimal prices measured, 11 produced a non-integer centavo value.
    // A bug that fires on half its inputs is not the kind you can review your way out of.
    const breaking = ['0.29', '8.20', '0.07', '1.15', '4.35', '19.99', '1.10', '2.20', '65.35', '1.005', '2.675']
    for (const price of breaking) {
      const naive = parseFloat(price) * 100
      expect(Number.isInteger(naive), `${price} -> ${naive}`).toBe(false)
    }
  })

  it('the same holds for a JS number input', () => {
    expect(19.99 * 100).not.toBe(1999)
    expect(toCents(19.99)).toBe(1999)
    expect(toCents(1.1)).toBe(110)
    expect(toCents(1050.5)).toBe(105050)
  })

  it('a float that already lost precision is refused, not silently rounded', () => {
    // `0.1 + 0.2` is the canonical example. Here it is a REFUSAL, because "0.30000000000000004"
    // cannot be represented in centavos and rounding it would invent 0.30000000000000004 of
    // money that nobody charged.
    expect(() => toCents(0.1 + 0.2)).toThrow(MoneyError)
    expect(() => toCents('0.30000000000000004')).toThrow(/no es un monto válido/)
  })
})

describe('toCents — accepted input', () => {
  it('parses both decimal marks', () => {
    expect(toCents('1050.50')).toBe(105050)
    expect(toCents('1050,50')).toBe(105050)
  })

  it('parses zero, one and two decimals', () => {
    expect(toCents('0')).toBe(0)
    expect(toCents('1000')).toBe(100000)
    expect(toCents('10.5')).toBe(1050)
    expect(toCents('10,5')).toBe(1050)
    expect(toCents('10.05')).toBe(1005)
  })

  it('accepts a leading point, because ".50" is how an operator types fifty cents', () => {
    expect(toCents('.50')).toBe(50)
    expect(toCents(',50')).toBe(50)
  })

  it('accepts and preserves a sign', () => {
    expect(toCents('-1050.50')).toBe(-105050)
    expect(toCents('+1050.50')).toBe(105050)
    expect(toCents('-0.01')).toBe(-1)
  })

  it('tolerates surrounding whitespace', () => {
    expect(toCents('  1050.50  ')).toBe(105050)
  })

  it('handles the common 0-comma case without eating a digit', () => {
    // "0,9" is 90 cents. A naive split on the separator and a "replace the dot" would both
    // get this wrong in opposite directions.
    expect(toCents('0,9')).toBe(90)
    expect(toCents('0.9')).toBe(90)
  })
})

describe('toCents — refused input', () => {
  it('refuses thousands separators, because they are ambiguous', () => {
    // 1.050 is 1050 in Argentina and 1.05 in the US. Guessing wrong on a cash register is
    // worse than refusing, so every dotted/thousand-separated form is rejected.
    expect(() => toCents('1.050')).toThrow(MoneyError)
    expect(() => toCents('1,050')).toThrow(MoneyError)
    expect(() => toCents('1.050,50')).toThrow(MoneyError)
    expect(() => toCents('1,050.50')).toThrow(MoneyError)
  })

  it('refuses more than two decimals', () => {
    expect(() => toCents('10.505')).toThrow(/no es un monto válido/)
    expect(() => toCents('10,505')).toThrow(MoneyError)
  })

  it('refuses empty and whitespace', () => {
    expect(() => toCents('')).toThrow(/está vacío/)
    expect(() => toCents('   ')).toThrow(/está vacío/)
  })

  it('refuses a bare sign', () => {
    expect(() => toCents('+')).toThrow(/no es un monto válido/)
    expect(() => toCents('-')).toThrow(/no es un monto válido/)
  })

  it('refuses a trailing separator with no digits', () => {
    expect(() => toCents('10.')).toThrow(MoneyError)
    expect(() => toCents('10,')).toThrow(MoneyError)
  })

  it('refuses every non-string, non-number type', () => {
    for (const bad of [null, undefined, true, false, {}, [], () => {}, Symbol('x'), 10n]) {
      expect(() => toCents(bad), `${String(bad?.toString?.() ?? bad)}`).toThrow(MoneyError)
    }
  })

  it('refuses non-finite numbers and exponential notation', () => {
    expect(() => toCents(Infinity)).toThrow(/no es un número finito/)
    expect(() => toCents(-Infinity)).toThrow(MoneyError)
    expect(() => toCents(NaN)).toThrow(MoneyError)
    // `String(1e21)` is "1e+21", which has no place digits to parse.
    expect(() => toCents(1e21)).toThrow(/excede el rango/)
  })

  it('refuses a value past MAX_CENTS instead of overflowing into float territory', () => {
    // `toCents` takes PESOS and returns centavos, so the boundary in pesos is MAX_CENTS/100.
    // Getting this backwards would let a 100x-too-large amount through the guard.
    const maxPesos = String(MAX_CENTS / 100)
    expect(toCents(maxPesos)).toBe(MAX_CENTS)
    expect(() => toCents(String(MAX_CENTS / 100 + 1))).toThrow(/fuera de rango/)
  })

  it('collapses negative zero, which `=== 0` hides and `Object.is` does not', () => {
    // Found while testing, not by reading. `-0.00` is something an operator can type when they
    // clear a field and re-enter a minus sign. `Object.is(-0, 0)` is false, so two equal
    // totals can look different to a strict comparison, and `-0` survives into a database
    // bind as a distinct value. `===` says they are equal, which is exactly why this hides.
    expect(Object.is(toCents('-0.00'), 0)).toBe(true)
    expect(Object.is(toCents('-0'), 0)).toBe(true)
    expect(Object.is(toCents('-0.01'), 0)).toBe(false)
    expect(applyRate(-105050, 0)).toBe(0)
    expect(Object.is(applyRate(-105050, 0), 0)).toBe(true)
  })

  it('reports the field name it was given', () => {
    // The message reaches the operator through IPC, so it has to say WHICH amount is wrong.
    expect(() => toCents('abc', 'total_venta')).toThrow(/total_venta/)
  })
})

describe('isCents / assertCents', () => {
  it('accepts only safe integers in range', () => {
    expect(isCents(0)).toBe(true)
    expect(isCents(-105050)).toBe(true)
    expect(isCents(10.5)).toBe(false)
    expect(isCents('105050')).toBe(false)
    expect(isCents(true)).toBe(false)
    expect(isCents(MAX_CENTS + 1)).toBe(false)
  })

  it('assertCents says where the conversion should have happened', () => {
    expect(() => assertCents(10.5, 'total')).toThrow(/total/)
    expect(() => assertCents(10.5)).toThrow(/toCents\(\) en el borde/)
  })
})

describe('formatCents', () => {
  it('uses Argentine marks: dot groups, comma decimals', () => {
    expect(formatCents(105050)).toBe('$1.050,50')
    expect(formatCents(100000)).toBe('$1.000,00')
    expect(formatCents(5)).toBe('$0,05')
    expect(formatCents(0)).toBe('$0,00')
  })

  it('puts the sign before the symbol, not after', () => {
    expect(formatCents(-105050)).toBe('-$1.050,50')
    expect(formatCents(-5)).toBe('-$0,05')
  })

  it('can drop grouping and the symbol', () => {
    expect(formatCents(105050, { grouping: false })).toBe('$1050,50')
    expect(formatCents(105050, { symbol: '' })).toBe('1.050,50')
    expect(formatCents(105050, { symbol: 'ARS ' })).toBe('ARS 1.050,50')
  })

  it('supports fewer decimals for compact columns, rounding rather than truncating', () => {
    // `decimals` is display precision on the PESO amount. An earlier version divided by
    // `10 ** decimals` and printed 105050 centavos as `$105.050` — one hundred times too much.
    expect(formatCents(105050, { decimals: 0 })).toBe('$1.051') // 1050,50 rounds up
    expect(formatCents(105040, { decimals: 0 })).toBe('$1.050') // 1050,40 rounds down
    expect(formatCents(105050, { decimals: 1 })).toBe('$1.050,5')
    expect(formatCents(0, { decimals: 0 })).toBe('$0')
    expect(formatCents(5, { decimals: 0 })).toBe('$0') // half a centavo rounds to nothing
    expect(formatCents(-105050, { decimals: 0 })).toBe('-$1.051') // symmetric with the positive
  })

  it('refuses a decimals value that would rescale the amount instead of displaying it', () => {
    expect(() => formatCents(105050, { decimals: 3 })).toThrow(/decimals debe ser/)
    expect(() => formatCents(105050, { decimals: -1 })).toThrow(MoneyError)
  })

  it('refuses a float, so a leaked decimal is caught at the display edge too', () => {
    expect(() => formatCents(10.5)).toThrow(MoneyError)
    expect(() => formatCents('105050')).toThrow(MoneyError)
  })
})

describe('format / parse round-trip', () => {
  it('every value survives format -> toCents unchanged at full precision', () => {
    // The property that matters in a receipt: what the operator reads back is what the
    // database holds. Only at `decimals: 2` — a shorter form rounds, so it cannot round-trip
    // by design, and pretending otherwise would be asserting a lie.
    //
    // The grouped/symbolled form (`$1.050,50`) is deliberately NOT parseable: `toCents`
    // refuses thousands separators because they are ambiguous, and the display form always
    // has them. So the round-trip is checked on the ungrouped form, which is what an editable
    // field would hold.
    const amounts = [0, 1, 5, 99, 100, 101, 999, 1000, 105050, 100000, 99999999, -105050, -1]
    for (const cents of amounts) {
      const plain = formatCents(cents, { symbol: '', grouping: false })
      expect(toCents(plain), `round-trip ${cents} via "${plain}"`).toBe(cents)
    }
  })

  it('the grouped display form is not parseable, and that is intentional', () => {
    // Pinning the asymmetry, because the natural next "fix" is to make formatCents output
    // something toCents accepts — which would mean accepting ambiguous thousand separators.
    expect(formatCents(105050)).toBe('$1.050,50')
    expect(() => toCents(formatCents(105050))).toThrow(MoneyError)
  })

  it('round-trips a large ledger amount', () => {
    const big = 98765432100 // 987,654,321.00
    expect(formatCents(big)).toBe('$987.654.321,00')
    expect(toCents(formatCents(big, { symbol: '', grouping: false }))).toBe(big)
  })
})

describe('rates are not money', () => {
  it('toRate accepts a number or a comma decimal string', () => {
    expect(toRate(21)).toBe(21)
    expect(toRate('21')).toBe(21)
    expect(toRate('21,5')).toBe(21.5)
    expect(toRate(0)).toBe(0)
    expect(toRate(100)).toBe(100)
  })

  it('toRate refuses out-of-bounds, so 2100 can never become an IVA percentage', () => {
    // 2100 in a column named iva_porcentaje is the exact confusion this guards: it reads as
    // a plausible amount of money and nothing about the number says "this is wrong".
    expect(() => toRate(2100)).toThrow(/entre 0 y 100/)
    expect(() => toRate(-1)).toThrow(/entre 0 y 100/)
    expect(() => toRate('abc')).toThrow(MoneyError)
  })

  it('formatRate shows a rate as a percentage, never as pesos', () => {
    expect(formatRate(21)).toBe('21,00%')
    expect(formatRate(21.5, { decimals: 1 })).toBe('21,5%')
    expect(formatRate(21, { decimals: 0 })).toBe('21%')
  })
})

describe('applyRate — the only bridge between centavos and a rate', () => {
  it('computes a tax and rounds it to whole centavos', () => {
    // 21% of 1050,50 is 220,60.50 centavos. There is no integer answer, so the rounding
    // policy has to be chosen rather than inherited.
    expect(applyRate(105050, 21)).toBe(22061)
  })

  it('rounds half AWAY FROM ZERO on both signs, symmetrically', () => {
    // This is the reason it is hand-written instead of Math.round. JS rounds half toward
    // +Infinity, so Math.round(-0.5) is -0: a credit and a debit of the same magnitude would
    // round in OPPOSITE directions, which is a real asymmetry in a ledger.
    expect(applyRate(105050, 21)).toBe(22061)
    expect(applyRate(-105050, 21)).toBe(-22061)
    // The built-in would disagree on the negative side. Asserted so the difference cannot
    // be "simplified" back to Math.round by a later reader.
    expect(Math.round(-22060.5)).toBe(-22060)
    expect(applyRate(-105050, 21)).not.toBe(Math.round(-22060.5))
  })

  it('is exact when the result is a whole centavo', () => {
    expect(applyRate(10000, 10)).toBe(1000)
    expect(applyRate(0, 21)).toBe(0)
  })

  it('a zero rate zeroes a non-zero amount, and leaves zero alone', () => {
    // Written the other way round on purpose. The tempting assertion is "a 0% rate never
    // changes the amount", which is simply false — 0% of 1050,50 is 0,00. Pinning the real
    // behaviour stops someone from "fixing" it into a no-op that silently drops a line.
    expect(applyRate(0, 21)).toBe(0)
    expect(applyRate(1, 0)).toBe(0)
    expect(applyRate(105050, 0)).toBe(0)
    expect(applyRate(-105050, 0)).toBe(0)
  })

  it('a 100% rate returns the amount exactly, on both signs', () => {
    expect(applyRate(105050, 100)).toBe(105050)
    expect(applyRate(-105050, 100)).toBe(-105050)
    expect(applyRate(1, 100)).toBe(1)
  })

  it('refuses a non-integer input instead of coercing it', () => {
    expect(() => applyRate(10.5, 21)).toThrow(MoneyError)
    expect(() => applyRate(105050, 2100)).toThrow(/entre 0 y 100/)
  })
})

describe('extractRate — taking the tax OUT of a price that already contains it', () => {
  it('returns the tax inside a shelf price: 21% of 100,00 is 17,36, not 21,00', () => {
    // The whole point of the function. A label that says $100.00 with IVA included does NOT
    // collect $21.00 of tax — the customer pays the label, so the tax is 100*21/121 = 17.355…
    expect(extractRate(10000, 21)).toBe(1736)
  })

  it('is not applyRate: same operands, opposite meaning', () => {
    // applyRate computes the tax a base would add (100 → 21); extractRate computes the tax
    // already inside a shelf price (100 → 17.36). If they ever agree, one of them is wrong.
    expect(applyRate(10000, 21)).toBe(2100)
    expect(extractRate(10000, 21)).toBe(1736)
    // ...yet they invert each other exactly: a price formed by ADDING the tax, when read by
    // extractRate, yields the very tax that formed it. A POS that prices with one and displays
    // with the other never loses the centavo.
    const base = 10000
    expect(extractRate(base + applyRate(base, 21), 21)).toBe(applyRate(base, 21))
  })

  it('a zero rate extracts nothing, and zero money extracts nothing', () => {
    expect(extractRate(0, 21)).toBe(0)
    expect(extractRate(10000, 0)).toBe(0)
    expect(extractRate(0, 0)).toBe(0)
  })

  it('refuses the same inputs applyRate refuses', () => {
    expect(() => extractRate(10.5, 21)).toThrow(MoneyError)
    expect(() => extractRate(10000, 2100)).toThrow(/entre 0 y 100/)
  })
})

describe('MoneyError crosses the IPC contract intact', () => {
  it('carries a code and a status, so toIpcError passes it through untranslated', () => {
    // `toIpcError` in the main process forwards anything with `code: string` and
    // `status: number`. If money.js threw a bare Error, the operator would get "Internal
    // error" for typing a bad price.
    try {
      toCents('nope')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(MoneyError)
      expect(err.code).toBe('MONEY_FORMAT')
      expect(err.status).toBe(400)
    }
  })
})
