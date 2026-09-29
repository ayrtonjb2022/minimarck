import { describe, it, expect, afterEach } from 'vitest'
import { identityWarning, resolveLocalIdentity } from '../../src/main/db/identity.js'
import { openDatabase } from '../../src/main/db/connection.js'
import { tienda } from './fixtures/tienda.js'

/**
 * The local identity (design #275: no login, no session, no token), on REAL sqlite.
 *
 * WHY THIS MODULE EXISTS AND WHY IT REFUSES. `installIpc` builds every request context and every
 * repository calls `requireTenant` on the way in, so the answer to "which shop is this file?"
 * decides whether the app can do business at all. Getting it wrong is not a crash: it is a sale
 * written to the wrong `negocio_id`, which has to be found and fixed by hand later. That is why
 * every ambiguous case here is a REFUSAL that becomes the existing `TENANT_REQUIRED`, and why the
 * tests below assert the refusal as carefully as they assert the success.
 *
 * The two properties worth stating out loud:
 *   - It never guesses. Two businesses, two admins, no operator, no schema, an inactive
 *     business: each is reported by name and the identity stays null.
 *   - It reads. There is no INSERT, UPDATE or DELETE in the module, so resolving an identity can
 *     never be the thing that changed the file.
 */

const stores = []
afterEach(() => {
  while (stores.length > 0) stores.pop().cerrar()
})

function abrirTienda() {
  const t = tienda()
  stores.push(t)
  return t
}

/** The null identity shape, asserted term by term so a partial identity cannot pass as one. */
function esperarNinguno(identity, motivo) {
  expect(identity.negocioId).toBeNull()
  expect(identity.actorId).toBeNull()
  expect(identity.motivo).toBe(motivo)
}

describe('resolveLocalIdentity — the business and the operator', () => {
  it('resolves the seeded business and its admin', () => {
    const t = abrirTienda()
    const id = resolveLocalIdentity(t.conn)

    expect(id.motivo).toBeNull()
    expect(id.negocioId).toBe(t.negocioId)
    expect(id.actorId).toBe(t.usuarioId)
    expect(id.negocioNombre).toBe('Mi Negocio')
    expect(id.operadorNombre).toBe('Administrador')
    expect(id.rol).toBe('admin')
  })

  it('reports schema_absent when the connection has no schema at all', () => {
    // A REAL connection, just an empty one: `node:sqlite` opens `:memory:` with nothing in it.
    // Not a mock, and not a stub — the exact shape `bootstrapDatabase` produces on a fresh
    // profile with no migration bundled, which is the failure that shipped an unopenable app.
    const conn = openDatabase(':memory:')
    try {
      esperarNinguno(resolveLocalIdentity(conn), 'schema_absent')
    } finally {
      conn.db.close()
    }
  })

  it('reports sin_negocio when the only business is deactivated', () => {
    const t = abrirTienda()
    t.conn.db.prepare('UPDATE negocios SET activo = 0 WHERE id = ?').run(t.negocioId)
    esperarNinguno(resolveLocalIdentity(t.conn), 'sin_negocio')
  })

  it('reports negocios_multiples instead of picking one of two active businesses', () => {
    const t = abrirTienda()
    const ts = '2026-01-01T00:00:00.000Z'
    t.conn.db
      .prepare(
        `INSERT INTO negocios (nombre, ruc, tipo_comercio, configuracion, activo, created_at, updated_at)
         VALUES ('Otra Tienda', NULL, 'otro', '{}', 1, ?, ?)`
      )
      .run(ts, ts)

    // The important half: `negocioId` is null. "Lowest id wins" would be a coin flip, and the
    // losing coin writes a sale into the other shop's books.
    esperarNinguno(resolveLocalIdentity(t.conn), 'negocios_multiples')
  })

  it('ignores a soft-deleted business rather than counting it as a second one', () => {
    const t = abrirTienda()
    const ts = '2026-01-01T00:00:00.000Z'
    t.conn.db
      .prepare(
        `INSERT INTO negocios (nombre, ruc, tipo_comercio, configuracion, activo, deleted_at, created_at, updated_at)
         VALUES ('Tienda Borrada', NULL, 'otro', '{}', 1, ?, ?, ?)`
      )
      .run(ts, ts, ts)

    const id = resolveLocalIdentity(t.conn)
    expect(id.motivo).toBeNull()
    expect(id.negocioId).toBe(t.negocioId)
  })

  it('reports sin_operador when the business has no active user', () => {
    const t = abrirTienda()
    t.conn.db.prepare('UPDATE users SET activo = 0 WHERE negocio_id = ?').run(t.negocioId)
    esperarNinguno(resolveLocalIdentity(t.conn), 'sin_operador')
  })

  it('reports operadores_multiples when two admins are active', () => {
    const t = abrirTienda()
    const ts = '2026-01-01T00:00:00.000Z'
    t.conn.db
      .prepare(
        `INSERT INTO users (nombre, email, rol, activo, negocio_id, created_at, updated_at)
         VALUES ('Segundo Admin', 'otro@minimarck.local', 'admin', 1, ?, ?, ?)`
      )
      .run(t.negocioId, ts, ts)

    // Two admins is genuinely ambiguous about WHO is on duty, and stamping the wrong user on
    // every audit row is worse than saying "there is no operator yet".
    esperarNinguno(resolveLocalIdentity(t.conn), 'operadores_multiples')
  })

  it('prefers the single admin when other operators also exist', () => {
    const t = abrirTienda()
    const ts = '2026-01-01T00:00:00.000Z'
    t.conn.db
      .prepare(
        `INSERT INTO users (nombre, email, rol, activo, negocio_id, created_at, updated_at)
         VALUES ('Vendedor', 'vendedor@minimarck.local', 'vendedor', 1, ?, ?, ?)`
      )
      .run(t.negocioId, ts, ts)

    // Deterministic and sensible: a shop with one manager and three cashiers has a known
    // operator. This is the case the refusal rules must NOT swallow.
    const id = resolveLocalIdentity(t.conn)
    expect(id.motivo).toBeNull()
    expect(id.operadorNombre).toBe('Administrador')
    expect(id.rol).toBe('admin')
  })

  it('is read-only: it does not write to the database', () => {
    const t = abrirTienda()
    const antes = t.conn.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM negocios) AS n, (SELECT COUNT(*) FROM users) AS u,
                (SELECT COUNT(*) FROM auditoria) AS a`
      )
      .get()
    resolveLocalIdentity(t.conn)
    resolveLocalIdentity(t.conn)
    const despues = t.conn.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM negocios) AS n, (SELECT COUNT(*) FROM users) AS u,
                (SELECT COUNT(*) FROM auditoria) AS a`
      )
      .get()
    expect(despues).toEqual(antes)
  })
})

describe('identityWarning — one sentence an operator can act on', () => {
  it('says nothing when the identity resolved', () => {
    expect(identityWarning(resolveLocalIdentity(abrirTienda().conn))).toBeNull()
  })

  it('names a different cause for each refusal', () => {
    const motivos = ['schema_absent', 'sin_negocio', 'negocios_multiples', 'sin_operador', 'operadores_multiples']
    const avisos = motivos.map((motivo) => identityWarning({ negocioId: null, motivo }))

    for (const aviso of avisos) {
      expect(typeof aviso).toBe('string')
      expect(aviso.length).toBeGreaterThan(20)
    }
    // Different problems get different sentences: an operator who reads the same line for a
    // missing schema and for two businesses learns nothing from either.
    expect(new Set(avisos).size).toBe(motivos.length)
    // The one that points at a plugged hole points at the command that checks it.
    expect(avisos[0]).toContain('verify:migrations')
  })

  it('explains where TENANT_REQUIRED comes from when nothing resolved', () => {
    // The word the operator will actually see, in the message that explains where it comes from.
    expect(identityWarning({ negocioId: null, motivo: 'sin_negocio' })).toContain('TENANT_REQUIRED')
  })
})
