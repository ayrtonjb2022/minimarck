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