/**
 * The context every repository receives (design §C.6).
 *
 * `{ db, tx, negocioId, actorId }` and nothing else. The value of a small surface is that a
 * repository CANNOT reach the filesystem, `app`, or Electron: it gets exactly these four
 * handles. Anything a repository needs that is not here does not belong in the data layer, and
 * the compiler-free way to prove that is to not pass it.
 *
 * A repository that needs the raw `conn` for the migration-aware allowlist asks for it by
 * import, not by being handed the connection.
 */
export function createCtx(conn, { negocioId = null, actorId = null } = {}) {
  return Object.freeze({
    db: conn.db,
    // Already a standalone arrow over the runner, so no bind is needed and the repository
    // cannot reach the connection object behind it.
    tx: conn.tx,
    negocioId,
    actorId
  })
}

/**
 * Same context, different actor. S4's audit columns (`usuario_creo`, `usuario_actualizo`) need
 * to distinguish the user who logged in from whoever opened the window, and a frozen context
 * makes that explicit instead of a mutable field on a long-lived object.
 */
export function withActor(ctx, actorId) {
  return Object.freeze({ ...ctx, actorId })
}
