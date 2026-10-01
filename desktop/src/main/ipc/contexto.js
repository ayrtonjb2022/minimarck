/**
 * The request context every IPC handler receives — extracted from `installIpc` for one reason:
 * to be testable.
 *
 * `installIpc` in `src/main/index.js` is the ONLY place a `ctx` is built, and a `ctx` is the whole
 * security boundary of this app: `negocioId` and `actorId` are the tenant columns every audit
 * stamp is scoped by, so whoever fills those two fields decides who the shop thinks you are.
 * While that construction was a private function of a module that imports `electron`, there was
 * no way to assert the property the feature rests on — that a renderer cannot dictate either
 * value — because there was no way to call it outside a running Electron process.
 *
 * So the construction lives here, takes the two process-owned objects, and reads nothing else.
 * `payload` is deliberately NOT an argument. That is the whole claim: the shape of a request
 * cannot reach this function, so it cannot reach `ctx`.
 *
 * `actorId` is read PER CALL rather than captured once, which is what makes a handover take
 * effect on the next operation instead of the next launch.
 */

export function construirContexto(identity, session) {
  return {
    negocioId: identity.negocioId,
    actorId: session.actorId(),
    negocioNombre: identity.negocioNombre,
    motivo: identity.motivo
  }
}

/**
 * THE SEAM, WHERE A REAL ENVELOPE BECOMES A CONTEXT.
 *
 * WHY THIS EXISTS AS A SEPARATE FUNCTION. The first version of the attribution
 * test called `construirContexto` directly and passed a forged `user_id` to the
 * HANDLER. It passed — and proved less than it appeared to. What it really proved
 * was that handlers ignore a `user_id` in the body. It could not prove the thing
 * that matters, which is that the payload never REACHES the context, because the
 * code that turns an envelope into a context lived in `index.js`, a module that
 * imports `electron` and therefore cannot be imported by a test at all.
 *
 * A mutation proof exposed the gap rather than the test: making `construirContexto`
 * honour a payload, and handing it one at the real call site in `index.js`, left
 * all 539 tests green. The mutated branch was unreachable from any test.
 *
 * So the seam moved here, where a test can call it exactly as the app does.
 * `envelope` IS an argument now — which makes the claim checkable instead of
 * asserted: this function receives a renderer-shaped object on purpose and reads
 * NOTHING from it. `construirContexto` above still takes only the two
 * process-owned objects, and this is the only bridge between them.
 *
 * If a future change lets anything out of `envelope` reach `ctx`, the forged-envelope
 * test goes red. That is the whole point of the argument existing.
 *
 * @param {object} identity  the resolved tenant, owned by the main process
 * @param {object} session   the in-memory session, owned by the main process
 * @param {object} envelope  `{ version, group, op, payload }` straight off the wire
 */
export function contextoDesdeEnvelope(identity, session, envelope) {
  // The envelope is a parameter, not a source. Nothing below reads it, and nothing
  // below may: `negocioId` and `actorId` come from the two objects the main process owns.
  void envelope
  return construirContexto(identity, session)
}