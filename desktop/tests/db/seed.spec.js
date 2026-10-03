import { describe, it, expect, afterEach } from 'vitest'
import { seed } from '../../src/main/db/seed.js'
import { resolveLocalIdentity, identityWarning } from '../../src/main/db/identity.js'
import { negocioUnico } from '../../src/main/auth/identities.repo.js'
import { tienda, tiendaVacia } from './fixtures/tienda.js'

/**
 * THE SEED, ON A FILE THAT HAS ALREADY BEEN SEEDED.
 *
 * WHY THIS FILE IS ONE TEST. `seed()` is the only writer of a business and a user on a fresh
 * profile, so the question it has to answer correctly is not "can it create a shop" — the other
 * 539 tests and four real-app drives cover that — but "does it know when it must NOT create
 * one". That question has a single answer, and getting it wrong is not a crash.
 *
 * WHAT IT GOT WRONG, AND WHY 539 TESTS MISSED IT. The check was
 * `SELECT id FROM negocios WHERE nombre = 'Mi Negocio'` — the seed's own placeholder NAME. The
 * owner names their shop at the sign-in panel, which renames that row, so the row the seed looks
 * for by name is gone. The next launch read "not seeded" and INSERTED a second business called
 * `Mi Negocio`. Then `resolveLocalIdentity` found two active businesses and, correctly, refused
 * to choose: a shop file is one shop. Every business operation from then on answered
 * `TENANT_REQUIRED`. The till was bricked, with no message pointing at the cause and no way out
 * but deleting the customer's file.
 *
 * It shipped because every other test opens a FRESH database. None of them ever renamed a
 * business and then bootstrapped again. The handover drive found it, and only because its second
 * phase RELAUNCHES the app on the same file — a comment asserting that seeding is idempotent is
 * not the same as opening the shop twice.
 *
 * So the regression is written the way the bug happened: seed, rename, seed again.
 */

const stores = []
afterEach(() => {
  while (stores.length > 0) stores.pop().cerrar()
})

/** Every business still in the file, in the order the app would read them. */
function negocios(conn) {
  return conn.db
    .prepare(`SELECT id, nombre FROM negocios WHERE deleted_at IS NULL ORDER BY id`)
    .all()
}

describe('REGRESSION: a RENAMED shop is not seeded a second time', () => {
  it('seeding again after the owner names their shop writes nothing', () => {
    const t = tienda()
    stores.push(t)

    // Exactly what the sign-in panel does: the seeded placeholder gives way to the real name.
    t.conn.db
      .prepare(`UPDATE negocios SET nombre = ?, updated_at = ? WHERE id = ?`)
      .run('Tienda del Recorrido', new Date().toISOString(), t.negocioId)

    const segunda = seed(t.conn)

    expect(segunda.seeded).toBe(false)
    expect(segunda.reason).toBe('already_seeded')
    expect(negocios(t.conn)).toHaveLength(1)
    expect(negocios(t.conn)[0].nombre).toBe('Tienda del Recorrido')
    // The name the owner chose is data, not a default: re-seeding must not put it back either.
    expect(negocios(t.conn)[0].id).toBe(t.negocioId)
  })

  it('and the app can still tell which shop the file is, with nobody signed in', () => {
    // The consequence above, asserted directly. Two businesses do not crash the app and do not
    // corrupt a sale — they make EVERY operation answer TENANT_REQUIRED, which is why this is
    // worth its own test instead of living inside the count above.
    const t = tienda()
    stores.push(t)
    t.conn.db
      .prepare(`UPDATE negocios SET nombre = ?, updated_at = ? WHERE id = ?`)
      .run('Tienda del Recorrido', new Date().toISOString(), t.negocioId)

    seed(t.conn)

    const identity = resolveLocalIdentity(t.conn)
    expect(identity.motivo).toBeNull()
    expect(identity.negocioId).toBe(t.negocioId)
    expect(identity.negocioNombre).toBe('Tienda del Recorrido')
    expect(identityWarning(identity)).toBeNull()

    // `negocioUnico` is the other half of the same question, and it is the half the sign-in panel
    // asks. Both of these were asserted because a re-broken `seed()` makes BOTH fail — verified by
    // putting the two name-based lookups back and watching this file go red — and because the two
    // answers are what the app prints: `identity.js` says "the file has more than one business"
    // and `negocioUnico` says `multiple`, which is what turns every repository into a
    // TENANT_REQUIRED.
    const unico = negocioUnico(t.conn)
    expect(unico?.multiple).toBeFalsy()
    expect(unico?.id).toBe(t.negocioId)
  })
})

describe('the seed still seeds a file that has no shop', () => {
  it('creates the business and the admin on an empty-but-migrated file', () => {
    // The other half, so the fix cannot be "never seed anything": a fresh install still has to
    // come up with a shop and somebody who can open it.
    //
    // This used to ask the question of a SEEDED shop with `DELETE FROM negocios` and
    // `DELETE FROM users` laid on top. That was never the same thing — the seed's identity row,
    // its catalogue and everything it had touched were all still there — and since
    // 003_ultimo_admin.sql it is also IMPOSSIBLE, because the engine now refuses to delete the
    // only owner. A test that needs a shop with nobody in it can no longer be written by emptying
    // one, and that is the correct state of affairs: the answer to "how do I get an empty shop?"
    // is a profile directory that has never been opened, which is what `tiendaVacia()` is.
    const t = tiendaVacia()
    stores.push(t)

    expect(negocios(t.conn)).toHaveLength(0)
    expect(t.conn.db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n).toBe(0)

    const primera = seed(t.conn)

    expect(primera.seeded).toBe(true)
    expect(primera.reason).toBe('seeded')
    expect(negocios(t.conn)).toHaveLength(1)
    expect(negocios(t.conn)[0].nombre).toBe('Mi Negocio')
    expect(t.conn.db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n).toBe(1)
    // And the shop it just made is openable: an admin, active, in that business.
    expect(
      t.conn.db
        .prepare(`SELECT rol, activo FROM users WHERE negocio_id = ?`)
        .get(negocios(t.conn)[0].id)
    ).toEqual({ rol: 'admin', activo: 1 })
  })
})
