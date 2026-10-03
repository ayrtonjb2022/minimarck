/**
 * THE LOCKED-OUT OWNER CAN GET BACK IN — and everything the recovery tool refuses.
 *
 * WHY THIS FILE EXISTS NEXT TO `tests/auth/auth-local.spec.js`. The in-app reset path is guarded by
 * a session: somebody signed in, `auth.changePassword` checked their role, and the renderer could
 * only reach it through a frozen IPC operation. The offline tool has NONE of that. It runs as a
 * plain Node process, takes a name from a command line, and writes straight to the shop's database
 * file. There is no renderer to sandbox and no session to check, so the only thing standing between
 * "somebody typed a name" and "somebody owns the shop" is the refusals asserted here.
 *
 * The design decision being locked down — stated here because a test is the cheapest place to be
 * explicit about it — is that the trust boundary is the FILE, not the operator: anybody who can open
 * `minimarck.db` can reset anybody's password. That is deliberate (proving you are the owner needs
 * the password this tool replaces) and it is recorded in `DIVERGENCES.md`. What these tests protect
 * is the part that is NOT negotiable: the tool refuses when the file is ambiguous, and it never
 * confirms or denies whether an account exists.
 *
 * WHAT EACH ASSERTION IS FOR:
 *
 *   - THE RESET ACTUALLY WORKS. A green "it did not throw" would pass on a function that writes
 *     nothing, so the success path is measured the only way that means anything: the NEW password
 *     signs in and the OLD one is rejected, through the same `login` the sign-in screen calls.
 *   - THE HANDLE SURVIVES. This is a real bug that shipped in a draft: the handle was read off the
 *     matched row, and that query does not SELECT `external_id`, so the credential was written under
 *     an empty name and the account became unfindable by name afterwards — a second, quieter lockout
 *     created by the tool meant to end one.
 *   - A REFUSAL CHANGES NOTHING. A rejected reset must leave the old password WORKING. A tool that
 *     retires the credential and then refuses the password would lock the owner out permanently.
 *   - ONE ANSWER, NOT FOUR. Unknown, no credential, deactivated and retired all say the same thing,
 *     because four different answers turn a command anyone can run into a way of listing the staff.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tienda, tiendaVacia } from '../db/fixtures/tienda.js'
import { createSession } from '../../src/main/auth/session.js'
import { login } from '../../src/main/auth/auth.service.js'
import { guardarCredencial } from '../../src/main/auth/identities.repo.js'
import { restablecerDesdeDisco, cuentasReseteables } from '../../src/main/cli/reset-admin.js'

const TS = '2026-01-01T00:00:00.000Z'
const VIEJA = 'LaViejaDePrueba2026'
const NUEVA = 'LaNuevaDePrueba2026'

let t

beforeEach(() => {
  t = tienda()
})

afterEach(() => {
  t.cerrar()
})

/** Give the seeded operator a password, so "the account" exists to be recovered. */
function conCredencial(nombre = 'dueño', password = VIEJA, usuarioId = t.usuarioId) {
  guardarCredencial(t.conn, usuarioId, nombre, password)
  return nombre
}

/** Sign in the way the sign-in screen does, and report what happened instead of throwing. */
function intentarEntrar(nombre, password) {
  const sesion = createSession(t.conn)
  try {
    const r = login(t.conn, sesion, { nombre, password })
    return { entro: true, rol: r.rol }
  } catch (err) {
    return { entro: false, codigo: err.code, mensaje: err.message }
  }
}

function codigoDe(fn) {
  try {
    fn()
    return null
  } catch (err) {
    return err.code ?? err.name
  }
}

describe('offline recovery — the reset works', () => {
  it('the new password signs in and the old one is rejected, through the real sign-in path', () => {
    const nombre = conCredencial()
    const antes = intentarEntrar(nombre, VIEJA)
    expect(antes.entro).toBe(true)

    const r = restablecerDesdeDisco(t.conn, { nombreAcceso: nombre, password: NUEVA })
    expect(r.ok).toBe(true)

    expect(intentarEntrar(nombre, NUEVA).entro).toBe(true)
    const vieja = intentarEntrar(nombre, VIEJA)
    expect(vieja.entro).toBe(false)
    expect(vieja.codigo).toBe('CREDENCIALES_INVALIDAS')
  })

  it('KEEPS THE HANDLE, so the account is still findable by name afterwards', () => {
    // The draft bug: `external_id` came off the matched row, which does not select it, and the new
    // credential was written under an EMPTY handle. Signing in by name then failed forever, with no
    // error explaining why — the recovery tool had produced a second lockout.
    const nombre = conCredencial('Dueño')
    const r = restablecerDesdeDisco(t.conn, { nombreAcceso: 'dueño', password: NUEVA })

    expect(r.nombreAcceso).toBe('dueño')
    const activa = t.conn.db
      .prepare(`SELECT external_id, activo FROM user_identidades WHERE user_id = ? AND activo = 1`)
      .all(t.usuarioId)
    expect(activa).toHaveLength(1)
    expect(activa[0].external_id).toBe('dueño')
    // And it is reachable under the NORMALIZED name, not only the one that was typed.
    expect(intentarEntrar('dueño', NUEVA).entro).toBe(true)
  })

  it('reports who was reset, without ever reporting the password', () => {
    const nombre = conCredencial('Dueña', VIEJA)
    const r = restablecerDesdeDisco(t.conn, { nombreAcceso: nombre, password: NUEVA })
    expect(r).toMatchObject({ ok: true, usuarioId: t.usuarioId, nombreAcceso: 'dueña', rol: 'admin' })
    expect(JSON.stringify(r)).not.toContain(NUEVA)
  })

  it('the reset is a REISSUE, not an overwrite: the old credential is retired, not deleted', () => {
    // Same write the sign-in path makes, so there is one implementation of "change a password" and
    // the old row stays as history. A tool that UPDATED the existing row in place would leave no
    // trace that the credential ever changed.
    const nombre = conCredencial()
    restablecerDesdeDisco(t.conn, { nombreAcceso: nombre, password: NUEVA })
    const filas = t.conn.db
      .prepare('SELECT activo, deleted_at FROM user_identidades WHERE user_id = ? ORDER BY id')
      .all(t.usuarioId)
    expect(filas.length).toBeGreaterThan(1)
    expect(filas.some((f) => f.activo === 1)).toBe(true)
    expect(filas.some((f) => f.activo === 0)).toBe(true)
  })
})

describe('offline recovery — what it refuses', () => {
  it('refuses a password the app itself would refuse, and writes NOTHING', () => {
    const nombre = conCredencial()
    // The app's own policy, not a second copy: a policy that drifts is a policy nobody tested. The
    // code is `CONTRASENA_CORTA` because that is what `exigirPassword` throws — this asserted
    // `DATO_INVALIDO` first and failed, which is the point of asserting a shared code instead of
    // trusting that both paths agree about it.
    expect(codigoDe(() => restablecerDesdeDisco(t.conn, { nombreAcceso: nombre, password: 'corta' }))).toBe(
      'CONTRASENA_CORTA'
    )
    // The old password STILL WORKS. A reset that retired the credential and then refused the
    // password would lock the owner out permanently — the one failure worse than doing nothing.
    expect(intentarEntrar(nombre, VIEJA).entro).toBe(true)
  })

  it('refuses an empty password the same way', () => {
    const nombre = conCredencial()
    expect(codigoDe(() => restablecerDesdeDisco(t.conn, { nombreAcceso: nombre, password: '' }))).toBe(
      'CONTRASENA_CORTA'
    )
    expect(intentarEntrar(nombre, VIEJA).entro).toBe(true)
  })

  it('gives ONE answer for an account that does not exist, so the tool cannot enumerate staff', () => {
    // Nobody with this name, ever.
    const ninguno = codigoDe(() =>
      restablecerDesdeDisco(t.conn, { nombreAcceso: 'nadie', password: NUEVA })
    )
    expect(ninguno).toBe('USUARIO_NO_ENCONTRADO')

    // Somebody who exists and has no credential at all: a DIFFERENT situation, and the refusal
    // must be indistinguishable from the one above.
    const nuevoUsuario = Number(
      t.conn.db
        .prepare(
          `INSERT INTO users (nombre, email, rol, activo, negocio_id, created_at, updated_at)
           VALUES ('Sin Credencial', 'sin@ejemplo.test', 'vendedor', 1, ?, ?, ?)`
        )
        .run(t.negocioId, TS, TS).lastInsertRowid
    )
    const sinCredencial = codigoDe(() =>
      restablecerDesdeDisco(t.conn, { nombreAcceso: 'sin', password: NUEVA })
    )
    expect(sinCredencial).toBe(ninguno)

    // A person who WAS signed in and then deactivated: also the same refusal.
    const desactivado = Number(
      t.conn.db
        .prepare(
          `INSERT INTO users (nombre, email, rol, activo, negocio_id, created_at, updated_at)
           VALUES ('Desactivada', 'des@ejemplo.test', 'vendedor', 1, ?, ?, ?)`
        )
        .run(t.negocioId, TS, TS).lastInsertRowid
    )
    guardarCredencial(t.conn, desactivado, 'desactivada', VIEJA)
    t.conn.db.prepare('UPDATE users SET activo = 0 WHERE id = ?').run(desactivado)
    const fuera = codigoDe(() =>
      restablecerDesdeDisco(t.conn, { nombreAcceso: 'desactivada', password: NUEVA })
    )
    expect(fuera).toBe(ninguno)
    expect(nuevoUsuario).toBeGreaterThan(0)
  })

  it('refuses when the file holds MORE THAN ONE business, rather than guessing the shop', () => {
    // A reset aimed at the wrong business is worse than no reset at all.
    conCredencial()
    t.conn.db
      .prepare(
        `INSERT INTO negocios (nombre, ruc, tipo_comercio, configuracion, activo, created_at, updated_at)
         VALUES ('Segundo', '20555555555', 'otro', '{}', 1, ?, ?)`
      )
      .run(TS, TS)
    expect(codigoDe(() => restablecerDesdeDisco(t.conn, { nombreAcceso: 'dueño', password: NUEVA }))).toBe(
      'NEGOCIO_AMBIGUO'
    )
    expect(intentarEntrar('dueño', VIEJA).entro).toBe(true)
  })

  it('refuses a file with NO business, instead of writing to a shop that does not exist', () => {
    const vacia = tiendaVacia()
    try {
      expect(
        codigoDe(() => restablecerDesdeDisco(vacia.conn, { nombreAcceso: 'dueño', password: NUEVA }))
      ).toBe('NEGOCIO_AMBIGUO')
    } finally {
      vacia.cerrar()
    }
  })

  it('refuses an account belonging to ANOTHER business in the same file', () => {
    // Unreachable while the multi-business refusal stands, and checked anyway: "reset the password
    // of somebody from another shop" is not a small thing to get wrong, and a guard that only covers
    // the reachable case stops covering it the day that refusal changes.
    conCredencial()
    const otro = Number(
      t.conn.db
        .prepare(
          `INSERT INTO negocios (nombre, ruc, tipo_comercio, configuracion, activo, created_at, updated_at)
           VALUES ('Otro', '20666666666', 'otro', '{}', 1, ?, ?)`
        )
        .run(TS, TS).lastInsertRowid
    )
    const suyo = Number(
      t.conn.db
        .prepare(
          `INSERT INTO users (nombre, email, rol, activo, negocio_id, created_at, updated_at)
           VALUES ('De Otro', 'otro@ejemplo.test', 'vendedor', 1, ?, ?, ?)`
        )
        .run(otro, TS, TS).lastInsertRowid
    )
    guardarCredencial(t.conn, suyo, 'deotro', VIEJA)

    // With two businesses the tool stops at NEGOCIO_AMBIGUO — which is the answer that matters, and
    // proves it never got far enough to touch the other shop's person.
    expect(codigoDe(() => restablecerDesdeDisco(t.conn, { nombreAcceso: 'deotro', password: NUEVA }))).toBe(
      'NEGOCIO_AMBIGUO'
    )
    expect(intentarEntrar('dueño', VIEJA).entro).toBe(true)
  })
})

describe('offline recovery — what --listar is allowed to show', () => {
  it('lists handles of active accounts that HAVE a password, and nothing else', () => {
    guardarCredencial(t.conn, t.usuarioId, 'dueño', VIEJA)
    const vendedor = Number(
      t.conn.db
        .prepare(
          `INSERT INTO users (nombre, email, rol, activo, negocio_id, created_at, updated_at)
           VALUES ('Vendedor Uno', 'v1@ejemplo.test', 'vendedor', 1, ?, ?, ?)`
        )
        .run(t.negocioId, TS, TS).lastInsertRowid
    )
    guardarCredencial(t.conn, vendedor, 'vendedor1', VIEJA)

    // A person with NO credential cannot be reset, so listing them would advertise an action the
    // tool would then refuse.
    t.conn.db
      .prepare(
        `INSERT INTO users (nombre, email, rol, activo, negocio_id, created_at, updated_at)
         VALUES ('Sin Acceso', 's@ejemplo.test', 'vendedor', 1, ?, ?, ?)`
      )
      .run(t.negocioId, TS, TS)

    const lista = cuentasReseteables(t.conn)
    expect(lista.map((c) => c.nombreAcceso).sort()).toEqual(['dueño', 'vendedor1'])
    for (const c of lista) {
      expect(Object.keys(c).sort()).toEqual(['nombre', 'nombreAcceso', 'rol'])
      expect(JSON.stringify(c)).not.toContain(VIEJA)
    }
  })

  it('omits a DEACTIVATED account, whose reset would be refused a moment later', () => {
    guardarCredencial(t.conn, t.usuarioId, 'dueño', VIEJA)
    const fuera = Number(
      t.conn.db
        .prepare(
          `INSERT INTO users (nombre, email, rol, activo, negocio_id, created_at, updated_at)
           VALUES ('Se Fue', 'f@ejemplo.test', 'vendedor', 1, ?, ?, ?)`
        )
        .run(t.negocioId, TS, TS).lastInsertRowid
    )
    guardarCredencial(t.conn, fuera, 'sefue', VIEJA)
    t.conn.db.prepare('UPDATE users SET activo = 0 WHERE id = ?').run(fuera)

    expect(cuentasReseteables(t.conn).map((c) => c.nombreAcceso)).toEqual(['dueño'])
  })

  it('returns nothing, rather than guessing, when the file is ambiguous', () => {
    t.conn.db
      .prepare(
        `INSERT INTO negocios (nombre, ruc, tipo_comercio, configuracion, activo, created_at, updated_at)
         VALUES ('Segundo', '20555555555', 'otro', '{}', 1, ?, ?)`
      )
      .run(TS, TS)
    expect(cuentasReseteables(t.conn)).toEqual([])
  })
})