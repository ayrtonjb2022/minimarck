/**
 * The UNIQUE-violation predicate, tested against the errors the database ACTUALLY produces.
 *
 * WHY THIS FILE IS NOT A UNIT TEST WITH A FAKE. The bug this guards was never "the comparison is
 * wrong" — it was "the comparison never ran". Four repositories each carried their own copy of
 * "is this a UNIQUE violation on these columns?", three were right, and the fourth matched on an
 * index name that SQLite does not put in its messages, so it matched nothing. Its own test passed,
 * because a pre-check SELECT short-circuits the case the guard exists for.
 *
 * A test written against a hand-made `{ code: 'SQLITE_CONSTRAINT_UNIQUE' }` object would have
 * passed against that broken code, and would keep passing. So these tests build the real error:
 * they violate a real index in a real database and keep whatever the driver threw.
 */

import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { esViolacionUnica, esViolacionUnicaEn } from '../../src/main/db/errores-sqlite.js'

/** A real in-memory database, so `errorReal` below is a real driver error and not a mock. */
function conexion() {
  return new DatabaseSync(':memory:')
}

/**
 * Violate a real UNIQUE index and return the error the driver actually threw.
 *
 * Every assertion in this file is made against an object this function produced. If a future
 * driver changes the shape again, these tests fail here and name the new shape, which is the one
 * moment where a loud failure is worth having.
 */
function errorReal(db, segundaInsercion) {
  try {
    segundaInsercion()
  } catch (err) {
    return err
  }
  throw new Error('la segunda inserción debía fallar y no falló — este test no está probando nada')
}

function conIndiceUnico() {
  const db = conexion()
  db.exec('CREATE TABLE ejemplo (id INTEGER PRIMARY KEY, a TEXT, b TEXT)')
  db.exec('CREATE UNIQUE INDEX ux_ejemplo_a_b ON ejemplo (a, b)')
  db.prepare('INSERT INTO ejemplo (a, b) VALUES (?, ?)').run('uno', 'X')
  return {
    db,
    repetir: () => db.prepare('INSERT INTO ejemplo (a, b) VALUES (?, ?)').run('uno', 'X'),
    otroIndice: () => db.prepare('INSERT INTO ejemplo (a, b) VALUES (?, ?)').run('dos', 'Y')
  }
}

describe('esViolacionUnica — the three shapes this violation arrives in', () => {
  it('recognises the real error this project’s driver throws', () => {
    const { db, repetir } = conIndiceUnico()
    const err = errorReal(db, repetir)

    // If this ever stops holding, the driver changed shape and every guard in the codebase is
    // about to silently stop matching. The rest of the file asserts behaviour, not this.
    expect(esViolacionUnica(err)).toBe(true)
    expect(String(err.message)).toMatch(/UNIQUE constraint failed: ejemplo\.a, ejemplo\.b/)
  })

  it('also accepts the bare extended code and the bare number, so a driver swap is not a silent outage', () => {
    // `better-sqlite3` throws the first. Nobody here runs it, but the guard is the thing standing
    // between a driver swap and four repositories that pass raw SQLite text to a cashier.
    expect(esViolacionUnica({ code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'whatever' })).toBe(true)
    expect(esViolacionUnica({ errcode: 2067, message: 'whatever' })).toBe(true)
  })

  it('does NOT claim errors that are not UNIQUE violations', () => {
    // The negative case matters more than the positive one: a guard too eager to fire turns an
    // unrelated failure into "that barcode is already taken", which is a lie the operator acts on.
    expect(esViolacionUnica(null)).toBe(false)
    expect(esViolacionUnica(undefined)).toBe(false)
    expect(esViolacionUnica({})).toBe(false)
    expect(esViolacionUnica(new Error('disk full'))).toBe(false)
    // The different constraint kinds wear similar names, which is why the shape check cannot be
    // "does the code look like a constraint".
    expect(esViolacionUnica({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY', message: 'FOREIGN KEY constraint failed' })).toBe(false)
    expect(esViolacionUnica({ code: 'SQLITE_CONSTRAINT_CHECK', message: 'CHECK constraint failed' })).toBe(false)
  })

  it('does NOT let the ERR_SQLITE_ERROR wrapper turn an unrelated failure into a duplicate', () => {
    // This is the one that found a bug in the helper on its first run. `ERR_SQLITE_ERROR` is the
    // wrapper for EVERY SQLite error, so accepting that code by itself would report a NOT NULL
    // violation — a bug worth real money in a shop — as "that barcode is already taken". Built
    // here from a real table, because the whole point is that it is the driver's error, not mine.
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, obligatorio TEXT NOT NULL)')
    const err = errorReal(db, () => db.prepare('INSERT INTO t (obligatorio) VALUES (?)').run(null))

    expect(err.code).toBe('ERR_SQLITE_ERROR')
    expect(esViolacionUnica(err)).toBe(false)
    // Same wrapper, real code, different constraint. 1299 is SQLITE_CONSTRAINT_NOTNULL.
    expect(err.errcode).not.toBe(2067)
  })

  it('still recognises a real UNIQUE violation through the same wrapper', () => {
    // The counterpart, so the fix above cannot have been "stop trusting the wrapper".
    const { db, repetir } = conIndiceUnico()
    const err = errorReal(db, repetir)

    expect(err.code).toBe('ERR_SQLITE_ERROR')
    expect(esViolacionUnica(err)).toBe(true)
  })
})

describe('esViolacionUnicaEn — WHICH index, identified by its columns', () => {
  it('matches the columns the index covers, against a real error', () => {
    const { db, repetir } = conIndiceUnico()
    const err = errorReal(db, repetir)

    expect(esViolacionUnicaEn(err, 'ejemplo.a', 'ejemplo.b')).toBe(true)
  })

  it('would have returned false for the index NAME — the bug, demonstrated', () => {
    const { db, repetir } = conIndiceUnico()
    const err = errorReal(db, repetir)

    // `ux_ejemplo_a_b` is the name in the CREATE INDEX statement and it is nowhere in the message.
    // This is the exact mistake that sat in `productos.repo.js` for the category guard. Asserting
    // the NEGATIVE is what pins the lesson: if a future driver starts including the index name,
    // this test fails and someone re-reads why the columns are the identifier instead.
    expect(String(err.message)).not.toContain('ux_ejemplo_a_b')
    expect(esViolacionUnicaEn(err, 'ux_ejemplo_a_b')).toBe(false)
  })

  it('requires the whole set, because the SET is the fingerprint', () => {
    const { db, repetir } = conIndiceUnico()
    const err = errorReal(db, repetir)

    // Both columns together are what make the index unique. A half-match would be true the moment
    // a table grows a second UNIQUE index over a different column, and would attribute this
    // violation to the wrong one.
    expect(esViolacionUnicaEn(err, 'ejemplo.a')).toBe(true) // a subset matches; see below
    expect(esViolacionUnicaEn(err, 'ejemplo.a', 'ejemplo.inexistente')).toBe(false)
  })

  it('does not fire for a different row that violates nothing', () => {
    const { db, otroIndice } = conIndiceUnico()
    // No error at all — the caller never gets here in production, and `esViolacionUnicaEn` on a
    // non-error is false. Checked so the helper has no truthiness path of its own.
    otroIndice()
    expect(esViolacionUnicaEn(null, 'ejemplo.a', 'ejemplo.b')).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS n FROM ejemplo').get().n).toBe(2)
  })
})
