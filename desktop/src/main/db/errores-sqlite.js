/**
 * ONE PLACE THAT KNOWS WHAT A SQLITE UNIQUE VIOLATION LOOKS LIKE.
 *
 * WHY THIS FILE EXISTS. Four repositories needed "was this a UNIQUE violation on THESE columns?",
 * and each one grew its own copy of the answer by hand. Three of the four copies happened to be
 * right. The fourth — the category guard in `productos.repo.js` — matched on the INDEX NAME
 * (`ux_categorias_nombre_negocio`) and on the bare `SQLITE_CONSTRAINT_UNIQUE` code alone, and
 * therefore matched nothing at all on the driver this project actually runs. Its test still
 * passed, because a pre-check `SELECT` catches the duplicate before the `INSERT` ever throws; the
 * guard is only reachable in a race, and there was no test in a race.
 *
 * That is the whole argument for this file. A predicate that exists in four places is a predicate
 * that will be right in three of them.
 */

/** SQLite's extended code for `SQLITE_CONSTRAINT_UNIQUE`. */
const SQLITE_CONSTRAINT_UNIQUE = 'SQLITE_CONSTRAINT_UNIQUE'

/** The same violation, as a number: `node:sqlite` puts the real code in `errcode`. */
const SQLITE_CONSTRAINT_UNIQUE_NUM = 2067

/**
 * Is this error a UNIQUE constraint violation, in ANY of the shapes a driver has shipped one?
 *
 * There are three, and which one you get depends on the driver and its version — not on your
 * code. `better-sqlite3` throws the bare extended code. `node:sqlite` (what this port runs on)
 * throws `ERR_SQLITE_ERROR` and puts `2067` in `errcode`, the same way Node's URI errors wrap
 * their cause.
 *
 * `ERR_SQLITE_ERROR` IS NOT A UNIQUE VIOLATION. It is the wrapper for EVERY SQLite error, so
 * accepting that code on its own makes this function answer `true` for a NOT NULL violation, a
 * FOREIGN KEY violation, a CHECK violation and a syntax error alike — and a guard that eager
 * answers "that barcode is already taken" for what is actually a disk error. The first version of
 * this function did exactly that, and the test that exists here found it on its first run. So the
 * wrapped shape REQUIRES the real code, and the only shape that falls back to the message is the
 * one where there is no `errcode` at all.
 *
 * That last fallback reads SQLite's constraint PREFIX — "UNIQUE constraint failed" — which is what
 * tells the four constraint kinds apart and is as stable as the code itself. This is NOT the same
 * as the index-name match that was the original bug: that grepped for a string SQLite never emits
 * and therefore matched nothing, whereas this reads a documented message format and is only
 * reached when there is no code to read.
 */
export function esViolacionUnica(err) {
  if (err == null) return false
  if (err.code === SQLITE_CONSTRAINT_UNIQUE) return true
  if (err.errcode === SQLITE_CONSTRAINT_UNIQUE_NUM) return true
  if (err.code === 'ERR_SQLITE_ERROR') return /^UNIQUE constraint failed/.test(String(err?.message ?? ''))
  return false
}

/**
 * Was this UNIQUE violation caused by THIS index, identified by the columns it covers?
 *
 * READ THE SECOND ARGUMENT CAREFULLY: SQLite reports the COLUMNS, never the index name. The
 * message is
 *
 *     UNIQUE constraint failed: clientes_deudores.documento, clientes_deudores.negocio_id
 *
 * and the string `ux_clientes_deudores_documento` appears NOWHERE in it. So `columnas` must be
 * fully-qualified column names (`tabla.columna`), and you must list the ones that make the index
 * UNIQUE TOGETHER — the fingerprint is the set.
 *
 * If a table has two different UNIQUE indexes over different columns, naming the pair rather
 * than either column alone is what keeps them apart. Naming one column is a bug waiting for the
 * second index to exist.
 */
export function esViolacionUnicaEn(err, ...columnas) {
  if (!esViolacionUnica(err)) return false
  const msg = String(err?.message ?? '')
  return columnas.every((columna) => msg.includes(columna))
}
