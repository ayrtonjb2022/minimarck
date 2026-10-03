/**
 * MUTATION PROOF 3: a till that moves without a journal entry must break a test.
 *
 * THE CLAIM UNDER TEST. "An owner-entered expense moves the drawer and the ledger in one
 * transaction, against a real expense account, without touching the money paths that already post
 * their own entry." Three separate sentences, so three separate mutations — a test that catches one
 * of them says nothing about the other two.
 *
 *   M1  the post does not happen at all
 *       → the defect this change fixes. If `reportes.cash` still says `coincide`, that report's
 *         headline assertion cannot see a drawer that outran its own account, and every number in
 *         the app built on `1.1.01` is unreliable for the same reason.
 *   M2  the post happens, against the WRONG account
 *       → `5.1.01 Costo de Mercadería Vendida` instead of `5.4.01 Otros Gastos`. This is the
 *         subtler half: the entry stays balanced, the drawer still equals `1.1.01`, and `coincide`
 *         is still `true`. Only naming the account can tell a shop's light bill from the cost of
 *         the goods it sold, and only a test that reads the account can prove it.
 *   M3  the `origen === 'manual'` guard is removed
 *       → the double-post. Sales, purchases and till closings reach this function and post their
 *         OWN entries elsewhere, so an unguarded post credits the drawer a second time against
 *         `5.4.01`, inflating expenses and reporting profit the shop did not make — while
 *         `coincide` stays true, because the drawer and `1.1.01` drift by the same amount together.
 *         `coincide` is structurally blind to this one, which is why the count assertion exists.
 *
 * RESTORE IS PROVEN, NOT ASSUMED. The SHA-256 is captured before the first mutation and compared
 * after every revert; a mismatch fails the script. (See `mutate-attribution.mjs` for why the
 * "compare against the hash of the file as it is right now" version proves nothing: `x !== x`.)
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const objetivo = join(root, 'src', 'main', 'db', 'repositories', 'cajas.repo.js')

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

const original = readFileSync(objetivo, 'utf8')
const antes = sha(objetivo)
console.log(`cajas.repo.js sha256 antes: ${antes}\n`)

const ANCLA_POST = "  if (origen === 'manual' && libro) {"
const ANCLA_CUENTA = '  const contraparte = tipo === \'ingreso\' ? CUENTA.OTROS_INGRESOS : CUENTA.OTROS_GASTOS'

/**
 * One mutation, one run, one revert. `debePonerseRojo` is the whole judgement: a mutation that
 * leaves the suite green has proved the tests do not discriminate, which is a finding about the
 * tests and not a pass.
 */
function probar({ nombre, ancla, reemplazo, specs, espera }) {
  if (!original.includes(ancla)) {
    console.error(`MUTACIÓN NO APLICADA (${nombre}): no se encontró el ancla en cajas.repo.js`)
    console.error(`  ancla: ${JSON.stringify(ancla)}`)
    process.exitCode = 1
    return false
  }
  const mutado = original.replace(ancla, reemplazo)
  writeFileSync(objetivo, mutado, 'utf8')
  console.log(`\n=== ${nombre} ===`)
  console.log(`sha256 mutado: ${sha(objetivo)}`)
  console.log(`specs: ${specs.join(' ')}`)

  const r = spawnSync(
    process.execPath,
    [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--reporter=basic', ...specs],
    { cwd: root, encoding: 'utf8', shell: true }
  )
  const limpio = `${r.stdout || ''}${r.stderr || ''}`.replace(/\u001b\[[0-9;]*m/g, '')
  const resumen = limpio.match(/Tests\s+.*/)
  const fallos = (limpio.match(/FAIL[^\n]*/g) || []).map((f) => f.trim())
  console.log(resumen ? resumen[0] : '(sin resumen)')

  let detectada = false
  for (const f of fallos.slice(0, 8)) {
    console.log(`  ${f}`)
    if (espera.every((frase) => f.includes(frase))) detectada = true
  }

  writeFileSync(objetivo, original, 'utf8')
  const despues = sha(objetivo)
  const restaurado = despues === antes
  console.log(`sha256 restaurado: ${despues} ${restaurado ? '(OK)' : '(NO COINCIDE)'}`)
  if (!restaurado) {
    console.error('RESTAURACIÓN INCORRECTA: cajas.repo.js no volvió a su estado anterior')
    process.exitCode = 1
    return false
  }

  if (!detectada) {
    console.error(`MUTACIÓN NO DETECTADA (${nombre}): la suite siguió verde donde debía ponerse roja.`)
    process.exitCode = 1
    return false
  }
  console.log(`LA MUTACIÓN SE DETECTÓ (${nombre}).`)
  return true
}

const ok = [
  // The defect itself. The `coincide` assertion is the one that has to move: the drawer falls and
  // the account does not, which is precisely the divergence the change deletes.
  probar({
    nombre: 'M1 · el movimiento manual NO se asienta',
    ancla: ANCLA_POST,
    reemplazo: '  if (false) {',
    specs: ['tests/db/reportes.spec.js', 'tests/db/caja-gasto-ledger.spec.js'],
    espera: ['reportes.cash', 'EQUALS 1.1.01 after an owner-entered expense']
  }),

  // Balanced, equal, and wrong. M1's test would pass here; only the account name can catch it.
  probar({
    nombre: 'M2 · el gasto se imputa a 5.1.01 CMV en vez de 5.4.01 Otros Gastos',
    ancla: ANCLA_CUENTA,
    reemplazo: "  const contraparte = tipo === 'ingreso' ? CUENTA.OTROS_INGRESOS : CUENTA.CMV",
    specs: ['tests/db/caja-gasto-ledger.spec.js', 'tests/db/reportes.spec.js'],
    espera: ['debits Otros Gastos, credits Caja, and balances']
  }),

  // The double-post. Run over the money paths too, because the damage lands on THEIR assertions
  // and not on the expense ones: a second entry breaks the entry counts, and inflates the income
  // statement while `coincide` stays true.
  probar({
    nombre: 'M3 · el guardia origen === manual desaparece (doble contabilización)',
    ancla: ANCLA_POST,
    reemplazo: '  if (libro) {',
    specs: ['tests/db/caja-gasto-ledger.spec.js', 'tests/db/reportes.spec.js', 'tests/db/ventas.spec.js', 'tests/db/compras.spec.js', 'tests/db/deudores.spec.js'],
    espera: ['an expense after a sale adds exactly one entry']
  })
].every(Boolean)

console.log(`\ncajas.repo.js sha256 final: ${sha(objetivo)}`)
if (sha(objetivo) !== antes) {
  console.error('EL ARCHIVO NO VOLVIÓ A SU ESTADO ANTERIOR')
  process.exitCode = 1
} else if (ok) {
  console.log('LAS TRES MUTACIONES SE DETECTARON Y EL ARCHIVO QUEDÓ EXACTAMENTE COMO ESTABA.')
} else {
  console.error('AL MENOS UNA MUTACIÓN NO FUE DETECTADA.')
  process.exitCode = 1
}
