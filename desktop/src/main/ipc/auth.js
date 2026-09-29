/**
 * `auth.me` — and nothing else in this group.
 *
 * WHY THIS FILE IS CALLED auth.js WHEN THERE IS NO AUTHENTICATION. The name belongs to the
 * CONTRACT, not to the app: `auth.me` was the web's "who am I" call, and the vendored shell still
 * asks it to render the operator's name in the avatar. It is the right operation for the
 * question, so it is the one the desktop answers.
 *
 * WHY THERE IS NO LOGIN. Decision #275 removed authentication from the desktop: no password, no
 * session, no token. A shop's till machine belongs to one shop and one operator, and a login
 * screen on a machine that boots straight into the register is a speed bump with no security
 * value behind it — anyone who can open the app can read the file, whatever the password was.
 * The `users` row is not a credential here; it is the name stamped on audit rows and journal
 * entries so a sale says WHO rang it up.
 *
 * Consequently `login`, `register`, `changePassword` and `logout` have NO handler in this build
 * and answer NOT_IMPLEMENTED (501). That is not an omission to be filled in later — a desktop
 * that grows a login is a different product decision, and this one records that the four are
 * refused on purpose. `logout` in particular has nowhere to go: there is no session to end, and
 * the vendored Navbar does not render a "Cerrar sesión" control rather than render one that
 * cannot do anything.
 *
 * WHAT IT RETURNS, AND WHAT IT RETURNS WHEN THERE IS NOBODY. `{negocioId, actorId, negocioNombre,
 * operadorNombre, rol, motivo}` straight out of the request context, which `installIpc` builds
 * from `resolveLocalIdentity`. A file whose identity did not resolve answers `null`, not a 500:
 * "this database has no operator" is a state the shell can render, and the actionable sentence
 * for it was already written to main's log at startup by `identityWarning`. This handler adds no
 * second, different diagnosis.
 */
export function registerAuthHandlers(registry, { conn }) {
  registry.register('auth', {
    /**
     * The operator on duty and the business they work for. `null` when the file has no
     * resolvable identity — see the header for why that is a value and not an error.
     */
    me: (_payload, reqCtx) => {
      if (!reqCtx?.actorId || !reqCtx?.negocioId) return null
      // Re-read the row instead of echoing the context. The context is a snapshot taken at
      // startup; if the operator is deactivated while the app is open, this answers with the
      // truth rather than with a name that no longer exists.
      const fila = conn.db
        .prepare(
          `SELECT u.id, u.nombre, u.rol, u.negocio_id, n.nombre AS negocio_nombre
             FROM users u
             JOIN negocios n ON n.id = u.negocio_id
            WHERE u.id = ? AND u.negocio_id = ? AND u.activo = 1 AND u.deleted_at IS NULL`
        )
        .get(reqCtx.actorId, reqCtx.negocioId)
      if (!fila) return null
      return {
        id: fila.id,
        nombre: fila.nombre,
        rol: fila.rol,
        negocioId: fila.negocio_id,
        negocioNombre: fila.negocio_nombre,
        email: null
      }
    }
  })

  return registry
}
