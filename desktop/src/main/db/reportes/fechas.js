import { IpcError } from '../../bridge/errors.js'

/**
 * The calendar-day boundary, in one place, for every report in this app.
 *
 * WHY THIS FILE EXISTS AT ALL. Every timestamp in the desktop database is a UTC instant written by
 * SQLite itself: `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, which is `2026-10-01T21:47:03.114Z`. The
 * shop, meanwhile, thinks in days: it opens at 08:00, closes at 23:00, and asks "how much did I
 * sell TODAY". Those two things only agree if somebody converts, and the conversion is the whole
 * difficulty of a reporting module.
 *
 * THE THREE WAYS TO GET IT WRONG, all of which the web actually shipped:
 *
 *   1. `date('now')` in SQLite. That is the machine's UTC today. In Argentina it is today, but it
 *      is *yesterday* for the nine hours a day when the local clock has already passed midnight
 *      and UTC has not. A shop that opens at 00:30 asks for "today" and is told there were no
 *      sales, because the SQL string still says yesterday. This module never calls it.
 *
 *   2. Comparing a date-only string to a timestamp column, which is what the web's `getStats`
 *      does: `fecha >= '2026-10-01'`. MySQL coerces the column to midnight, so a sale at 10:47 is
 *      compared against `2026-10-01 00:00:00` and dropped. The report is not wrong in an obvious
 *      way, it is quietly short. This module always produces a full instant for both ends.
 *
 *   3. Hardcoding the offset, which is what the web's `reporteGastos` does with
 *      `INTERVAL 3 HOUR` in seven separate queries. It is right for Argentina today and right for
 *      nobody who moves, and it is a claim repeated seven times that nobody can check. This module
 *      derives the offset from the host clock, once, and passes it down.
 *
 * THE SHAPE OF THE FIX. A report is asked for a range of LOCAL days, `[fechaInicio, fechaFin]`.
 * This module turns that into a half-open interval of UTC INSTANTS, `[desde, hasta)`, and hands
 * back the ISO strings the stored timestamps can be compared against lexicographically:
 *
 *     fechaInicio 2026-10-01, fechaFin 2026-10-01, offset -180
 *       desde = 2026-10-01T03:00:00.000Z   (local midnight)
 *       hasta = 2026-10-02T03:00:00.000Z   (local midnight of the next day, EXCLUSIVE)
 *
 * `hasta` being exclusive is what keeps the last second of the shop's day inside and the first
 * second of the next day outside. A sale recorded at 23:58 on the 1st is `2026-10-02T02:58:00Z`
 * and passes; one at 00:04 on the 2nd is the same string plus six minutes and fails. The
 * difference between those two is 6,000,000 milliseconds of real business that a `BETWEEN` on
 * date strings throws away, and it is the reason this is a function and not an expression.
 *
 * THE OFFSET IS AN ARGUMENT, not a constant read at module load. Not for testability alone — that
 * would be a weak reason on its own — but because the one caller that has a fixed opinion about
 * the offset is a TEST asserting that a 21:00-to-midnight sale is counted today. A module that
 * read the host clock once could not be pointed at a different zone without a process restart,
 * and the claim "a sale at 23:00 local is in today's report" would be untestable on any machine
 * whose zone is not Argentina.
 */

const MS_POR_MINUTO = 60_000
const MS_POR_DIA = 86_400_000

/** `YYYY-MM-DD`, and nothing else. A date with a time in it is a different argument. */
export const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/

/**
 * A REAL calendar date, not merely a well-shaped string. `2026-02-31` matches the pattern above
 * and does not exist, and JavaScript's own parser rolls it silently over to March 3rd — so a
 * period ending "February 31" would quietly become a 35-day period. The round-trip comparison
 * below is the only way to catch it without a calendar library.
 */
export function esFechaReal(fecha) {
  if (typeof fecha !== 'string' || !RE_FECHA.test(fecha)) return false
  const [anio, mes, dia] = fecha.split('-').map(Number)
  const d = new Date(Date.UTC(anio, mes - 1, dia))
  return (
    d.getUTCFullYear() === anio && d.getUTCMonth() + 1 === mes && d.getUTCDate() === dia
  )
}

/** Assert a real `YYYY-MM-DD` or throw the caller's error code. Used at every report boundary. */
export function exigirFecha(fecha, etiqueta) {
  if (!esFechaReal(fecha)) {
    throw new IpcError(
      'REPORTE_FECHA_INVALIDA',
      400,
      `${etiqueta} no es una fecha real: ${JSON.stringify(fecha)}. Se espera AAAA-MM-DD, ` +
        'y 2026-02-31 no es una fecha.'
    )
  }
  return fecha
}

/**
 * Minutes to ADD to local time to get UTC, for the host running right now: Argentina is 180,
 * and `-getTimezoneOffset()` turns the platform's own sign convention into the one used here.
 *
 * THIS IS THE SHOP'S OWN CLOCK, which is the point. A report about a shop belongs to the shop's
 * calendar; asking a server in Virginia what "today" means for a kiosk in Córdoba is the class of
 * bug this whole file is arguing against.
 */
export function offsetMinutos(ahora = new Date()) {
  return -ahora.getTimezoneOffset()
}

/**
 * The same offset as a SQLite date modifier, for GROUPING a column by local day in SQL.
 *
 * `modificadorIso(-180)` is `'-180 minutes'`, and `date(v.fecha, '-180 minutes')` shifts the
 * stored UTC instant back to the local clock before truncating to a day. The sign is NOT
 * inverted relative to `offsetMinutos`: this is the offset from UTC to local, which is what a
 * shift needs, and the millisecond formula in `utcDesdeMedianocheLocal` below applies the same
 * number with the opposite sign because it travels the other way. Both are stated here so the
 * pair can be checked against each other.
 */
export function modificadorIso(offsetMin) {
  const signo = offsetMin < 0 ? '-' : '+'
  return `${signo}${Math.abs(offsetMin)} minutes`
}

/**
 * The UTC instant of LOCAL midnight on `fecha`, as the exact string shape the database stores.
 *
 * `Date.parse('2026-10-01T00:00:00.000Z')` is UTC midnight of that date, and local midnight is
 * that instant plus the offset, so the conversion is one subtraction of an integer count of
 * milliseconds. Integer arithmetic on purpose: the result is a timestamp a till's ledger will be
 * held to, and `new Date('2026-10-01') - 180*60000` is a different expression from
 * `new Date(2026, 9, 1) - 180*60000` in a way that only shows up in February.
 */
export function utcDesdeMedianocheLocal(fecha, offsetMin) {
  const base = Date.parse(`${exigirFecha(fecha, 'fecha')}T00:00:00.000Z`)
  if (!Number.isFinite(base)) {
    throw new IpcError('REPORTE_FECHA_INVALIDA', 400, `Fecha ilegible: ${fecha}`)
  }
  return new Date(base - offsetMin * MS_POR_MINUTO).toISOString()
}

/**
 * The half-open UTC interval that covers the local days `[fechaInicio, fechaFin]`.
 *
 * Returned strings are directly usable as SQL parameters against the `fecha`/`created_at`
 * columns, because those columns hold `strftime('%Y-%m-%dT%H:%M:%fZ','now')` and the format is
 * fixed-width and UTC-suffixed, so a lexicographic comparison IS a chronological one.
 */
export function rangoPeriodo(fechaInicio, fechaFin, offsetMin) {
  return {
    desde: utcDesdeMedianocheLocal(fechaInicio, offsetMin),
    // The day AFTER the last one, not the last one plus a day of time: `2026-02-28 + 1` is the
    // 1st of March under `sumarDias`, which is what a leap year needs and what a naive
    // `setDate(getDate() + 1)` gets right too but a millisecond addition would not.
    hasta: utcDesdeMedianocheLocal(sumarDias(fechaFin, 1), offsetMin)
  }
}

/**
 * Shift a `YYYY-MM-DD` by whole days. Built on `Date.UTC`, whose month and day rollovers are
 * correct for every month length, so `sumarDias('2026-02-28', 1)` is `2026-03-01` and
 * `sumarDias('2024-02-28', 1)` is `2024-02-29`. The result is read back off the UTC getters
 * rather than off the input string, which is what makes the rollover real instead of textual.
 */
export function sumarDias(fecha, dias) {
  exigirFecha(fecha, 'fecha')
  if (!Number.isInteger(dias)) {
    throw new IpcError('REPORTE_DIAS_INVALIDOS', 400, `Días no entero: ${dias}`)
  }
  const [anio, mes, dia] = fecha.split('-').map(Number)
  const d = new Date(Date.UTC(anio, mes - 1, dia))
  d.setUTCDate(d.getUTCDate() + dias)
  const y = String(d.getUTCFullYear()).padStart(4, '0')
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

/** How many local days `[fechaInicio, fechaFin]` covers, both ends included. Always >= 1. */
export function cantidadDias(fechaInicio, fechaFin) {
  return Math.round((Date.parse(`${fechaFin}T00:00:00.000Z`) - Date.parse(`${fechaInicio}T00:00:00.000Z`)) / MS_POR_DIA) + 1
}

/** Every local day in the range, in order. A period with no sales still has its days. */
export function enumerarDias(fechaInicio, fechaFin) {
  const total = cantidadDias(fechaInicio, fechaFin)
  const dias = new Array(total)
  for (let i = 0; i < total; i += 1) dias[i] = sumarDias(fechaInicio, i)
  return dias
}

/**
 * The period immediately BEFORE this one, of the same number of calendar days, ending the day
 * before `fechaInicio` starts. The comparison every "versus the previous period" figure needs.
 *
 * Two arithmetic mistakes live here and both are guarded. The window must be the same LENGTH as
 * the current one, so it shifts by `cantidadDias` and not by `diffDays` — the web subtracts
 * `diffDays + 1`, which is right, and gets it wrong the moment a caller reuses the number. And it
 * must not overlap: `finAnterior` is `fechaInicio - 1 day`, exclusive of the current period, so a
 * sale cannot be counted in both halves of a comparison and every percentage below has a single
 * well-defined numerator and denominator.
 */
export function periodoAnterior(fechaInicio, fechaFin) {
  const dias = cantidadDias(fechaInicio, fechaFin)
  return {
    fechaInicio: sumarDias(fechaInicio, -dias),
    fechaFin: sumarDias(fechaInicio, -1)
  }
}

/**
 * The local `YYYY-MM-DD` an instant belongs to, in JavaScript.
 *
 * Used for bucketing a query result whose SQL could not group by local day, and by the tests that
 * assert the SQL does.
 *
 * THE SIGN IS ADDED, and it is worth spelling out because this file contains a subtraction two
 * functions above and they are NOT interchangeable. JavaScript defines
 * `getTimezoneOffset()` as "UTC minus local", so `local = UTC - getTimezoneOffset()`, and
 * `offsetMin` is that value NEGATED. Which leaves:
 *
 *     local wall clock = instant + offsetMin      (this function — travelling UTC to the shop)
 *     UTC instant      = wall clock - offsetMin   (`utcDesdeMedianocheLocal` — the other way)
 *
 * One sign flip between two functions that answer the same question from opposite ends is a bug
 * that reads like a feature: every window the reports query is still correct, because
 * `rangoPeriodo` gets this one right, so only the per-day bucketing of an already-narrowed result
 * is wrong. `tests/reportes/fechas.spec.js` pins both directions against each other for that
 * reason, and it is why this comment exists at all.
 */
export function diaLocalDe(isoUtc, offsetMin) {
  if (typeof isoUtc !== 'string' || !Number.isFinite(Date.parse(isoUtc))) {
    throw new IpcError('REPORTE_INSTANTE_INVALIDO', 400, `Instante ilegible: ${isoUtc}`)
  }
  return new Date(Date.parse(isoUtc) + offsetMin * MS_POR_MINUTO).toISOString().slice(0, 10)
}

/**
 * The day the report's default window should end on, and the one before it, in LOCAL time.
 *
 * A report opened at 21:47 in Córdoba is asking about a day that is not over yet, and the window
 * it opens on is the local date — which `Date.prototype.toISOString()` cannot supply, because that
 * method is defined to return UTC and would hand back yesterday's date for the first three hours
 * of every local morning. The arithmetic is spelled out instead of delegated.
 */
export function hoyLocal(ahora = new Date(), offsetMin = offsetMinutos(ahora)) {
  const localMs = ahora.getTime() + offsetMin * MS_POR_MINUTO
  return new Date(localMs).toISOString().slice(0, 10)
}
