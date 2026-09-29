/**
 * The local identity: which business this file belongs to, and who is operating it.
 *
 * WHY THIS FILE EXISTS — it is the missing half of `installIpc`.
 *
 * `ipc/index.js` builds every request context as `{ negocioId: null, actorId: null }` and each
 * repository calls `requireTenant(negocioId)` on the way in, so in the state that shipped, EVERY
 * business operation in the app answered `TENANT_REQUIRED`. The handlers were correct and the
 * database was correct; what was missing was the answer to "which shop?". That is a fact about
 * the FILE, not about the request, and it is what this module resolves.
 *
 * WHY IT IS NOT AN AUTHENTICATION MODULE. Decision #275 removed authentication from the desktop:
 * there is no login, no password, no session and no token. The `users` row is the operator the
 * seed created, and it is stamped on audit rows and journal entries so a sale says WHO sold it.
 * The desktop is a single-machine app whose file is the shop, so the identity is derived from the
 * file rather than from a credential. Naming it "auth" would describe a guarantee this app does
 * not make.
 *
 * WHY IT REFUSES AMBIGUITY INSTEAD OF PICKING. Every refusal below returns
 * `{ negocioId: null, actorId: null }`, and `requireTenant` then turns that into the existing,
 * already-tested `TENANT_REQUIRED`. Guessing would be worse: with two businesses in one file,
 * "take the lowest id" is a coin flip dressed as a decision, and a sale written to the wrong
 * `negocio_id` is data that has to be found and fixed by hand later. An unresolvable identity is
 * reported at startup, in a log line, before anyone can ring up a customer.
 */
import { isSchemaPresent } from './seed.js'

/**
 * Resolve the local business and operator from the open database.
 *
 * Returns `{ negocioId, actorId, negocioNombre, operadorNombre, rol, motivo }`. `negocioId` and
 * `actorId` are BOTH null together or neither: an operator without a business is not a tenant,
 * and half an identity is not usable.
 *
 * `motivo` is null on success and one of:
 *   `schema_absent`        no `negocios` table, so there is nothing to read
 *   `sin_negocio`          the schema is there and the table is empty
 *   `negocios_multiples`   more than one active business: the file needs a chosen tenant
 *   `sin_operador`         a business and no active user to stamp on its rows
 *   `operadores_multiples` several operators and no unique admin: the file needs a chosen one
 *
 * PURE w.r.t. everything except the `conn` it is handed: no Electron, no filesystem, no env.
 * That is what makes it testable against a real SQLite file.
 */
export function resolveLocalIdentity(conn) {
  const ninguno = (motivo) => ({
    negocioId: null,
    actorId: null,
    negocioNombre: null,
    operadorNombre: null,
    rol: null,
    motivo
  })

  if (!isSchemaPresent(conn)) return ninguno('schema_absent')

  const negocios = conn.db
    .prepare(
      `SELECT id, nombre FROM negocios
        WHERE activo = 1 AND deleted_at IS NULL
        ORDER BY id`
    )
    .all()

  if (negocios.length === 0) return ninguno('sin_negocio')
  if (negocios.length > 1) return ninguno('negocios_multiples')

  const negocio = negocios[0]

  // An admin is the seed's own operator, so a file with exactly one admin and any number of
  // later-added operators still resolves deterministically. `ORDER BY id` breaks a tie between
  // two admins the same way it breaks a tie between two businesses: by refusing, not by guessing.
  const operadores = conn.db
    .prepare(
      `SELECT id, nombre, rol FROM users
        WHERE negocio_id = ? AND activo = 1 AND deleted_at IS NULL
        ORDER BY id`
    )
    .all(negocio.id)

  if (operadores.length === 0) return ninguno('sin_operador')

  const admins = operadores.filter((u) => u.rol === 'admin')
  const elegido = admins.length === 1 ? admins[0] : operadores.length === 1 ? operadores[0] : null
  if (!elegido) return ninguno('operadores_multiples')

  return {
    negocioId: negocio.id,
    actorId: elegido.id,
    negocioNombre: negocio.nombre,
    operadorNombre: elegido.nombre,
    rol: elegido.rol,
    motivo: null
  }
}

/**
 * One startup line an operator can act on, or null when the identity resolved.
 *
 * KEPT SEPARATE from the resolver so the resolver stays a pure query and the wording is testable
 * on its own. It is deliberately a `console.warn` and not a thrown error: an unseeded or
 * ambiguous file is a data problem the operator has to fix, and refusing to open the window would
 * hide the one message that explains why the app is empty.
 */
export function identityWarning(identity) {
  if (!identity || identity.negocioId !== null) return null
  switch (identity.motivo) {
    case 'schema_absent':
      return '[identity] no hay esquema en la base: la app no tiene negocio ni operador. ' +
        'Si esto es una build empaquetada, las migraciones no se empaquetaron — corrá `npm run verify:migrations`.'
    case 'sin_negocio':
      return '[identity] la base no tiene ningún negocio activo: toda operación de negocio va a responder TENANT_REQUIRED.'
    case 'negocios_multiples':
      return '[identity] la base tiene más de un negocio activo. El archivo de una tienda es de una sola tienda, ' +
        'así que no se elige ninguno: toda operación va a responder TENANT_REQUIRED hasta que quede uno.'
    case 'sin_operador':
      return '[identity] el negocio no tiene ningún operador activo: las ventas necesitan un usuario para estampar la auditoría.'
    case 'operadores_multiples':
      return '[identity] el negocio tiene varios operadores y no hay un único admin: no se elige ninguno a ciegas. ' +
        'Dejá un solo admin activo, o uno solo operador.'
    default:
      return '[identity] no se pudo resolver la identidad local; el motivo no es conocido.'
  }
}
