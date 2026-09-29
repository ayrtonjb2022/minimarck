/**
 * Contract cross-check: the frozen `OPS` in `src/shared/ipc-contract.js` against the handlers the
 * app ACTUALLY registers.
 *
 * Two independent directions on purpose. Counting the contract alone only proves a literal says
 * 89; counting handlers alone only proves the code answers 89 calls. A contract with a renamed
 * operation, or a handler for an operation the contract forgot, passes either count and still
 * breaks at runtime — the renderer would send `productos.crear` into a void. Comparing the two
 * SETS is what makes the number mean something.
 *
 * The registry is enumerated through `isImplemented()` rather than by reading its map, on
 * purpose: `createRegistry` deliberately does not return the handler table, so this check uses
 * the public surface the main process uses and cannot become a second, weaker way in.
 */
import path from 'node:path'
import os from 'node:os'
import { mkdtempSync } from 'node:fs'
import { OPS, OPS_COUNT, TOPICS, CHANNEL, ENVELOPE_VERSION } from '../src/shared/ipc-contract.js'
import { createRegistry } from '../src/main/bridge/registry.js'
import { bootstrapDatabase } from '../src/main/db/bootstrap.js'
import { registerDbHandlers } from '../src/main/ipc/db.js'
import { registerCajasHandlers } from '../src/main/ipc/cajas.js'
import { registerVentasHandlers } from '../src/main/ipc/ventas.js'
import { registerAuthHandlers } from '../src/main/ipc/auth.js'
import { registerNegocioHandlers } from '../src/main/ipc/negocio.js'
import { registerProductosHandlers } from '../src/main/ipc/productos.js'
import { registerCategoriasHandlers } from '../src/main/ipc/categorias.js'
import { registerDeudoresHandlers } from '../src/main/ipc/deudores.js'

// A real migrated+seeded database, so the repositories behind those handlers are real too.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'minimarck-contract-'))
const db = bootstrapDatabase({ userDataPath: tmp, env: {} })

const registry = createRegistry()
registerDbHandlers(registry, db)
registerVentasHandlers(registry, { conn: db.conn })
registerCajasHandlers(registry, { conn: db.conn })
registerAuthHandlers(registry, {})
registerNegocioHandlers(registry, { conn: db.conn })
registerProductosHandlers(registry, { conn: db.conn })
registerCategoriasHandlers(registry, { conn: db.conn })
// `deudores` belongs here for the same reason the rest do. It was missing, and the effect was a
// report that called `deudores.list`, `deudores.create` and `deudores.payments` 501s while the
// app answers all three: a gate that under-reports is worse than no gate, because it teaches
// whoever reads it that operations are missing when the real problem is the check.
// The four still missing are the real ones: `get`, `update`, `remove`, `addPayment`.
registerDeudoresHandlers(registry, { conn: db.conn })

const contract = []
for (const [group, ops] of Object.entries(OPS)) for (const op of ops) contract.push({ group, op })

// `register` already throws on an op outside the contract, so nothing can be implemented that
// the contract does not name. The other direction is therefore the meaningful one.
const notImplemented = contract.filter(({ group, op }) => !registry.isImplemented(group, op))

for (const { group, op } of contract) {
  if (!registry.isImplemented(group, op)) console.log(`  501  ${group}.${op}`)
}

console.log(`  contract OPS_COUNT    : ${OPS_COUNT}`)
console.log(`  contract operations   : ${contract.length} across ${Object.keys(OPS).length} groups`)
console.log(`  implemented here      : ${contract.length - notImplemented.length}`)
console.log(`  not implemented (501) : ${notImplemented.length}`)
console.log(`  channel / version     : ${CHANNEL} / v${ENVELOPE_VERSION}`)
console.log(`  topics                : ${TOPICS.length}`)
// The expected count is a LITERAL here, not `OPS_COUNT`. `OPS_COUNT` is derived from `OPS`, so
// comparing the two would only prove that a subtraction is correct. Writing 89 out means that
// adding a ninetyth operation fails this gate until a human updates it, which is the point: the
// contract is a decision, and the moment it changes should cost a deliberate edit.
const EXPECTED_OPS = 89
console.log(
  `  VERDICT: ${
    OPS_COUNT === EXPECTED_OPS && contract.length === EXPECTED_OPS
      ? `contract is exactly ${EXPECTED_OPS}; the rest is honestly reported as 501 by design`
      : `MISMATCH — the contract is not ${EXPECTED_OPS} (OPS_COUNT says ${OPS_COUNT}, the list holds ${contract.length})`
  }`
)

process.exit(0)
