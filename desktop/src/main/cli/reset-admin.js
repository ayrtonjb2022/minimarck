/**
 * OFFLINE PASSWORD RECOVERY — the answer to "the owner forgot the password and nobody else knows it".
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────────────────────────
 *
 * The sign-in feature makes the shop secure, and secure means a locked-out owner is locked out for
 * good: `auth.register` refuses once the file has credentials, the owner cannot sign in to prove who
 * they are, and the person with the authority to reset anybody else's password is themselves the one
 * who cannot get in. A feature that can permanently deny the owner their own shop is a defect, not
 * strictness, and no amount of good password policy fixes it.
 *
 * ── WHY A CLI AND NOT A SCREEN ─────────────────────────────────────────────────────────────────
 *
 * A reset button in the app would need someone to click it, and the only person who can be trusted
 * to click it is the owner — who cannot sign in. Anything weaker than that is a hole in the wall the
 * sign-in screen just built. So recovery happens OUTSIDE the app, on the machine, by whoever holds
 * the file.
 *
 * ── THE TRUST BOUNDARY, STATED PLAINLY BECAUSE IT IS THE WHOLE SECURITY MODEL ───────────────────
 *
 * Anyone who can run this can set the password of anybody in the shop. There is no password prompt
 * for the operator, no "are you the owner" question, and there could not usefully be one: proving you
 * are the owner requires the password this tool exists to replace. What it relies on is the same
 * assumption every local-first application makes — **the person who can open the database file is
 * the shop**. `%APPDATA%\MiniMarck\data\minimarck.db` is a scrypt-hashed credential store in a
 * Windows user profile with no second factor above it.
 *
 * It is worth being honest that this is weaker than a server-side account system, and it is weaker
 * on purpose: a desktop till has to open at a market stall with no network. What the app DOES own —
 * the renderer cannot reach this, the IPC contract has no such operation, and no window can trigger
 * it — is stated in `DIVERGENCES.md` next to the decision.
 *
 * ── WHAT IT REFUSES, AND WHY EACH REFUSAL IS WORTH THE LINES ───────────────────────────────────
 *
 *   - More than one business in the file. `negocioUnico` refuses to guess which shop you mean, and a
 *     reset aimed at the wrong one is worse than no reset.
 *   - A handle nobody has. Same refusal for "unknown", "no credential", "deactivated" and "retired",
 *     because four different answers turn a command anyone can run into a way of enumerating the
 *     shop's staff — the exact thing the sign-in screen refuses to be.
 *   - A password the app would refuse, via the app's own `exigirPassword`.
 *   - Nothing, quietly: every refusal is a named code, because a person typing at a command prompt
 *     needs to be told WHAT to fix, and a person who needs this tool is already locked out.
 *
 * ── WHY IT IS PURE ─────────────────────────────────────────────────────────────────────────────
 *
 * `conn` in, result out. No Electron, no `app.getPath`, no prompt, no exit code: the launcher in
 * `scripts/auth-reset-admin.mjs` owns all of that, which is why this file can be tested against a
 * real temporary database instead of against a description of a database.
 */
import { IpcError } from '../bridge/errors.js'
import {
  PROVIDER_LOCAL,
  negocioUnico,
  usuarioPorNombre,
  guardarCredencial
} from '../auth/identities.repo.js'
import { exigirPassword } from '../auth/auth.service.js'
import { normalizarNombre } from '../auth/passwords.js'

/**
 * Set a new password for `nombreAcceso` in this file's only business.
 *
 * @param {object} conn an open database, already allowlisted for `user_identidades` and `users`
 * @param {{nombreAcceso: string, password: string}} entrada
 * @returns {{ok: true, usuarioId: number, nombreAcceso: string, nombre: string, rol: string}}
 */
export function restablecerDesdeDisco(conn, { nombreAcceso, password } = {}) {
  // WHICH SHOP. One file is one shop; `negocioUnico` already answers the ambiguous case and the
  // launcher never gets here without an answer, so a refusal here means the file changed underneath
  // the tool between those two steps.
  const negocio = negocioUnico(conn)
  if (!negocio || negocio.multiple) {
    throw new IpcError(
      'NEGOCIO_AMBIGUO', 409,
      'Este archivo tiene más de un negocio o ninguno; no se sabe a cuál pertenece esa cuenta'
    )
  }

  // `usuarioPorNombre` joins on both tables and refuses rows that are inactive or retired, so an
  // account without a live credential and an account nobody has both come back as `null` — one
  // refusal, no way to tell them apart from outside.
  const fila = usuarioPorNombre(conn, nombreAcceso)
  if (!fila) {
    throw new IpcError(
      'USUARIO_NO_ENCONTRADO', 404,
      'No hay ninguna cuenta activa con ese nombre de acceso en este negocio'
    )
  }
  if (fila.negocio_id !== negocio.id) {
    // Two businesses in one file is refused above, so this cannot normally happen. It is checked
    // anyway because "reset the password of somebody from another shop" is not a small thing to
    // get wrong, and a guard that only covers the reachable case is a guard that stops covering it
    // the day the refusal above changes.
    throw new IpcError(
      'USUARIO_NO_ENCONTRADO', 404,
      'No hay ninguna cuenta activa con ese nombre de acceso en este negocio'
    )
  }

  // The app's own policy, not a second copy of it.
  exigirPassword(password)

  // The handle comes from THIS call's input, normalized the same way `usuarioPorNombre` normalized
  // it to match — and it has to come from here, not from the row: that query does not SELECT
  // `i.external_id`, so reading it off the row yields `undefined` and `guardarCredencial` would
  // write a credential under an empty handle, making the account unfindable by name afterwards.
  // The string used for the lookup and the string written back are the same value, so this is the
  // handle the account already had — not a new one.
  const handle = normalizarNombre(nombreAcceso)

  // `guardarCredencial` keeps the old row as history and keeps the handle unclaimed, which is the
  // same write the sign-in path does — a second implementation of "change a password" is exactly the
  // drift this avoids.
  const identidadNueva = guardarCredencial(conn, fila.id, handle, password)

  return {
    ok: true,
    usuarioId: fila.id,
    identidadId: identidadNueva,
    nombreAcceso: handle,
    nombre: fila.nombre,
    rol: fila.rol
  }
}

/**
 * What the tool can act on, for `--listar` and for the refusal messages.
 *
 * Handles only, and only ones with a live credential: this prints what can be RESET, not a roster
 * of the shop's staff. A person who has file access can read the whole table anyway; printing the
 * roster would be for the person who has it and forgets a name.
 */
export function cuentasReseteables(conn) {
  const negocio = negocioUnico(conn)
  if (!negocio || negocio.multiple) return []
  return conn.db
    .prepare(
      `SELECT i.external_id AS nombreAcceso, u.nombre, u.rol
         FROM user_identidades i
         JOIN users u ON u.id = i.user_id
        WHERE i.provider = ?
          AND i.activo = 1 AND i.deleted_at IS NULL
          AND u.activo = 1 AND u.deleted_at IS NULL
          AND u.negocio_id = ?
        ORDER BY i.external_id`
    )
    .all(PROVIDER_LOCAL, negocio.id)
}