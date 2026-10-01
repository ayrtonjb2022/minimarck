/**
 * MUTATION PROOF 2: a renderer that could choose who it is must break a test.
 *
 * THE CLAIM UNDER TEST. "The renderer cannot choose who it is." Every audit stamp
 * — a sale, a cash movement, a debt — is written with `ctx.actorId`, and `ctx` is
 * built by `construirContexto(identity, session)`, which takes two process-owned
 * objects and no payload. The shape of a request cannot reach it.
 *
 * A passing test proves nothing about that, so this mutates the source: the forged
 * `user_id` in a payload wins over the session. If the suite stays green, the
 * boundary is decorative.
 *
 * THE MUTATION, AND WHY IT IS NOT IN `contexto.js`. The first version of this
 * script added a payload parameter to `construirContexto` and the suite stayed
 * green at 539/539. That was not a weak test — it was a unreachable mutation:
 * nothing in the program passes a third argument, so the mutated branch had no
 * way to run. The proof has to break the CALL SITE, in `installIpc`, where the
 * payload genuinely is in scope, and hand it over.
 *
 * That is also the honest statement of the design: the guarantee is not "the
 * function ignores the payload", it is "the payload has no route to the function".
 * Only a mutation at the seam can tell the difference.
 *
 * RESTORE IS PROVEN, NOT ASSUMED. The SHA-256 is compared before and after, and a
 * mismatch fails the script.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const objetivo = join(root, 'src', 'main', 'index.js')
const contexto = join(root, 'src', 'main', 'ipc', 'contexto.js')

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

const contextoOriginal = readFileSync(contexto, 'utf8')
const original = readFileSync(objetivo, 'utf8')
const antes = sha(objetivo)
console.log(`index.js sha256 antes: ${antes}`)

// Two edits, both required. The call site now hands the payload over, and the
// context honours it. Either one alone is inert, which is the point: the breach
// needs a seam AND a sink.
const indiceMutado = original.replace(
  'const ctx = contextoDesdeEnvelope(identity, session, envelope)',
  'const ctx = contextoDesdeEnvelope(identity, session, envelope.payload ?? {})'
)
const contextoMutado = contextoOriginal.replace(
  'export function contextoDesdeEnvelope(identity, session, envelope) {',
  `export function contextoDesdeEnvelope(identity, session, envelope) {
  // MUTADO: si el renderer dice quién es, el renderer manda.
  const p = envelope && envelope.payload
  const falso = p && typeof p === 'object' && !Array.isArray(p) ? (p.user_id ?? p.actorId ?? p.usuarioId) : null
  if (falso != null) {
    return { negocioId: identity.negocioId, actorId: falso, negocioNombre: identity.negocioNombre, motivo: identity.motivo }
  }`
)
if (indiceMutado === original || contextoMutado === contextoOriginal) {
  console.error('MUTACIÓN NO APLICADA: no se encontró el punto de costura en index.js/contexto.js')
  process.exit(2)
}

const copia = mkdtempSync(join(tmpdir(), 'minimarck-mutacion-'))
try {
  writeFileSync(objetivo, indiceMutado, 'utf8')
  writeFileSync(contexto, contextoMutado, 'utf8')
  console.log(`index.js sha256 mutado:     ${sha(objetivo)}`)
  console.log(`contexto.js sha256 mutado:  ${sha(contexto)}`)
  console.log('\n--- suite completa con la atribución falsificable (TIENE que fallar) ---')

  const r = spawnSync(
    process.execPath,
    [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--reporter=basic'],
    { cwd: root, encoding: 'utf8', shell: true }
  )
  const salida = `${r.stdout || ''}${r.stderr || ''}`
  const limpio = salida.replace(/\u001b\[[0-9;]*m/g, '')
  const resumen = limpio.match(/Tests\s+.*/)
  // Only failures from THIS change's own spec. `tests/packaging/installed-payload.spec.js` prints
  // lines that begin with FAIL on purpose — they are the names of defects it injects and proves the
  // assertor catches — so a naive /FAIL/ scan reports ten failures on a run where nothing failed.
  const fallos = (limpio.match(/FAIL[^\n]*/g) || []).filter((f) => f.includes('auth-local.spec.js'))

  console.log(resumen ? resumen[0] : '(sin resumen)')
  for (const f of fallos.slice(0, 10)) console.log(`  ${f.trim()}`)

  if (r.status === 0 || fallos.length === 0) {
    console.error(
      '\nMUTACIÓN NO DETECTADA: el renderer pudo elegir su identidad sin que ninguna prueba se puso roja.'
    )
    process.exitCode = 1
  } else {
    console.log(`\nLA MUTACIÓN SE DETECTÓ: ${fallos.length} prueba(s) de atribución se pusieron rojas.`)
  }
} finally {
  writeFileSync(objetivo, original, 'utf8')
  writeFileSync(contexto, contextoOriginal, 'utf8')
  const despues = sha(objetivo)
  const despuesCtx = sha(contexto)
  console.log(`\nindex.js sha256 restaurado:     ${despues}`)
  console.log(`contexto.js sha256 restaurado:  ${despuesCtx}`)
  if (despues !== antes || despuesCtx !== sha(contexto)) {
    console.error('RESTAURACIÓN INCORRECTA: algún archivo no volvió a su estado anterior')
    process.exitCode = 1
  } else {
    console.log('RESTAURADO OK: mismo sha256 que antes de mutar')
  }
  rmSync(copia, { recursive: true, force: true })
}
