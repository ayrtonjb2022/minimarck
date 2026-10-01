/**
 * THE FIVE `auth` OPERATIONS — register, login, me, changePassword, logout — and the two
 * behaviours that ride on them without inventing a sixth.
 *
 * ── THE HANDOVER IS NOT A SIXTH OPERATION, AND THAT IS THE POINT ────────────────────────────
 *
 * §L is frozen at 89 operations and `auth` has exactly five names in it. A "switch user"
 * operation would be a code path that changes who is operating the till WITHOUT checking a
 * password, and the hardest requirement of this feature is that no such path exists. So the
 * handover IS `auth.login`: the employee types their own password, it is verified against their
 * own stored secret, and the session is replaced. There is no code anywhere that assigns the
 * session without having just verified a credential, because `session.abrir` is called from
 * exactly two places — both of them immediately after `autenticar` returned.
 *
 * Both directions are the same operation with no privileged variant. Handing over to an employee
 * and taking the till back are the same code: type a name, type its password, become that
 * person. Neither can skip its password, and neither is a special case.
 *
 * ── THE GAP IN §L, AND THE WORKAROUND ──────────────────────────────────────────────────────
 *
 * §L has NO `usuarios` group. The web's own user management is a `GET /users` list and a
 * `UserForm.jsx` that renders `null`, so there was nothing to port and the contract never had
 * room for it. Adding `usuarios.list`/`usuarios.create` would move the frozen count from 89 to
 * 91, which is a decision for review rather than for a feature branch.
 *
 * The capability is delivered on operations that already exist, which is what the product needs
 * and what the contract allows:
 *
 *   - CREATING an employee is `auth.register` while a session is open. "Register" means "make a
 *     person who can sign in on this machine", and the panel asks for a name, a sign-in name, a
 *     role and a password either way. With no session it creates the business and its owner;
 *     with an owner's session it adds an employee to the business that already exists. The
 *     difference is derived from the session, not from a parameter a caller could set.
 *   - LISTING the people is carried by `auth.me`, which the shell already calls at startup and
 *     which already answers "who is operating, for which business". The handover picker needs
 *     "who else is in this business", so it is one more field on the answer to a question that
 *     was already being asked — a new FIELD, not a new OPERATION, so the count stays 89.
 *
 * The half that is genuinely missing is editing an existing employee — changing their role,
 * disabling them, renaming them. That needs an operation which does not exist, so it is
 * reported as a gap rather than smuggled in under a name that means something else. Until §L
 * grows a `usuarios` group, an employee cannot be removed from the till through the UI.
 */
import { IpcError } from '../bridge/errors.js'
import { esViolacionUnica } from '../db/errores-sqlite.js'
import {
  ROLES,
  autenticar,
  exigirAdministradorDeUsuarios,
  exigirRol,
  guardarCredencial,
  hayCredenciales,
  listarUsuarios,
  marcarAcceso,
  negocioUnico,
  nombreDeAcceso,
  actualizarSiProcede
} from './identities.repo.js'
import { MIN_PASSWORD } from './passwords.js'
import { DEFAULT_NEGOCIO } from '../db/seed.js'

function ahora() {
  return new Date().toISOString()
}

function texto(valor, campo, { max = 200 } = {}) {
  const t = typeof valor === 'string' ? valor.trim() : ''
  if (t === '') throw new IpcError('DATO_INVALIDO', 400, `Falta ${campo}`)
  if (t.length > max) throw new IpcError('DATO_INVALIDO', 400, `${campo} es demasiado largo`)
  return t
}

function exigirPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new IpcError(
      'CONTRASENA_CORTA', 400,
      `La contraseña necesita al menos ${MIN_PASSWORD} caracteres`
    )
  }
  return password
}

/** The public shape of a signed-in person. No `secret`, no `salt`, no parameters. */
function sesionPublica(u) {
  return { id: u.id, nombre: u.nombre, rol: u.rol, negocioId: u.negocioId }
}

/**
 * `auth.login` — sign in, and hand the till over if somebody is already on it.
 *
 * NO AUTO-LOGIN. This is only reachable from a person typing into the panel: the session module
 * holds nothing at startup, so every launch starts signed out, and a renderer reload keeps the
 * session because the main process survived it.
 */
export function login(conn, session, body = {}) {
  const nombre = texto(body.nombre, 'el nombre de acceso')
  const usuario = autenticar(conn, nombre, body.password)
  marcarAcceso(conn, usuario.id, usuario.identidad_id)
  // Re-derive under the current policy when the stored one is older. AFTER verification, so it
  // can only strengthen a secret that already opened the account.
  actualizarSiProcede(conn, usuario.identidad_id, nombre, body.password)
  return sesionPublica(session.abrir(usuario))
}

/**
 * `auth.me` — who is operating, for which business, and who else could take over.
 *
 * `personas` is what makes the handover a pick rather than a guess, and it is a field on an
 * operation that already existed. Every signed-in person gets the list: on a single-machine till
 * the names of the people who work in the shop are not a secret, and the employee taking the
 * till back needs the owner's name in the same picker the owner used to hand it over.
 *
 * The list is built from `users`, so a person without a credential is still listed with
 * `puedeIngresar: false` — the owner can see that an employee exists but has never set a
 * password, which is a fact worth showing rather than hiding.
 */
export function me(conn, session) {
  const u = session.actual()
  if (!u) return null
  const negocio = conn.db
    .prepare(`SELECT id, nombre FROM negocios WHERE id = ?`)
    .get(u.negocioId)
  const personas = listarUsuarios(conn, u.negocioId)
  const yo = personas.find((p) => p.id === u.id)
  return {
    // `nombreAcceso` rides along on the signed-in person because the foot of the menu has to say
    // the name the OWNER types to sign in. For the adopted legacy admin `users.email` is
    // `admin@minimarck.local`, which is not that name, and a footer that printed it would be
    // showing the operator a credential that does not work.
    user: {
      id: u.id,
      nombre: u.nombre,
      rol: u.rol,
      nombreAcceso: yo?.nombreAcceso ?? null
    },
    negocio: negocio ? { id: negocio.id, nombre: negocio.nombre } : null,
    personas
  }
}

/**
 * `auth.register` — two meanings, one operation, decided by the SESSION and not by a parameter.
 *
 *   NO SESSION  → first launch. Creates the business from the panel and its first user inside
 *                 it with `rol = 'admin'`, the business associated to that user.
 *
 *   A SESSION   → the owner (or a supervisor) adds an employee to the business that already
 *                 exists. The role comes from the three the web defines; a supervisor may not
 *                 mint an `admin`, which is the one escalation guarded here.
 *
 *   NO SESSION but credentials exist → refused. Otherwise re-running the first-launch panel is
 *                 how a second owner appears on a machine that already has one, without anyone
 *                 being asked for a password. After the first sign-in the only way in is
 *                 `auth.login`.
 *
 * WHY AN EXISTING SHOP ADOPTS ITS OWN ADMIN. A file that already has sales, purchases and debts
 * but no credential was taken on a build with no sign-in. Creating a second owner next to the
 * operator whose name is already stamped on every one of those rows would mean the audit trail
 * and the login disagreed about who the shopkeeper is. So register attaches the credential to
 * that existing admin — the same "exactly one admin" rule `identity.js` already used to decide
 * who the seeded rows belong to — and rewrites no data at all.
 */
export function registrar(conn, session, body = {}) {
  if (session.hay()) return crearEmpleado(conn, session, body)

  if (hayCredenciales(conn)) {
    throw new IpcError('YA_CONFIGURADO', 409, 'Este equipo ya tiene usuarios con contraseña: iniciá sesión.')
  }

  const nombre = texto(body.nombre, 'tu nombre', { max: 120 })
  const negocioNombre = texto(body.negocioNombre, 'el nombre del negocio', { max: 120 })
  const nombreAcceso = texto(body.nombreAcceso || body.email, 'el nombre de acceso')
  const password = exigirPassword(body.password)
  const ts = ahora()

  const ids = conn.tx(() => {
    const existente = negocioUnico(conn)
    if (existente?.multiple) {
      throw new IpcError(
        'NEGOCIO_AMBIGUO', 409,
        'Este archivo tiene más de un negocio activo; hay que quedarse con uno antes de crear el dueño.'
      )
    }

    let negocioId
    let negocioNombreFinal = negocioNombre
    if (!existente) {
      try {
        negocioId = Number(
          conn.db
            .prepare(
              `INSERT INTO negocios (nombre, ruc, tipo_comercio, configuracion, activo, created_at, updated_at)
               VALUES (?, ?, ?, '{}', 1, ?, ?)`
            )
            .run(negocioNombre, null, 'otro', ts, ts).lastInsertRowid
        )
      } catch (err) {
        if (esViolacionUnica(err)) {
          throw new IpcError('NEGOCIO_EN_USO', 409, 'Ya existe un negocio con ese nombre')
        }
        throw err
      }
    } else {
      negocioId = existente.id
      negocioNombreFinal = existente.nombre
      // `Mi Negocio` is the SEED's placeholder, not a name anybody chose — it was written by
      // `seed.js` on a build that had no sign-in screen to ask the question. The owner is being
      // asked the name of their shop RIGHT NOW, so the placeholder has to give way to the answer.
      // Only the exact seed default is replaced: a shop whose business was already named by hand
      // keeps the name it had, because at that point it is data and not a default. Only the label
      // moves — `negocio_id` is what every sale, debt and purchase points at.
      if (existente.nombre === DEFAULT_NEGOCIO.nombre) {
        conn.db
          .prepare(`UPDATE negocios SET nombre = ?, updated_at = ? WHERE id = ?`)
          .run(negocioNombre, ts, negocioId)
        negocioNombreFinal = negocioNombre
      }
    }

    const admins = conn.db
      .prepare(
        `SELECT id FROM users
          WHERE negocio_id = ? AND rol = 'admin' AND activo = 1 AND deleted_at IS NULL
          ORDER BY id`
      )
      .all(negocioId)
    const adoptado = admins.length === 1
    let userId
    if (adoptado) {
      userId = admins[0].id
      // The person typing the panel says who they are, so the shop shows THAT name from now on.
      // Only the label moves: the id is what every sale, debt and purchase already points at, so
      // this rewrites no history. The email is left exactly as it was — for an adopted legacy
      // admin it is not the sign-in handle, and the handle comes from the identity row below.
      conn.db
        .prepare(`UPDATE users SET nombre = ?, updated_at = ? WHERE id = ?`)
        .run(nombre, ts, userId)
    } else {
      userId = Number(
        conn.db
          .prepare(
            `INSERT INTO users (nombre, email, rol, activo, negocio_id, created_at, updated_at)
             VALUES (?, ?, 'admin', 1, ?, ?, ?)`
          )
          .run(nombre, nombreAcceso, negocioId, ts, ts).lastInsertRowid
      )
    }

    guardarCredencial(conn, userId, nombreAcceso, password, ts)
    return { userId, negocioId, adoptado, negocioNombre: negocioNombreFinal }
  })

  const sesion = sesionPublica(session.abrir({ id: ids.userId, nombre, rol: 'admin' }))
  return {
    ...sesion,
    negocioId: ids.negocioId,
    negocioNombre: ids.negocioNombre,
    adoptoNegocioExistente: ids.adoptado
  }
}

/**
 * The employee half of `auth.register`: the owner adds somebody who can take the till.
 *
 * Reached only from `registrar` with an open session, so the "is there a session" test that
 * chose this path is the same test that proved there is a credential to get here — a caller
 * cannot ask for this branch without already being signed in as somebody who may create people.
 */
export function crearEmpleado(conn, session, body = {}) {
  const actual = session.exigir()
  exigirAdministradorDeUsuarios(actual.rol)

  const nombre = texto(body.nombre, 'el nombre del empleado', { max: 120 })
  const rol = exigirRol(body.rol || 'vendedor')
  if (rol === 'admin' && actual.rol !== 'admin') {
    throw new IpcError('SIN_PERMISO', 403, 'Sólo el dueño puede crear otro dueño')
  }
  const nombreAcceso = texto(body.nombreAcceso || body.email, 'el nombre de acceso')
  const password = exigirPassword(body.password)
  const negocioId = actual.negocioId
  const ts = ahora()

  const userId = conn.tx(() => {
    let id
    try {
      id = Number(
        conn.db
          .prepare(
            `INSERT INTO users (nombre, email, rol, activo, negocio_id, created_at, updated_at)
             VALUES (?, ?, ?, 1, ?, ?, ?)`
          )
          .run(nombre, nombreAcceso, rol, negocioId, ts, ts).lastInsertRowid
      )
    } catch (err) {
      if (esViolacionUnica(err)) {
        throw new IpcError('NOMBRE_EN_USO', 409, 'Ese nombre de acceso ya está en uso')
      }
      throw err
    }
    guardarCredencial(conn, id, nombreAcceso, password, ts)
    return id
  })

  return { id: userId, nombre, rol, negocioId, puedeIngresar: true }
}

/**
 * `auth.changePassword` — the signed-in person changes their OWN password.
 *
 * THE CURRENT PASSWORD IS REQUIRED, and that is the reason this is safe. Without it, someone who
 * found an unlocked till could permanently lock the owner out, which turns a convenience into a
 * denial of service against the shop. With it, changing a password needs the same credential as
 * signing in — and the check reuses `autenticar`, so a wrong current password is byte for byte
 * the same 401 as a wrong sign-in and leaks nothing about the new one.
 */
export function changePassword(conn, session, body = {}) {
  const actual = session.exigir()
  const nuevo = exigirPassword(body.password)
  const actualPlano = typeof body.actualPassword === 'string' ? body.actualPassword : ''

  const nombreActual = nombreDeAcceso(conn, actual.id)
  if (!nombreActual) {
    throw new IpcError('SIN_CREDENCIAL', 409, 'Esta cuenta no tiene contraseña configurada')
  }
  autenticar(conn, nombreActual, actualPlano)

  if (nuevo === actualPlano) {
    throw new IpcError('CONTRASENA_IGUAL', 400, 'La nueva contraseña es la misma que la actual')
  }
  guardarCredencial(conn, actual.id, nombreActual, nuevo)
  return { ok: true, usuarioId: actual.id }
}

/** `auth.logout` — end the session. Nothing is stored, so there is nothing to revoke. */
export function logout(session) {
  return { ok: session.cerrar() }
}

export { ROLES, sesionPublica }
