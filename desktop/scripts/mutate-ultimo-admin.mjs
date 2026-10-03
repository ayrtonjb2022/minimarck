/**
 * MUTATION PROOF: the last-owner rule has to be the engine's, not a function's.
 *
 * THE CLAIM UNDER TEST. "A business can never be taken to zero active owners — not by deleting
 * one, deactivating one or demoting one — and it cannot spend another business's owner to do it."
 *
 * A test that passes proves nothing about a security claim, because a test that cannot fail is not
 * a test. So this script mutates the migration twice, runs the suite that owns this rule, and
 * REQUIRES it to go red at the matching case both times. Then it restores the file and proves the
 * restore was byte-for-byte.
 *
 * ── TWO MUTATIONS, BECAUSE THERE ARE TWO CLAIMS AND ONE COVERS NEITHER ──────────────────────────
 *
 *   A. THE COUNT IS OFF BY ONE. `<= 1` becomes `<= 0`, so the triggers fire only when there are no
 *      owners left to protect — which is the one moment where refusing changes nothing. Every
 *      ordinary write is unaffected and every refusal test must go red.
 *
 *   B. THE COUNT IS PER FILE. Dropping `negocio_id = OLD.negocio_id` makes a shop with two owners
 *      borrow the other shop's owner. The happy path in every other test still passes, because they
 *      all live in one business; only the per-business case sees it.
 *
 * WHY THE MIGRATION AND NOT A `.js` FILE. The whole point of the design is that the rule is not in
 * JavaScript at all, so there is no function to weaken. Mutating a guard that nobody calls would be
 * the same green-lie `mutate-handover-password.mjs` documents, in the opposite direction.
 *
 * IT IS NOT AN EDIT. The file is mutated, run and restored in the same process, and the SHA-256 is
 * compared before and after. Nothing survives this.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const objetivo = join(root, 'src', 'main', 'db', 'migrations', '003_ultimo_admin.sql')

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

const original = readFileSync(objetivo, 'utf8')
const antes = sha(objetivo)
console.log(`003_ultimo_admin.sql sha256 antes: ${antes}`)

function correrPrueba() {
  const r = spawnSync(
    process.execPath,
    [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'tests/auth/ultimo-admin.spec.js', '--reporter=basic'],
    { cwd: root, encoding: 'utf8', shell: true }
  )
  const salida = `${r.stdout || ''}${r.stderr || ''}`.replace(/\u001b\[[0-9;]*m/g, '')
  return {
    rojo: r.status !== 0 && /failed/i.test(salida),
    resumen: (salida.match(/Tests\s+.*/) || ['(sin resumen)'])[0],
    fallos: salida.match(/FAIL[^\n]*/g) || []
  }
}

/** Apply a mutation, run the suite, restore. Returns true when the suite noticed. */
function probar(nombre, aplicar,PalabraClave) {
  const mutado = aplicar(original)
  if (mutado === original) {
    console.error(`\nMUTACIÓN NO APLICADA (${nombre}): el texto a cambiar no aparece en la migración`)
    return false
  }
  writeFileSync(objetivo, mutado, 'utf8')
  console.log(`\n--- ${nombre} — sha256 mutado: ${sha(objetivo)} ---`)
  const { rojo, resumen, fallos } = correrPrueba()
  console.log(resumen)
  for (const f of fallos.slice(0, 6)) console.log(`  ${f.trim()}`)
  writeFileSync(objetivo, original, 'utf8')

  if (!rojo) {
    console.error(`  MUTACIÓN NO DETECTADA (${nombre}): la suite siguió en verde. Eso es un agujero.`)
    return false
  }
  if (!fallos.some((f) => new RegExp(PalabraClave, 'i').test(f))) {
    console.error(`  el fallo NO nombra ${PalabraClave}: revisá arriba qué se rompió`)
    return false
  }
  console.log(`  DETECTADA, y el fallo cae en ${PalabraClave}.`)
  return true
}

let fallo = 0

try {
  // A. THE COUNT IS OFF BY ONE. Both triggers, because one of the two alone would still leave the
  // other two actions unprotected — and a half-mutated rule passing is the exact shape this script
  // exists to catch.
  if (!probar(
    'A. `<= 1` pasa a ser `<= 0`: la regla sólo dispara cuando ya no queda nadie que proteger',
    (t) => t.replaceAll(') <= 1', ') <= 0'),
    'owner|dueño|admin'
  )) fallo = 1

  if (!probar(
    'B. el conteo pasa a ser por archivo y no por negocio',
    (t) => t.replaceAll('        WHERE negocio_id = OLD.negocio_id\n          AND rol', '        WHERE rol'),
    'business|negocio|owner|dueño'
  )) fallo = 1
} finally {
  writeFileSync(objetivo, original, 'utf8')
  const despues = sha(objetivo)
  console.log(`\n003_ultimo_admin.sql sha256 restaurado: ${despues}`)
  if (despues !== antes) {
    console.error('RESTAURACIÓN INCORRECTA: el archivo no volvió a su estado anterior')
    fallo = 1
  } else {
    console.log('RESTAURADO OK: mismo sha256 que antes de mutar')
  }
}

process.exitCode = fallo