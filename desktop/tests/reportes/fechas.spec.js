import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { IpcError } from '../../src/main/bridge/errors.js'
import {
  cantidadDias,
  diaLocalDe,
  enumerarDias,
  esFechaReal,
  exigirFecha,
  hoyLocal,
  modificadorIso,
  offsetMinutos,
  periodoAnterior,
  rangoPeriodo,
  sumarDias,
  utcDesdeMedianocheLocal
} from '../../src/main/db/reportes/fechas.js'

/**
 * The local-day boundary, proven rather than asserted.
 *
 * EVERY OFFSET IN THIS FILE IS -180, Argentina's, INJECTED. Not because -180 is the right answer
 * everywhere — it is the right answer for this shop and this machine — but because a module that
 * read the host clock on its own could not be pointed at a zone, and then the claim "a sale at
 * 23:30 local counts as today" could only be tested on a machine that happens to BE in Argentina.
 * The parameter is what makes the 21:00-to-midnight case below a test instead of a comment.
 */

const ARG = -180
const ts = (iso) => iso

describe('esFechaReal — a real date, not a well-shaped one', () => {
  it('accepts real dates', () => {
    expect(esFechaReal('2026-10-01')).toBe(true)
    expect(esFechaReal('2024-02-29')).toBe(true)
  })

  it('refuses 2026-02-31, which matches the pattern and does not exist', () => {
    // `new Date('2026-02-31')` does NOT throw — it rolls over to March 3rd. A validator that used
    // it would accept a period ending "February 31" and quietly report 35 days.
    expect(Number.isNaN(Date.parse('2026-02-31T12:00:00Z'))).toBe(false)
    expect(esFechaReal('2026-02-31')).toBe(false)
    expect(esFechaReal('2026-13-01')).toBe(false)
    expect(esFechaReal('2026-00-10')).toBe(false)
  })

  it('refuses anything that is not a bare YYYY-MM-DD', () => {
    expect(esFechaReal('2026-10-01T00:00:00Z')).toBe(false)
    expect(esFechaReal('01/10/2026')).toBe(false)
    expect(esFechaReal('2026-10-01 ')).toBe(false)
    expect(esFechaReal(20261001)).toBe(false)
    expect(esFechaReal(null)).toBe(false)
  })

  it('throws with the caller\'s label, not a bare assertion', () => {
    expect(() => exigirFecha('ayer', 'fechaFin')).toThrow(/fechaFin no es una fecha real/)
  })
})

describe('sumarDias — real calendar arithmetic', () => {
  it('crosses a month end', () => {
    expect(sumarDias('2026-01-31', 1)).toBe('2026-02-01')
    expect(sumarDias('2026-10-01', -1)).toBe('2026-09-30')
  })

  it('knows 2024 is a leap year and 2026 is not', () => {
    expect(sumarDias('2024-02-28', 1)).toBe('2024-02-29')
    expect(sumarDias('2024-02-29', 1)).toBe('2024-03-01')
    expect(sumarDias('2026-02-28', 1)).toBe('2026-03-01')
  })

  it('refuses a fractional number of days', () => {
    // The CODE, not the message. A message regex is a translation contract this test would break
    // the first time somebody rewords a message, and it says nothing about what the renderer
    // branches on. `REPORTE_DIAS_INVALIDOS` is the part a caller can rely on.
    expect(() => sumarDias('2026-10-01', 1.5)).toThrow(IpcError)
    try {
      sumarDias('2026-10-01', 1.5)
      throw new Error('no lanzó')
    } catch (e) {
      expect(e.code).toBe('REPORTE_DIAS_INVALIDOS')
    }
  })
})

describe('cantidadDias and enumerarDias — both ends included', () => {
  it('counts a single day as one, not zero', () => {
    expect(cantidadDias('2026-10-01', '2026-10-01')).toBe(1)
    expect(enumerarDias('2026-10-01', '2026-10-01')).toEqual(['2026-10-01'])
  })

  it('counts a month of 31 days as 31', () => {
    expect(cantidadDias('2026-10-01', '2026-10-31')).toBe(31)
    expect(enumerarDias('2026-10-01', '2026-10-31')).toHaveLength(31)
  })

  it('keeps every day of a period, so a quiet Sunday is still a row', () => {
    const dias = enumerarDias('2026-02-27', '2026-03-02')
    expect(dias).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02'])
  })
})

describe('rangoPeriodo — half-open, local, and the 21:00-to-midnight case', () => {
  it('turns a local day into a UTC interval that starts at 03:00Z', () => {
    const r = rangoPeriodo('2026-10-01', '2026-10-01', ARG)
    expect(r.desde).toBe(ts('2026-10-01T03:00:00.000Z'))
    expect(r.hasta).toBe(ts('2026-10-02T03:00:00.000Z'))
  })

  it('COUNTS a sale at 23:30 local, which is 02:30Z on the NEXT day', () => {
    // This is the case the whole module exists for. The sale's stored timestamp says the 2nd; the
    // shop knows it as the evening of the 1st. `date('now')` in SQLite would say the 2nd too, and
    // a `BETWEEN` on date strings would cut it at midnight and lose it entirely.
    const r = rangoPeriodo('2026-10-01', '2026-10-01', ARG)
    const venta = ts('2026-10-02T02:30:00.000Z')
    expect(venta >= r.desde).toBe(true)
    expect(venta < r.hasta).toBe(true)
  })

  it('EXCLUDES a sale at 00:30 the next local day, which is 03:30Z', () => {
    const r = rangoPeriodo('2026-10-01', '2026-10-01', ARG)
    const venta = ts('2026-10-02T03:30:00.000Z')
    expect(venta >= r.desde).toBe(true)
    expect(venta < r.hasta).toBe(false)
  })

  it('draws the line at the exact instant, not the minute', () => {
    const r = rangoPeriodo('2026-10-01', '2026-10-01', ARG)
    // One millisecond before local midnight of the 2nd is still the 1st.
    expect(ts('2026-10-02T02:59:59.999Z') < r.hasta).toBe(true)
    expect(ts('2026-10-02T03:00:00.000Z') < r.hasta).toBe(false)
  })

  it('covers a multi-day period end to end', () => {
    const r = rangoPeriodo('2026-10-01', '2026-10-31', ARG)
    expect(r.desde).toBe(ts('2026-10-01T03:00:00.000Z'))
    expect(r.hasta).toBe(ts('2026-11-01T03:00:00.000Z'))
  })

  it('reads the offset the other way for a zone east of UTC', () => {
    // UTC+3: local midnight is 21:00Z on the PREVIOUS day, so `desde` must be the day before.
    const r = rangoPeriodo('2026-10-01', '2026-10-01', 180)
    expect(r.desde).toBe(ts('2026-09-30T21:00:00.000Z'))
    expect(r.hasta).toBe(ts('2026-10-01T21:00:00.000Z'))
  })
})

describe('utcDesdeMedianocheLocal — the one conversion, checked from both ends', () => {
  it('agrees with the SQL modifier, in REAL SQLite, which is the claim that matters', () => {
    // The claim is not "the arithmetic is right", it is "the window and the daily GROUPING
    // agree". Those two travel through DIFFERENT code — a JavaScript conversion here and SQLite's
    // own `date()` with a string modifier there — and a disagreement between them is invisible in
    // the totals: every sale in range would still be counted, just under the wrong heading. So the
    // modifier is executed by SQLite, from the same string the reports pass it.
    const db = new DatabaseSync(':memory:')
    try {
      const agrupar = db.prepare('SELECT date(?, ?) AS dia')
      for (const fecha of ['2026-10-01', '2026-02-28', '2024-02-29', '2026-12-31']) {
        // Local midnight, expressed as an instant, must group back onto the date it came from.
        expect(agrupar.get(utcDesdeMedianocheLocal(fecha, ARG), modificadorIso(ARG)).dia).toBe(fecha)
      }
    } finally {
      db.close()
    }
  })

  it('buckets a late-night sale onto the day the shop calls it, in REAL SQLite', () => {
    const db = new DatabaseSync(':memory:')
    try {
      const dia = db.prepare('SELECT date(?, ?) AS d')
      const mod = modificadorIso(ARG)
      expect(dia.get('2026-10-02T02:30:00.000Z', mod).d).toBe('2026-10-01')
      expect(dia.get('2026-10-02T03:30:00.000Z', mod).d).toBe('2026-10-02')
      // The web's `date('now')`, the thing this module exists to avoid, gets the first one wrong
      // during those three hours. Asserted so this test does not merely restate the right answer.
      expect(dia.get('2026-10-02T02:30:00.000Z', '+0 minutes').d).toBe('2026-10-02')
    } finally {
      db.close()
    }
  })

  it('refuses an impossible date before doing any arithmetic on it', () => {
    expect(() => utcDesdeMedianocheLocal('2026-02-31', ARG)).toThrow(/no es una fecha real/)
  })

  it('builds the modifier with the sign the offset already carries', () => {
    expect(modificadorIso(-180)).toBe('-180 minutes')
    expect(modificadorIso(180)).toBe('+180 minutes')
    expect(modificadorIso(0)).toBe('+0 minutes')
  })
})

describe('diaLocalDe — the same boundary, in JavaScript', () => {
  it('puts 23:30 local on the day the shop calls it', () => {
    expect(diaLocalDe(ts('2026-10-02T02:30:00.000Z'), ARG)).toBe('2026-10-01')
  })

  it('puts 00:30 local on the day after', () => {
    expect(diaLocalDe(ts('2026-10-02T03:30:00.000Z'), ARG)).toBe('2026-10-02')
  })

  it('refuses an instant it cannot read', () => {
    expect(() => diaLocalDe('ayer', ARG)).toThrow(/Instante ilegible/)
  })
})

describe('periodoAnterior — same length, and NOT overlapping', () => {
  it('shifts a 31-day window by 31 days', () => {
    expect(periodoAnterior('2026-10-01', '2026-10-31')).toEqual({
      fechaInicio: '2026-08-31',
      fechaFin: '2026-09-30'
    })
  })

  it('ends the day before the current window starts, so no sale is in both halves', () => {
    const previo = periodoAnterior('2026-10-10', '2026-10-20')
    expect(previo.fechaFin < '2026-10-10').toBe(true)
    expect(cantidadDias(previo.fechaInicio, previo.fechaFin)).toBe(
      cantidadDias('2026-10-10', '2026-10-20')
    )
  })

  it('handles a single-day window without producing an empty one', () => {
    const previo = periodoAnterior('2026-10-10', '2026-10-10')
    expect(previo).toEqual({ fechaInicio: '2026-10-09', fechaFin: '2026-10-09' })
  })
})

describe('hoyLocal — the local date, at the hour the UTC date lies', () => {
  it('is YESTERDAY by the web\'s rule at 21:00 local, and today by this one', () => {
    const instante = new Date(ts('2026-10-02T02:30:00.000Z')) // 21:30 on the 1st, Argentina
    // The web's default: `new Date().toISOString().slice(0, 10)`.
    expect(instante.toISOString().slice(0, 10)).toBe('2026-10-02')
    // This one.
    expect(hoyLocal(instante, ARG)).toBe('2026-10-01')
  })

  it('agrees with the offset helper for a real instant', () => {
    const ahora = new Date()
    expect(hoyLocal(ahora, offsetMinutos(ahora))).toBe(hoyLocal(ahora, offsetMinutos(ahora)))
    expect(hoyLocal(ahora, offsetMinutos(ahora))).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
