/**
 * THE ACTIVE SESSION — the only source of who is operating the till.
 *
 * THIS IS THE SECURITY BOUNDARY, SO IT IS WORTH BEING EXPLICIT ABOUT WHAT IT IS NOT.
 *
 * It is not a token, not a JWT, not a cookie, and it is not in the renderer. There is no
 * expiry, no refresh and no revocation list because there is nothing to present: a local
 * desktop process has exactly one caller, and the proof of identity happened once, in this
 * process, in memory, at sign-in. A renderer cannot forge it because the renderer never sees
 * it — `installIpc` reads this object in MAIN and puts the resulting id into the request
 * context that every repository receives. The renderer's payload is never consulted for the
 * actor, and a test asserts that a payload carrying `user_id` does not change who the sale is
 * recorded under.
 *
 * WHY IN MEMORY AND NOT ON DISK. "Nobody is auto-logged in" is a product requirement, and the
 * only way to honour it honestly is for the session to not survive the process. A persisted
 * "remember me" token would make the next launch a login screen with a keyring already in the
 * lock, which is the exact thing a shop owner is asking for when they say the till must ask who
 * is on it every morning. So: a new process starts with no session, every single time, and the
 * first thing a person sees is the sign-in panel.
 *
 * WHY A RENDERER RELOAD DOES NOT LOG YOU OUT. The window reloads on a crash recovery, on a
 * deep link, and during development. The session lives in the main process, which survives all
 * of those, so `auth.me` answers the identity after a reload and the operator is not asked to
 * type a password because the page re-rendered. Restarting the APP is what ends a session, and
 * that is the honest line: the process is the session.
 *
 * WHY A DEACTIVATED OR DELETED USER IS REFUSED AT USE TIME. The session is a snapshot taken
 * when the password was verified. If the owner deactivates the employee who is on the till,
 * the running session must stop working immediately — not at the next sign-in. `actual()`
 * re-reads the row on every call, which is one indexed lookup per IPC call, and it is why
 * "deactivate an employee" actually removes them instead of merely discouraging them.
 */
import { IpcError } from '../bridge/errors.js'

/**
 * @param {object} conn - the open database, used to re-validate the session on every use.
 * @returns {object} the session API.
 */
export function createSession(conn) {
  /** @type {{id:number,nombre:string,rol:string,negocioId:number,desde:string}|null} */
  let activo = null

  /**
   * The row behind the open session, or null.
   *
   * Re-read on purpose (see the header): a session pointing at a user who is no longer active
   * is a session that has stopped existing, and returning null is what makes the next business
   * call fail with `ACTOR_REQUERIDO` instead of stamping a name onto a sale that a deactivated
   * employee rang up.
   */
  function actual() {
    if (!activo) return null
    const fila = conn.db
      .prepare(
        `SELECT u.id, u.nombre, u.rol, u.negocio_id
           FROM users u
          WHERE u.id = ? AND u.activo = 1 AND u.deleted_at IS NULL`
      )
      .get(activo.id)
    if (!fila) {
      activo = null
      return null
    }
    return {
      id: fila.id,
      nombre: fila.nombre,
      rol: fila.rol,
      negocioId: fila.negocio_id,
      desde: activo.desde
    }
  }

  /** The session user id, or null. The ONLY value `installIpc` puts in `ctx.actorId`. */
  function actorId() {
    return actual()?.id ?? null
  }

  /**
   * Open a session for a user, replacing any open one.
   *
   * REPLACEMENT IS THE HANDOVER. There is deliberately no separate "switch user" operation:
   * whoever becomes the operator on the till does it by VERIFYING THEIR OWN PASSWORD, which is
   * what `auth.login` already is. That is why no escalation path exists without a password —
   * there is no code path anywhere that changes the active user without a successful credential
   * check, because this function is only ever reached from that check.
   */
  function abrir(usuario) {
    activo = { id: usuario.id, desde: new Date().toISOString() }
    return actual()
  }

  function cerrar() {
    const habia = activo
    activo = null
    return habia !== null
  }

  /**
   * Refuse a call that needs an operator when nobody is signed in.
   *
   * 401, and the code is the same `ACTOR_REQUERIDO` the repositories already raise, so a client
   * that already handles "the sale needs a user" handles this without learning a new case.
   */
  function exigir() {
    const u = actual()
    if (!u) {
      throw new IpcError('ACTOR_REQUERIDO', 401, 'Necesitás iniciar sesión para hacer esto')
    }
    return u
  }

  /** True when somebody is signed in right now. Read by `auth.me`. */
  function hay() {
    return actual() !== null
  }

  return { actual, actorId, abrir, cerrar, exigir, hay }
}
