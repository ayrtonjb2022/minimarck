/**
 * LOCAL SIGN-IN, EMPLOYEES, HANDOVER — the tests for the thing this feature actually claims.
 *
 * WHAT IS ASSERTED HERE, AND WHY EACH ONE IS NOT OBVIOUS:
 *
 *   - A password is never stored. Not "is hashed" — the DATABASE FILE is grepped for the literal
 *     password. A test that only asserted `secret !== password` would still pass if the plaintext
 *     were being written to a second column, and this is the one claim nobody gets to eyeball in
 *     production.
 *   - scrypt with per-identity salt: two people who choose the SAME password get different
 *     secrets. Without a per-row salt this whole feature is a shared-password database.
 *   - A wrong password and an unknown name are indistinguishable. Same code, same status, same
 *     message — otherwise the sign-in panel becomes an oracle for which names exist.
 *   - Changing a password retires the old credential and KEEPS THE HANDLE. That is the case a
 *     plain UNIQUE index makes impossible, and it was a real crash before it was a test.
 *   - A HANDOVER is a login. The incoming person's password is verified; the outgoing one is not
 *     needed; and the sale that lands afterwards is stamped with the INCOMING id.
 *   - A session does not survive a restart, and `me` is `null` until somebody signs in.
 *   - A renderer payload cannot choose who the shop thinks you are.
 *   - An existing shop adopts its own admin instead of growing a second owner next to the name
 *     already stamped on every one of its sales.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRegistry } from '../../src/main/bridge/registry.js'
import { registerAuthHandlers } from '../../src/main/ipc/auth.js'
import { registerVentasHandlers } from '../../src/main/ipc/ventas.js'
import { registerCajasHandlers } from '../../src/main/ipc/cajas.js'
import { construirContexto, contextoDesdeEnvelope } from '../../src/main/ipc/contexto.js'
import { createSession } from '../../src/main/auth/session.js'
import { derivar, verificar, PARAMETROS_ACTUALES } from '../../src/main/auth/passwords.js'
import { tienda, ctxDe, iniciarSesion, insertarProducto, abrirCaja } from '../db/fixtures/tienda.js'

const PASSWORD = 'clave-de-prueba'

/** A shop with a registry, and helpers that report a refusal as data instead of a thrown error. */
function escenario({ signedIn = false, nombre = 'dueño' } = {}) {
  const t = tienda()
  const registry = createRegistry()
  const session = createSession(t.conn)
  if (signedIn) {
    const r = createRegistry()
    registerAuthHandlers(r, { conn: t.conn, session })
    r.resolve('auth', 'register')({ nombre: 'Dueño', negocioNombre: 'Tienda', nombreAcceso: nombre, password: PASSWORD }, ctxDe(t, t.negocioId, t.usuarioId))
  }
  registerAuthHandlers(registry, { conn: t.conn, session })
  registerVentasHandlers(registry, { conn: t.conn })
  registerCajasHandlers(registry, { conn: t.conn })

  const call = async (group, op, payload = {}) => {
    try {
      // The actor comes from the session and from NOWHERE ELSE. This line had a
      // `?? t.usuarioId` fallback in it, "so the repository tests keep working" — and that
      // fallback meant a sale created after `auth.logout` was still stamped on somebody, which
      // made the "nobody is signed in" test pass for the wrong reason while the assertion it
      // should have caught went green. A harness that supplies an operator when the app has none
      // cannot be used to prove the app refuses an absent operator. There is no fallback here.
      return await registry.resolve(group, op)(payload, ctxDe(t, t.negocioId, session.actorId()))
    } catch (err) {
      return { __error: { code: err.code, status: err.status, message: err.message } }
    }
  }
  return { t, registry, session, call, nombre }
}

const ok = (r) => {
  expect(r?.__error).toBeUndefined()
  return r
}
const falla = (r) => {
  expect(r.__error).toBeDefined()
  return r.__error
}

describe('auth: the password itself', () => {
  it('is scrypt, with a fresh salt per identity and the parameters recorded beside the key', () => {
    const a = derivar('misma-clave-123')
    const b = derivar('misma-clave-123')
    expect(a.algoritmo).toBe('scrypt')
    // Different rows, same password, different keys — a shared salt would make these equal.
    expect(a.salt).not.toBe(b.salt)
    expect(a.secret).not.toBe(b.secret)
    expect(a.secret.length).toBe(PARAMETROS_ACTUALES.keylen * 2)
    expect(a.salt.length).toBe(16 * 2)
    // The parameters travel WITH the hash, so a future cost policy can still verify this row.
    expect(JSON.parse(a.parametros)).toEqual({ ...PARAMETROS_ACTUALES })
    expect(verificar('misma-clave-123', a)).toBe(true)
    expect(verificar('misma-clave-124', a)).toBe(false)
  })

  it('never reaches the database file, not even next to its own hash', () => {
    const { t } = escenario()
    const session = createSession(t.conn)
    const r = createRegistry()
    registerAuthHandlers(r, { conn: t.conn, session })
    const ctx = ctxDe(t, t.negocioId, t.usuarioId)
    ok(r.resolve('auth', 'register')({ nombre: 'Dueño', negocioNombre: 'Tienda', nombreAcceso: 'dueño', password: PASSWORD }, ctx))
    // Fold the WAL back into the main file first: the password is not in the committed database
    // until the frames are folded, and asserting on a file that has not been checkpointed would
    // pass for the wrong reason.
    t.conn.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    // Read the FILE, not the row. A plaintext copy in an audit column or a log table would pass
    // every assertion made through SQL and fail this one.
    const archivo = readFileSync(t.archivo, 'latin1')
    expect(archivo).not.toContain(PASSWORD)
    expect(archivo).toContain('scrypt')
  })
})

describe('auth: signing in', () => {
  let e
  beforeEach(() => { e = escenario() })
  afterEach(() => e.t.cerrar())

  it('a right name and right password open a session for that person', async () => {
    ok(await e.call('auth', 'register', { nombre: 'Dueño', negocioNombre: 'Tienda', nombreAcceso: 'dueño', password: PASSWORD }))
    const sesion = ok(await e.call('auth', 'login', { nombre: 'dueño', password: PASSWORD }))
    expect(sesion).toMatchObject({ id: e.t.usuarioId, rol: 'admin' })
  })

  it('the name is folded, so case cannot decide who gets in', async () => {
    ok(await e.call('auth', 'register', { nombre: 'Dueño', negocioNombre: 'Tienda', nombreAcceso: 'Dueño', password: PASSWORD }))
    ok(await e.call('auth', 'login', { nombre: '  DUEÑO  ', password: PASSWORD }))
  })

  it('a wrong password and an unknown name are the same refusal, word for word', async () => {
    ok(await e.call('auth', 'register', { nombre: 'Dueño', negocioNombre: 'Tienda', nombreAcceso: 'dueño', password: PASSWORD }))
    const malaClave = falla(await e.call('auth', 'login', { nombre: 'dueño', password: 'no-es-la-clave' }))
    const nombreFantasma = falla(await e.call('auth', 'login', { nombre: 'nadie', password: PASSWORD }))
    // If these two ever differ, the sign-in panel is an oracle for which accounts exist.
    expect(malaClave).toEqual(nombreFantasma)
    expect(malaClave.code).toBe('CREDENCIALES_INVALIDAS')
  })

  it('an empty password is refused rather than treated as the empty string that hashes', async () => {
    ok(await e.call('auth', 'register', { nombre: 'Dueño', negocioNombre: 'Tienda', nombreAcceso: 'dueño', password: PASSWORD }))
    expect(falla(await e.call('auth', 'login', { nombre: 'dueño', password: '' })).code).toBe('CREDENCIALES_INVALIDAS')
  })
})

describe('auth: the first launch', () => {
  let e
  beforeEach(() => { e = escenario() })
  afterEach(() => e.t.cerrar())

  it('adopts the seeded admin instead of inventing a second owner, and rewrites no row id', async () => {
    const antes = e.t.conn.db.prepare('SELECT id FROM users').all()
    const res = ok(await e.call('auth', 'register', { nombre: 'María Gómez', negocioNombre: 'Tienda', nombreAcceso: 'maria', password: PASSWORD }))
    const despues = e.t.conn.db.prepare('SELECT id, nombre FROM users').all()
    // Same id, same count. The audit trail on every existing sale still points at this person.
    expect(despues).toHaveLength(antes.length)
    expect(despues[0].id).toBe(antes[0].id)
    expect(res.adoptoNegocioExistente).toBe(true)
    expect(despues[0].nombre).toBe('María Gómez')
    // And the placeholder business name gives way to the name the owner just typed.
    expect(res.negocioNombre).toBe('Tienda')
  })

  it('refuses a second owner once a credential exists, even from a fresh process', async () => {
    ok(await e.call('auth', 'register', { nombre: 'Dueño', negocioNombre: 'Tienda', nombreAcceso: 'dueño', password: PASSWORD }))
    // A NEW session object is what a restart looks like. Without this the assertion would pass
    // only because the first register left a session open — which is the wrong reason.
    const r2 = createRegistry()
    registerAuthHandlers(r2, { conn: e.t.conn, session: createSession(e.t.conn) })
    // The handler THROWS rather than rejecting, so this is a try/catch and not `.catch()`: the
    // distinction matters, because an assertion written against a promise would silently pass on
    // the synchronous throw path.
    let intruso = null
    try {
      r2.resolve('auth', 'register')({ nombre: 'Intruso', negocioNombre: 'Otro', nombreAcceso: 'otro', password: PASSWORD }, ctxDe(e.t, e.t.negocioId, null))
    } catch (err) {
      intruso = err
    }
    expect(intruso?.code).toBe('YA_CONFIGURADO')
    expect(e.t.conn.db.prepare('SELECT COUNT(*) AS n FROM users').get().n).toBe(1)
  })

  it('answers `me` with null when nobody is signed in — a state, not an error', async () => {
    expect(await e.call('auth', 'me')).toBeNull()
  })

  it('rejects a short password before it is ever hashed', async () => {
    const err = falla(await e.call('auth', 'register', { nombre: 'Dueño', negocioNombre: 'Tienda', nombreAcceso: 'dueño', password: 'corta' }))
    expect(err.code).toBe('CONTRASENA_CORTA')
    expect(e.t.conn.db.prepare('SELECT COUNT(*) AS n FROM user_identidades').get().n).toBe(0)
  })
})

describe('auth: the session', () => {
  let e
  beforeEach(() => { e = escenario() })
  afterEach(() => e.t.cerrar())

  it('does not survive a restart, and logout ends it before that', async () => {
    ok(await e.call('auth', 'register', { nombre: 'Dueño', negocioNombre: 'Tienda', nombreAcceso: 'dueño', password: PASSWORD }))
    ok(await e.call('auth', 'login', { nombre: 'dueño', password: PASSWORD }))
    expect((await e.call('auth', 'me')).user.id).toBe(e.t.usuarioId)

    ok(await e.call('auth', 'logout'))
    expect(await e.call('auth', 'me')).toBeNull()

    // And a brand new process starts empty, whatever the last launch did.
    const r2 = createRegistry()
    registerAuthHandlers(r2, { conn: e.t.conn, session: createSession(e.t.conn) })
    expect(await r2.resolve('auth', 'me')({}, ctxDe(e.t, e.t.negocioId, null))).toBeNull()
  })

  it('stops working the moment the user is deactivated, without waiting for a new sign-in', async () => {
    ok(await e.call('auth', 'register', { nombre: 'Dueño', negocioNombre: 'Tienda', nombreAcceso: 'dueño', password: PASSWORD }))
    ok(await e.call('auth', 'login', { nombre: 'dueño', password: PASSWORD }))
    // A second owner, so that deactivating the first one is a thing the shop is ALLOWED to do.
    // This test used to deactivate the only admin, which since 003_ultimo_admin.sql the engine
    // refuses — and the fix is not to make an exception for the test: the situation this test
    // describes (an owner taking an employee off the till) always involved somebody else still
    // holding the keys. A shop with one owner and no employee cannot produce it at all.
    const ts = '2026-01-01T00:00:00.000Z'
    e.t.conn.db
      .prepare(
        `INSERT INTO users (nombre, email, rol, activo, negocio_id, created_at, updated_at)
         VALUES ('Segundo Dueño', 'segundo@minimarck.local', 'admin', 1, ?, ?, ?)`
      )
      .run(e.t.negocioId, ts, ts)
    e.t.conn.db.prepare('UPDATE users SET activo = 0 WHERE id = ?').run(e.t.usuarioId)
    // The session is a snapshot; it is re-validated on every use precisely so this is immediate.
    expect(await e.call('auth', 'me')).toBeNull()
  })

  it('records the successful sign-in on both the identity and the person', async () => {
    ok(await e.call('auth', 'register', { nombre: 'Dueño', negocioNombre: 'Tienda', nombreAcceso: 'dueño', password: PASSWORD }))
    ok(await e.call('auth', 'login', { nombre: 'dueño', password: PASSWORD }))
    const fila = e.t.conn.db.prepare('SELECT ultimo_acceso FROM user_identidades').get()
    expect(fila.ultimo_acceso).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('auth: changing a password', () => {
  let e
  beforeEach(() => { e = escenario() })
  afterEach(() => e.t.cerrar())

  it('keeps the same sign-in name and retires the old credential instead of deleting it', async () => {
    ok(await e.call('auth', 'register', { nombre: 'Dueño', negocioNombre: 'Tienda', nombreAcceso: 'dueño', password: PASSWORD }))
    ok(await e.call('auth', 'login', { nombre: 'dueño', password: PASSWORD }))
    ok(await e.call('auth', 'changePassword', { actualPassword: PASSWORD, password: 'la-nueva-clave' }))

    // A plain UNIQUE on (provider, external_id) made this call fail, because the retired row is
    // still in the table under the same handle. History is kept; the handle is not consumed.
    const filas = e.t.conn.db.prepare('SELECT activo, deleted_at FROM user_identidades ORDER BY id').all()
    expect(filas).toHaveLength(2)
    expect(filas[0].activo).toBe(0)
    expect(filas[0].deleted_at).not.toBeNull()
    expect(filas[1].activo).toBe(1)

    ok(await e.call('auth', 'login', { nombre: 'dueño', password: 'la-nueva-clave' }))
    expect(falla(await e.call('auth', 'login', { nombre: 'dueño', password: PASSWORD })).code).toBe('CREDENCIALES_INVALIDAS')
  })

  it('needs the current password, so a found till cannot permanently lock the owner out', async () => {
    ok(await e.call('auth', 'register', { nombre: 'Dueño', negocioNombre: 'Tienda', nombreAcceso: 'dueño', password: PASSWORD }))
    ok(await e.call('auth', 'login', { nombre: 'dueño', password: PASSWORD }))
    expect(falla(await e.call('auth', 'changePassword', { actualPassword: 'inventada', password: 'la-nueva-clave' })).code).toBe('CREDENCIALES_INVALIDAS')
    // The refused attempt changed nothing at all.
    ok(await e.call('auth', 'login', { nombre: 'dueño', password: PASSWORD }))
  })

  it('refuses to sign in without a session at all', async () => {
    expect(falla(await e.call('auth', 'changePassword', { actualPassword: PASSWORD, password: 'la-nueva-clave' })).code).toBe('ACTOR_REQUERIDO')
  })

  it('will NOT let a signed-in owner skip the old password on their OWN account', async () => {
    // The regression this pins is a WEAKENING that was tried and reverted. Routing `usuarioId`
    // at yourself into the reset branch would make "I am an admin" enough to rewrite your own
    // secret without typing it — so a till found open with a session on it becomes a one-field
    // permanent lockout, which is precisely the denial of service the operation refuses.
    ok(await e.call('auth', 'register', { nombre: 'Dueño', negocioNombre: 'Tienda', nombreAcceso: 'dueño', password: PASSWORD }))
    ok(await e.call('auth', 'login', { nombre: 'dueño', password: PASSWORD }))

    // No `usuarioId` at all.
    expect(falla(await e.call('auth', 'changePassword', { password: 'la-nueva-clave' })).code).toBe('CREDENCIALES_INVALIDAS')
    // And `usuarioId` pointing at yourself, which is the SAME path and not a privileged one.
    expect(falla(await e.call('auth', 'changePassword', { usuarioId: e.t.usuarioId, password: 'la-nueva-clave' })).code).toBe('CREDENCIALES_INVALIDAS')

    // The old password still opens the account afterwards: nothing was changed by either refusal.
    ok(await e.call('auth', 'login', { nombre: 'dueño', password: PASSWORD }))
  })
})

describe('auth: the owner resetting somebody else', () => {
  let e
  beforeEach(() => { e = escenario() })
  afterEach(() => e.t.cerrar())

  const dueno = { nombre: 'Dueño', negocioNombre: 'Tienda', nombreAcceso: 'dueño', password: PASSWORD }

  /** The owner, signed in, with one `vendedor` already on the till. */
  async function conEmpleado() {
    ok(await e.call('auth', 'register', dueno))
    ok(await e.call('auth', 'login', { nombre: 'dueño', password: PASSWORD }))
    const emp = ok(await e.call('auth', 'register', {
      nombre: 'Ana Ruiz', rol: 'vendedor', nombreAcceso: 'ana', password: 'clave-de-ana'
    }))
    ok(await e.call('auth', 'login', { nombre: 'dueño', password: PASSWORD }))
    return emp
  }

  it('replaces an employee password WITHOUT the old one, and the employee signs in with it', async () => {
    const emp = await conEmpleado()

    // No `actualPassword` is sent, and none is needed: the session already proved the owner.
    const r = ok(await e.call('auth', 'changePassword', { usuarioId: emp.id, password: 'clave-nueva-de-ana' }))
    expect(r).toMatchObject({ ok: true, usuarioId: emp.id, restablecida: true, nombre: 'Ana Ruiz' })

    ok(await e.call('auth', 'login', { nombre: 'ana', password: 'clave-nueva-de-ana' }))
    expect((await e.call('auth', 'me')).user).toMatchObject({ nombre: 'Ana Ruiz' })
    // And the password they were given at hiring no longer opens anything.
    expect(falla(await e.call('auth', 'login', { nombre: 'ana', password: 'clave-de-ana' })).code).toBe('CREDENCIALES_INVALIDAS')
  })

  it('keeps the sign-in handle, retires the old credential, and leaves the session alone', async () => {
    const emp = await conEmpleado()
    ok(await e.call('auth', 'changePassword', { usuarioId: emp.id, password: 'clave-nueva-de-ana' }))

    const filas = e.t.conn.db
      .prepare('SELECT external_id, activo, deleted_at FROM user_identidades WHERE user_id = ? ORDER BY id')
      .all(emp.id)
    // Two rows, same handle both times — the same shape a self-service change produces.
    expect(filas).toHaveLength(2)
    expect(filas[0].external_id).toBe('ana')
    expect(filas[0].activo).toBe(0)
    expect(filas[1].external_id).toBe('ana')
    expect(filas[1].activo).toBe(1)

    // Resetting somebody else's password must NOT log the owner out or hand them the till.
    expect((await e.call('auth', 'me')).user).toMatchObject({ id: e.t.usuarioId, rol: 'admin' })
  })

  it('never writes the plaintext, anywhere in the file', async () => {
    const emp = await conEmpleado()
    const NUEVA = 'clave-nueva-de-ana'
    ok(await e.call('auth', 'changePassword', { usuarioId: emp.id, password: NUEVA }))
    e.t.conn.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')

    const archivo = readFileSync(e.t.archivo, 'latin1')
    expect(archivo).not.toContain(NUEVA)
    // And the row is a scrypt row under the current policy, not a copy of the string.
    const fila = e.t.conn.db
      .prepare('SELECT algoritmo, secret FROM user_identidades WHERE user_id = ? AND activo = 1')
      .get(emp.id)
    expect(fila.algoritmo).toBe('scrypt')
    expect(fila.secret).not.toBe(NUEVA)
  })

  it('refuses a supervisor and a vendedor, and says the same thing to both', async () => {
    await conEmpleado()
    ok(await e.call('auth', 'register', { nombre: 'Sofi', rol: 'supervisor', nombreAcceso: 'sofi', password: 'clave-de-sofi' }))
    ok(await e.call('auth', 'login', { nombre: 'sofi', password: 'clave-de-sofi' }))
    const ana = e.t.conn.db.prepare(`SELECT id FROM users WHERE rol = 'vendedor' ORDER BY id LIMIT 1`).get()

    const supervisor = falla(await e.call('auth', 'changePassword', { usuarioId: ana.id, password: 'la-nueva-clave' }))
    expect(supervisor.code).toBe('SIN_PERMISO')

    ok(await e.call('auth', 'login', { nombre: 'ana', password: 'clave-de-ana' }))
    const vendedor = falla(await e.call('auth', 'changePassword', { usuarioId: e.t.usuarioId, password: 'la-nueva-clave' }))
    expect(vendedor.code).toBe('SIN_PERMISO')
    // A password is the keys to the shop, not the shop: a supervisor may not rewrite one.
    expect(supervisor.message).toBe(vendedor.message)
    // Both refusals changed nothing.
    ok(await e.call('auth', 'login', { nombre: 'ana', password: 'clave-de-ana' }))
  })

  it('gives ONE refusal for an id that does not exist, one that is deleted and one in another shop', async () => {
    await conEmpleado()
    const inexistente = falla(await e.call('auth', 'changePassword', { usuarioId: 999999, password: 'la-nueva-clave' }))
    expect(inexistente.code).toBe('USUARIO_NO_ENCONTRADO')

    // A person in ANOTHER business: the same answer, because a 404 that only exists in this
    // shop's file is still an oracle for what other files contain.
    const otro = Number(e.t.conn.db
      .prepare(
        `INSERT INTO negocios (nombre, ruc, tipo_comercio, configuracion, activo, created_at, updated_at)
         VALUES ('Vecina', NULL, 'otro', '{}', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run().lastInsertRowid)
    const extrana = Number(e.t.conn.db
      .prepare(
        `INSERT INTO users (nombre, email, rol, activo, negocio_id, created_at, updated_at)
         VALUES ('Otra Dueña', 'otra@minimarck.local', 'admin', 1, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(otro).lastInsertRowid)
    const ajena = falla(await e.call('auth', 'changePassword', { usuarioId: extrana, password: 'la-nueva-clave' }))
    expect(ajena).toEqual(inexistente)

    // And a deleted one answers the same, byte for byte.
    const ana = e.t.conn.db.prepare(`SELECT id FROM users WHERE rol = 'vendedor' ORDER BY id LIMIT 1`).get()
    e.t.conn.db.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', ana.id)
    expect(falla(await e.call('auth', 'changePassword', { usuarioId: ana.id, password: 'la-nueva-clave' }))).toEqual(inexistente)
  })

  it('says SIN_CREDENCIAL, not "ok", for somebody who never had a password', async () => {
    await conEmpleado()
    // A user row with no identity is a real state this schema allows and `auth.me` already
    // renders as "sin contraseña". Resetting a password it does not have would be creating one.
    const sinClave = Number(e.t.conn.db
      .prepare(
        `INSERT INTO users (nombre, email, rol, activo, negocio_id, created_at, updated_at)
         VALUES ('Recién hired', 'nuevo@minimarck.local', 'vendedor', 1, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(e.t.negocioId).lastInsertRowid)
    expect(falla(await e.call('auth', 'changePassword', { usuarioId: sinClave, password: 'la-nueva-clave' })).code).toBe('SIN_CREDENCIAL')
    expect(e.t.conn.db.prepare('SELECT COUNT(*) AS n FROM user_identidades WHERE user_id = ?').get(sinClave).n).toBe(0)
  })

  it('rejects a short new password, and a target that is not an id', async () => {
    await conEmpleado()
    const ana = e.t.conn.db.prepare(`SELECT id FROM users WHERE rol = 'vendedor' ORDER BY id LIMIT 1`).get()
    expect(falla(await e.call('auth', 'changePassword', { usuarioId: ana.id, password: 'corta' })).code).toBe('CONTRASENA_CORTA')
    for (const usuarioId of ['abc', -1, 0, 1.5, {}]) {
      expect(falla(await e.call('auth', 'changePassword', { usuarioId, password: 'la-nueva-clave' })).code).toBe('DATO_INVALIDO')
    }
  })

  it('refuses with no session, before it looks at anything', async () => {
    const err = falla(await e.call('auth', 'changePassword', { usuarioId: 1, password: 'la-nueva-clave' }))
    expect(err.code).toBe('ACTOR_REQUERIDO')
  })
})

describe('auth: employees', () => {
  let e
  beforeEach(() => { e = escenario() })
  afterEach(() => e.t.cerrar())

  const dueno = { nombre: 'Dueño', negocioNombre: 'Tienda', nombreAcceso: 'dueño', password: PASSWORD }

  it('the owner adds a vendedor, who can then sign in on their own', async () => {
    ok(await e.call('auth', 'register', dueno))
    ok(await e.call('auth', 'login', { nombre: 'dueño', password: PASSWORD }))
    const emp = ok(await e.call('auth', 'register', { nombre: 'Ana Ruiz', rol: 'vendedor', nombreAcceso: 'ana', password: 'clave-de-ana' }))
    expect(emp).toMatchObject({ nombre: 'Ana Ruiz', rol: 'vendedor' })

    ok(await e.call('auth', 'login', { nombre: 'ana', password: 'clave-de-ana' }))
    expect((await e.call('auth', 'me')).user).toMatchObject({ nombre: 'Ana Ruiz', rol: 'vendedor' })
  })

  it('lists the people with their real sign-in name, which is NOT their email', async () => {
    ok(await e.call('auth', 'register', dueno))
    ok(await e.call('auth', 'login', { nombre: 'dueño', password: PASSWORD }))
    ok(await e.call('auth', 'register', { nombre: 'Ana Ruiz', rol: 'vendedor', nombreAcceso: 'ana', password: 'clave-de-ana' }))

    const { personas } = ok(await e.call('auth', 'me'))
    const ana = personas.find((p) => p.nombre === 'Ana Ruiz')
    // The adopted legacy admin kept `admin@minimarck.local` as its email while its handle is
    // something else. A handover that fed `email` into `auth.login` would refuse every time.
    expect(ana.nombreAcceso).toBe('ana')
    expect(personas.find((p) => p.id === e.t.usuarioId).nombreAcceso).toBe('dueño')
    for (const p of personas) {
      expect(p).not.toHaveProperty('secret')
      expect(p).not.toHaveProperty('salt')
    }
  })

  it('refuses a second person under one sign-in name', async () => {
    ok(await e.call('auth', 'register', dueno))
    ok(await e.call('auth', 'login', { nombre: 'dueño', password: PASSWORD }))
    ok(await e.call('auth', 'register', { nombre: 'Ana', rol: 'vendedor', nombreAcceso: 'ana', password: 'clave-de-ana' }))
    expect(falla(await e.call('auth', 'register', { nombre: 'Otra', rol: 'vendedor', nombreAcceso: 'ANA', password: 'clave-de-otra' })).code).toBe('NOMBRE_EN_USO')
  })

  it('a vendedor cannot reach the users module at all', async () => {
    ok(await e.call('auth', 'register', dueno))
    ok(await e.call('auth', 'login', { nombre: 'dueño', password: PASSWORD }))
    ok(await e.call('auth', 'register', { nombre: 'Ana', rol: 'vendedor', nombreAcceso: 'ana', password: 'clave-de-ana' }))
    ok(await e.call('auth', 'login', { nombre: 'ana', password: 'clave-de-ana' }))
    expect(falla(await e.call('auth', 'register', { nombre: 'Coludido', rol: 'admin', nombreAcceso: 'coludido', password: 'clave- mia' })).code).toBe('SIN_PERMISO')
  })

  it('a supervisor may add people but may not mint another owner', async () => {
    ok(await e.call('auth', 'register', dueno))
    ok(await e.call('auth', 'login', { nombre: 'dueño', password: PASSWORD }))
    ok(await e.call('auth', 'register', { nombre: 'Sofi', rol: 'supervisor', nombreAcceso: 'sofi', password: 'clave-de-sofi' }))
    ok(await e.call('auth', 'login', { nombre: 'sofi', password: 'clave-de-sofi' }))

    ok(await e.call('auth', 'register', { nombre: 'Ana', rol: 'vendedor', nombreAcceso: 'ana', password: 'clave-de-ana' }))
    // The one escalation that is guarded: a supervisor is trusted with the shop, not with the
    // keys to it.
    expect(falla(await e.call('auth', 'register', { nombre: 'Otro', rol: 'admin', nombreAcceso: 'otro', password: 'clave-de-otro' })).code).toBe('SIN_PERMISO')
  })

  it('refuses a role that is not one of the three the shop defines', async () => {
    ok(await e.call('auth', 'register', dueno))
    ok(await e.call('auth', 'login', { nombre: 'dueño', password: PASSWORD }))
    expect(falla(await e.call('auth', 'register', { nombre: 'Nemo', rol: 'superusuario', nombreAcceso: 'nemo', password: 'clave-de-nemo' })).code).toBe('ROL_INVALIDO')
  })
})

describe('auth: handing the till over', () => {
  let e
  beforeEach(() => { e = escenario() })
  afterEach(() => e.t.cerrar())

  it('is a login: the incoming password decides, and the sale that follows is stamped with THEM', async () => {
    ok(await e.call('auth', 'register', { nombre: 'Dueño', negocioNombre: 'Tienda', nombreAcceso: 'dueño', password: PASSWORD }))
    ok(await e.call('auth', 'login', { nombre: 'dueño', password: PASSWORD }))
    ok(await e.call('auth', 'register', { nombre: 'Ana Ruiz', rol: 'vendedor', nombreAcceso: 'ana', password: 'clave-de-ana' }))

    insertarProducto(e.t, { negocioId: e.t.negocioId, usuarioId: e.t.usuarioId, overrides: { nombre: 'Queso', stock_milli: 5000 } })
    await e.call('cajas', 'open', { saldoInicial: 500 })

    // The owner tries to hand over using the WRONG password for the person taking over.
    expect(falla(await e.call('auth', 'login', { nombre: 'ana', password: 'no-es-la-de-ana' }))).toBeDefined()
    // They are still the one on the till after a refused handover.
    expect((await e.call('auth', 'me')).user.id).toBe(e.t.usuarioId)

    ok(await e.call('auth', 'login', { nombre: 'ana', password: 'clave-de-ana' }))
    expect((await e.call('auth', 'me')).user).toMatchObject({ nombre: 'Ana Ruiz' })

    const venta = ok(await e.call('ventas', 'create', {
      items: [{ productoId: e.t.conn.db.prepare('SELECT id FROM productos LIMIT 1').get().id, cantidad: 1 }],
      metodoPago: 'efectivo',
      idempotencyKey: 'tk-relevo'
    }))
    const fila = e.t.conn.db.prepare('SELECT user_id FROM ventas WHERE id = ?').get(venta.venta.id)
    // THE CLAIM: attribution follows the person on the till, taken from the session.
    expect(fila.user_id).not.toBe(e.t.usuarioId)
    expect(fila.user_id).toBe((await e.call('auth', 'me')).user.id)
  })

  it('a till opened by the owner is not hijackable by the employee', async () => {
    ok(await e.call('auth', 'register', { nombre: 'Dueño', negocioNombre: 'Tienda', nombreAcceso: 'dueño', password: PASSWORD }))
    ok(await e.call('auth', 'login', { nombre: 'dueño', password: PASSWORD }))
    const caja = ok(await e.call('cajas', 'open', { saldoInicial: 500 }))
    ok(await e.call('auth', 'register', { nombre: 'Ana', rol: 'vendedor', nombreAcceso: 'ana', password: 'clave-de-ana' }))
    ok(await e.call('auth', 'login', { nombre: 'ana', password: 'clave-de-ana' }))
    // A different person cannot close a till they did not open: the repo compares user_id, and a
    // handover is NOT a transfer of the drawer.
    expect(falla(await e.call('cajas', 'close', { id: caja.id, saldoContado: 500 }))).toBeDefined()
  })
})

describe('the renderer cannot choose who it is', () => {
  let e
  beforeEach(() => { e = escenario() })
  afterEach(() => e.t.cerrar())

  it('the context is built from the session and the process, and takes no payload', () => {
    const { session } = iniciarSesion(e.t, { nombre: 'ana' })
    const identity = { negocioId: e.t.negocioId, negocioNombre: 'Tienda', motivo: 'seed' }
    expect(construirContexto(identity, session).actorId).toBe(e.t.usuarioId)

    // Sign a DIFFERENT real person in: the same identity object, a different actor, on the very
    // next call. That is the handover, expressed as a fact about the context rather than a UI.
    const otro = Number(e.t.conn.db
      .prepare(`INSERT INTO users (nombre, email, rol, activo, negocio_id, created_at, updated_at)
                VALUES ('Ana Ruiz', 'ana@minimarck.local', 'vendedor', 1, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
      .run(e.t.negocioId).lastInsertRowid)
    session.abrir({ id: otro })
    expect(construirContexto(identity, session).actorId).toBe(otro)

    session.cerrar()
    expect(construirContexto(identity, session).actorId).toBeNull()
  })

  it('a session cannot be opened for a person who does not exist', () => {
    const session = createSession(e.t.conn)
    // `abrir` answers `actual()`, which re-reads the row: a session pointing at nothing is a
    // session that never opened, not a session with a made-up actor.
    expect(session.abrir({ id: 999999 })).toBeNull()
    expect(session.actorId()).toBeNull()
  })

  it('a payload claiming to be somebody else is ignored, and the sale lands on the session user', async () => {
    ok(await e.call('auth', 'register', { nombre: 'Dueño', negocioNombre: 'Tienda', nombreAcceso: 'dueño', password: PASSWORD }))
    ok(await e.call('auth', 'login', { nombre: 'dueño', password: PASSWORD }))
    insertarProducto(e.t, { negocioId: e.t.negocioId, usuarioId: e.t.usuarioId, overrides: { nombre: 'Queso', stock_milli: 5000 } })
    await e.call('cajas', 'open', { saldoInicial: 500 })

    // THE SEAM, not just the sink. This is the call the app makes: a real envelope arrives, and
    // `contextoDesdeEnvelope` is what turns it into a context. The first version of this test only
    // handed the forged fields to the HANDLER, which proved handlers ignore them; it could not
    // prove the payload never reaches the context at all, because that call lived in a module that
    // imports `electron` and no test could import it. `scripts/mutate-attribution.mjs` found the
    // difference: making the seam honour `user_id` left all 539 tests green until the seam moved
    // here. It is here now, so the mutation is caught.
    const identity = { negocioId: e.t.negocioId, negocioNombre: 'Tienda', motivo: 'seed' }
    const envelopeFalso = {
      version: 'v1',
      group: 'ventas',
      op: 'create',
      payload: { user_id: 4242, actorId: 4242, usuarioId: 4242 }
    }
    const { session } = e
    expect(contextoDesdeEnvelope(identity, session, envelopeFalso).actorId).toBe(e.t.usuarioId)
    expect(contextoDesdeEnvelope(identity, session, { ...envelopeFalso, payload: null }).actorId).toBe(e.t.usuarioId)

    const idProducto = e.t.conn.db.prepare('SELECT id FROM productos LIMIT 1').get().id
    const venta = ok(await e.call('ventas', 'create', {
      // Every field a renderer could try to forge, in one payload.
      user_id: 4242, actorId: 4242, usuarioId: 4242,
      items: [{ productoId: idProducto, cantidad: 1 }],
      metodoPago: 'efectivo',
      idempotencyKey: 'tk-falsificacion'
    }))
    expect(e.t.conn.db.prepare('SELECT user_id FROM ventas WHERE id = ?').get(venta.venta.id).user_id).toBe(e.t.usuarioId)
  })

  it('the envelope is received and read for nothing: swapping it cannot move the actor', async () => {
    // The negative form of the test above, stated as its own case so a future "helpfully honour the
    // payload" change has two tests to break rather than one.
    const { session } = iniciarSesion(e.t, { nombre: 'ana' })
    const identity = { negocioId: e.t.negocioId, negocioNombre: 'Tienda', motivo: 'seed' }
    const envelopes = [
      { payload: { user_id: 999 } },
      { payload: { actorId: 999 } },
      { payload: { usuarioId: 999 } },
      { payload: { user_id: 999, negocioId: 777 } },
      { payload: { identity: { user_id: 999 } } },
      { payload: [1, 2, 3] },
      { payload: 'user_id=999' }
    ]
    for (const envelope of envelopes) {
      expect(contextoDesdeEnvelope(identity, session, envelope).actorId).toBe(e.t.usuarioId)
      expect(contextoDesdeEnvelope(identity, session, envelope).negocioId).toBe(e.t.negocioId)
    }
  })

  it('with nobody signed in, a sale is refused — a till cannot be rung up by nobody', async () => {
    ok(await e.call('auth', 'register', { nombre: 'Dueño', negocioNombre: 'Tienda', nombreAcceso: 'dueño', password: PASSWORD }))
    ok(await e.call('auth', 'login', { nombre: 'dueño', password: PASSWORD }))
    insertarProducto(e.t, { negocioId: e.t.negocioId, usuarioId: e.t.usuarioId, overrides: { nombre: 'Queso', stock_milli: 5000 } })
    ok(await e.call('cajas', 'open', { saldoInicial: 500 }))
    ok(await e.call('auth', 'logout'))

    // With the till OPEN, the only thing left missing is a person — so the refusal is about the
    // operator and not about the money. Opening the till first is what makes this assertion mean
    // what it says: without it, the very first thing the repository complains about is the drawer.
    const idProducto = e.t.conn.db.prepare('SELECT id FROM productos LIMIT 1').get().id
    const venta = await e.call('ventas', 'create', {
      items: [{ productoId: idProducto, cantidad: 1 }],
      metodoPago: 'efectivo',
      idempotencyKey: 'tk-sin-gente'
    })
    expect(falla(venta).code).toBe('ACTOR_REQUERIDO')
    expect(e.t.conn.db.prepare('SELECT COUNT(*) AS n FROM ventas').get().n).toBe(0)
  })
})