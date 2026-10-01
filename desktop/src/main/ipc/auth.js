/**
 * THE `auth` GROUP — all five contract operations, none of them 501 any more.
 *
 * Every handler here takes `{ conn, session }` instead of `{ conn }`, because `auth.login`,
 * `auth.register` and `auth.logout` all change WHO is on the till and that state is not in the
 * database. It is in the main process, in memory, and it is deliberately not reachable from a
 * payload.
 *
 * WHY `me` NO LONGER READS A FILE-DERIVED IDENTITY. It used to answer from `ctx.actorId`, which
 * `installIpc` filled from `resolveLocalIdentity` at startup — the operator was a fact about the
 * file, so anybody who opened the file was the operator. That was correct while there was no
 * password, and it is the thing this feature replaces. `me` now answers from the session, which
 * is empty until somebody signs in, and an empty session is the signal the renderer uses to
 * show the sign-in panel.
 */
import { login, logout, me, registrar, changePassword } from '../auth/auth.service.js'
import { createSession } from '../auth/session.js'

export function registerAuthHandlers(registry, { conn, session }) {
  // A test that calls the registry without a session still gets a working, permanently-empty
  // one rather than a TypeError: an absent session must mean "nobody is signed in", never
  // "the auth group is unavailable".
  const sesion = session || createSession(conn)

  registry.register('auth', {
    /**
     * `auth.me` — the signed-in person, their business, and who else could take the till.
     * `null` when nobody is signed in, which is a state the shell renders as the sign-in panel
     * and NOT as an error.
     */
    me: () => me(conn, sesion),

    /**
     * `auth.login` — sign in. ALSO the handover: when somebody is already on the till, this
     * replaces them, and the password it verifies is the INCOMING person's. That is the entire
     * mechanic, and it is why no escalation path exists without typing something.
     */
    login: (payload) => login(conn, sesion, payload),

    /**
     * `auth.register` — with no session, the first launch: the business and its owner. With a
     * session, the owner adding an employee. The branch is decided by the session, never by a
     * parameter in the payload.
     */
    register: (payload) => registrar(conn, sesion, payload),

    /**
     * `auth.changePassword` — own password, and only with the current one.
     */
    changePassword: (payload) => changePassword(conn, sesion, payload),

    /**
     * `auth.logout` — end the session, and the panel comes back. Nothing is persisted, so the
     * next launch is signed out too.
     */
    logout: () => logout(sesion)
  })

  return registry
}
