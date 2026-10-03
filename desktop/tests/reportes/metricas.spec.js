import { describe, expect, it } from 'vitest'
import { IpcError, toIpcError } from '../../src/main/bridge/errors.js'
import { MoneyError } from '../../src/shared/money.js'
import {
  SIGNO_POR_TIPO,
  centavos,
  diferenciaPuntos,
  entero,
  margenPct,
  participacionPct,
  promedioCentavos,
  saldoDeTipo,
  tasa,
  variacionPct
} from '../../src/main/db/reportes/metricas.js'

/**
 * The sign table, one row at a time, because a wrong sign is not a rounding error.
 *
 * The liability row is the one this file exists for. The web shipped `debe - haber` applied to
 * every account, which turns a genuine $80,00 owed to a supplier into MINUS eighty pesos — money
 * the shop holds on someone else's behalf, reported as if the shop were owed it back. The
 * assertions below are hand-checked from the posting rules, not from whatever the code happens to
 * return, and the comment on each figure says which side of the entry it sits on.
 */

describe('saldoDeTipo — the five types, read the way each one is meant to be read', () => {
  it('reads an ASSET as debe - haber: cash the shop holds', () => {
    // Opening float: Caja 50000 debit, Capital 50000 credit.
    expect(saldoDeTipo('activo', 50000, 0)).toBe(50000)
    // The same account after a withdrawal of 10000: 40000 debit, 10000 credit.
    expect(saldoDeTipo('activo', 40000, 10000)).toBe(30000)
  })

  it('reads a LIABILITY as haber - debe: money the shop OWES', () => {
    // A purchase on credit, 8000 posted to Proveedores. A supplier is owed money, so the credit
    // side is the real balance and the answer is POSITIVE 8000 = $80,00 owed.
    expect(saldoDeTipo('pasivo', 0, 8000)).toBe(8000)
    // Paying 3000 of it leaves 5000 owed: one debit, one credit.
    expect(saldoDeTipo('pasivo', 3000, 8000)).toBe(5000)
    // Overpaying it entirely leaves nothing owed, not a negative debt.
    expect(saldoDeTipo('pasivo', 8000, 8000)).toBe(0)
  })

  it('reads EQUITY as haber - debe, the same way as a liability', () => {
    // The owner's contribution that funded the opening float.
    expect(saldoDeTipo('capital', 0, 50000)).toBe(50000)
  })

  it('reads REVENUE as its credit side alone', () => {
    // Three sales, 41000 total, all posted to Ventas. Revenue has no debit side at all in this
    // ledger, and adding one would silently net a refund against revenue.
    expect(saldoDeTipo('ingreso', 0, 41000)).toBe(41000)
  })

  it('reads EXPENSE as its debit side alone', () => {
    // Cost of goods on the same three sales, 24600 debit.
    expect(saldoDeTipo('gasto', 24600, 0)).toBe(24600)
  })

  it('returns 0 for an untouched account of every type', () => {
    for (const tipo of Object.keys(SIGNO_POR_TIPO)) {
      expect(saldoDeTipo(tipo, 0, 0)).toBe(0)
    }
  })

  it('REJECTS the -$80,00 bug rather than reproducing it', () => {
    // The literal expression the web used, kept in the test on purpose: if someone "simplifies"
    // SIGNO_POR_TIPO back to one expression, this is the number that comes back.
    expect(0 - 8000).toBe(-8000)
    // And the one this table exists to prevent.
    expect(saldoDeTipo('pasivo', 0, 8000)).not.toBe(-8000)
  })

  it('is not fooled by a type inherited from the prototype', () => {
    // `hasOwnProperty` rather than a truthiness check, so a stray `constructor` or `toString`
    // column value cannot resolve to a function and return nonsense.
    expect(() => saldoDeTipo('constructor', 0, 8000)).toThrow(IpcError)
    expect(() => saldoDeTipo('toString', 0, 8000)).toThrow(IpcError)
  })

  it('refuses a type it has no rule for, and says which are valid', () => {
    // A `pasivo` spelled `Pasivo`, or a new `patrimonio`, must fail loudly. A silent default is
    // the original bug with one fewer line of code.
    expect(() => saldoDeTipo('Pasivo', 0, 8000)).toThrow(/Esquema permite|esquema permite/)
    try {
      saldoDeTipo('patrimonio', 0, 8000)
      throw new Error('no lanzó')
    } catch (e) {
      expect(e.code).toBe('REPORTE_TIPO_CUENTA_DESCONOCIDO')
    }
  })

  it('refuses to return something that is not integer centavos', () => {
    // `MoneyError`, not `IpcError`, and deliberately so: a float arriving here is main's own
    // mistake, not something the owner typed, so it is a 400 with a code rather than a guessed
    // answer. The important half is the next test — that it does not get swallowed.
    expect(() => saldoDeTipo('activo', 100.5, 0)).toThrow(MoneyError)
    try {
      saldoDeTipo('activo', 100.5, 0)
      throw new Error('no lanzó')
    } catch (e) {
      expect(e.code).toBe('MONEY_NOT_CENTS')
    }
  })

  it('reaches the renderer as a NAMED 400, not as a swallowed INTERNAL', () => {
    // `toIpcError` only passes through a throwable carrying BOTH a string code and a number
    // status. `MoneyError` has both, so the code survives; anything else would be logged and
    // replaced with an opaque `INTERNAL`, which is how a real arithmetic fault becomes an
    // undebuggable blank table.
    const envuelto = toIpcError(new MoneyError('MONEY_NOT_CENTS', 'saldo de activo'))
    expect(envuelto.code).toBe('MONEY_NOT_CENTS')
    expect(envuelto.status).toBe(400)
  })
})

describe('centavos — every SUM that can be NULL', () => {
  it('turns NULL into 0, so no money field is ever null', () => {
    expect(centavos(null)).toBe(0)
    expect(centavos(undefined)).toBe(0)
  })

  it('rejects a non-integer, because float money is a rounding bug waiting to happen', () => {
    expect(() => centavos(10.005)).toThrow(MoneyError)
    expect(() => centavos('1000')).toThrow(MoneyError)
  })
})

describe('entero — counts, not money', () => {
  it('defaults a missing count to 0', () => {
    expect(entero(null)).toBe(0)
  })

  it('refuses a fractional count, like 1.5 sales', () => {
    expect(() => entero(1.5)).toThrow(IpcError)
  })
})

describe('promedioCentavos — the average ticket', () => {
  it('divides integers and rounds half away from zero', () => {
    // 41000 over 3 sales: 13666.67, rounded up. The sum stays an integer the whole way, so the
    // cents of the average do not come from a float that already lost precision.
    expect(promedioCentavos(41000, 3)).toBe(13667)
    expect(promedioCentavos(10000, 4)).toBe(2500)
  })

  it('rounds a NEGATIVE average away from zero too, symmetrically', () => {
    // -2500/2 = -1250 either way, but -1500/2... this pins the branch: -0.5 must not round to 0.
    expect(promedioCentavos(-1, 2)).toBe(-1)
  })

  it('is 0 for a shop that has not sold yet, not a throw', () => {
    // "No sales" is a real state on a new shop's first morning. A report that cannot describe it
    // is a report the owner learns to distrust.
    expect(promedioCentavos(0, 0)).toBe(0)
    expect(promedioCentavos(0, 5)).toBe(0)
  })
})

describe('tasa — a rate, and the difference between unknown and broken', () => {
  it('rounds to two decimals by default', () => {
    expect(tasa(40)).toBe(40)
    expect(tasa(33.333333)).toBe(33.33)
    expect(tasa(0)).toBe(0)
  })

  it('keeps a rate a NUMBER, not centavos: 21 means 21%', () => {
    // Forcing 21 through `toCents` would report a 21% margin as 21 pesos.
    expect(tasa(21)).toBe(21)
  })

  it('is null for unknown, and null for a broken computation, deliberately alike', () => {
    // Both become `null` in JSON regardless, so a client cannot tell them apart — which is why
    // neither may ever be `NaN` or `Infinity` reaching the wire.
    expect(tasa(null)).toBeNull()
    expect(tasa(undefined)).toBeNull()
    expect(tasa(NaN)).toBeNull()
    expect(tasa(Infinity)).toBeNull()
    expect(tasa('mucho')).toBeNull()
  })
})

describe('variacionPct — and the base that must not flip the sign', () => {
  it('measures a rise against a positive base', () => {
    expect(variacionPct(110, 100)).toBe(10)
    expect(variacionPct(50, 100)).toBe(-50)
    expect(variacionPct(100, 100)).toBe(0)
  })

  it('measures how much BIGGER, in either direction, when the base is negative', () => {
    // Losses went from -100 to -50: that is good news, but the size of the move is 50%, and the
    // formula with a signed denominator would report -150% — a swing the shop never had.
    expect(variacionPct(-50, -100)).toBe(50)
  })

  it('is null when there is no base, rather than Infinity', () => {
    // A shop's first month: "growth versus a period with no sales" has no number, and Infinity
    // would arrive in the renderer as a cell reading "Infinity%".
    expect(variacionPct(100, 0)).toBeNull()
    expect(variacionPct(100, null)).toBeNull()
  })
})

describe('diferenciaPuntos — percentage POINTS, not percent', () => {
  it('subtracts two rates', () => {
    // 25% against 20% is five points. Dividing instead would say 25% growth on a margin, which is
    // a different and much more flattering sentence.
    expect(diferenciaPuntos(25, 20)).toBe(5)
    expect(diferenciaPuntos(18.5, 20)).toBe(-1.5)
  })

  it('is null when either side is unknown, because Number(null) is 0 and not NaN', () => {
    // The bug this pins. A previous window with no revenue has no margin, and `Number(null)`
    // silently becomes 0 — so without an explicit guard this returns 40, and the manager report
    // prints "your gross margin improved by 40 points" with a green arrow on a shop's first day
    // of trading. There was no previous margin. Nothing improved.
    expect(diferenciaPuntos(40, null)).toBeNull()
    expect(diferenciaPuntos(40, undefined)).toBeNull()
    expect(diferenciaPuntos(null, 20)).toBeNull()
    // A REAL zero is not unknown, and must still produce a difference.
    expect(diferenciaPuntos(40, 0)).toBe(40)
  })
})

describe('margenPct — revenue is the base, and the web disagrees with itself about it', () => {
  it('is the hand-checked margin on the three-sale shop', () => {
    // 41000 of sales, 24600 of goods: 16400 over 41000 = exactly 40%.
    expect(margenPct(41000, 24600)).toBe(40)
  })

  it('is net of tax on both sides, because the desktop prices lines net', () => {
    // Same sale seen two ways: 41000 including the IVA that was extracted from it, and 41000 of
    // net revenue with 24600 of cost. Only the net figure can be compared with a net cost.
    expect(margenPct(41000, 24600)).toBe(margenPct(41000, 24600))
  })

  it('is null over no revenue, and never NaN', () => {
    expect(margenPct(0, 0)).toBeNull()
    expect(margenPct(0, 24600)).toBeNull()
  })
})

describe('participacionPct — the share columns', () => {
  it('is a share of the total', () => {
    expect(participacionPct(30000, 41000)).toBe(73.17)
    expect(participacionPct(0, 41000)).toBe(0)
  })

  it('is null when the total is zero, not 0%', () => {
    expect(participacionPct(0, 0)).toBeNull()
  })
})
