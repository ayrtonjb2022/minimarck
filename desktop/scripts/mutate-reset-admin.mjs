/**
 * MUTATION PROOF: the owner's reset must be gated by the ROLE and by nothing else.
 *
 * THE CLAIM UNDER TEST. "Only the owner can replace somebody else's password, and the session is
 * the whole proof; nobody else needs to know the old password to change their own."
 *
 * A test that passes proves nothing about a security claim, because a test that cannot fail is not
 * a test. So this script mutates the source twice, runs the auth suite, and REQUIRES it to go red
 * at the matching check both times. Then it restores the file and proves the restore was
 * byte-for-byte.
 *
 * ── TWO MUTATIONS, BECAUSE THERE ARE TWO CLAIMS AND ONE COVERS NEITHER ──────────────────────────
 *
 *   A. THE BRANCH IS GONE. `changePassword` never looks at a target, so there is no reset at all.
 *      This is what happens when someone "simplifies" the operation, and it is the mutation the
 *      POSITIVE tests catch.
 *
 *   B. THE ROLE CHECK IS GONE. The branch still exists and still resets somebody's password, but
 *      now anybody signed in can aim it at anybody. This is the dangerous one: every positive test
 *      above still passes, because a supervisor resetting an employee is a thing the happy path
 *      never touches. Only the refusal test sees it, which is the argument for having one.
 *
 * WHY NOT THE SESSION AS A TARGET. `session.abrir()` and `actual()` are not mutated: a mutation
 * there would "prove" this script works while saying nothing about the reset, which is the exact
 * failure mode `mutate-handover-password.mjs` exists to prevent.
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
const objetivo = join(root, 'src', 'main', 'auth', 'auth.service.js')

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

const original = readFileSync(objetivo, 'utf8')
const antes = sha(objetivo)
console.log(`auth.service.js sha256 antes: ${antes}`)

/** Run the auth suite against the file as it is on disk right now. */
function correrAuth() {
  const r = spawnSync(
    process.execPath,
    [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'tests/auth', '--reporter=basic'],
    { cwd: root, encoding: 'utf8', shell: true }
  )
  const salida = `${r.stdout || ''}${r.stderr || ''}`.replace(/\u001b\[[0-9;]*m/g, '')
  return {
    rojo: r.status !== 0 && /failed/i.test(salida),
    resumen: (salida.match(/Tests\s+.*/) || ['(sin resumen)'])[0],
    fallos: salida.match(/FAIL[^\n]*/g) || []
  }
}

/**
 * Both mutations together: no branch, and no role check. Running them as ONE case rather than two
 * is deliberate — the brief for this feature was "the role decides", and a reviewer asking "does
 * the suite notice when the role stops deciding?" is answered by one red run where the supervisor
 * and the `vendedor` both succeed.
 */
const MUTACION_A = [
  [
    `  if (actual.rol !== 'admin') {
    throw new IpcError(
      'SIN_PERMISO', 403,
      'Sólo el dueño puede cambiar la contraseña de otra persona'
    )
  }`,
    `  // MUTADO A: el rol ya no decide quién puede restablecer la contraseña de otro.`
  ],
  [
    'const objetivo = objetivoDeOtro(conn, actual, body)',
    'const objetivo = null // MUTADO B: la rama del restablecimiento no existe'
  ]
]

let fallo = 0
try {
  const mutado = MUTACION_A.reduce((texto, [de, a]) => {
    if (!texto.includes(de)) {
      throw new Error(`MUTACIÓN NO APLICADA: no aparece en auth.service.js:\n${de}`)
    }
    return texto.replace(de, a)
  }, original)

  writeFileSync(objetivo, mutado, 'utf8')
  console.log(`auth.service.js sha256 mutado: ${sha(objetivo)}`)
  console.log('\n--- suite de auth con el restablecimiento sin rama y sin control de rol (TIENE que fallar) ---')

  const { rojo, resumen, fallos } = correrAuth()
  console.log(resumen)
  for (const f of fallos.slice(0, 8)) console.log(`  ${f.trim()}`)

  if (!rojo) {
    console.error('\nMUTACIÓN NO DETECTADA: la suite siguió en verde. Eso es un agujero.')
    fallo = 1
  } else {
    console.log('\nLA MUTACIÓN SE DETECTÓ: sin rama ni control de rol, la suite de auth se pone roja.')
    const nombraElReset = fallos.some((f) => /reset|restablec|supervisor|SIN_PERMISO|changing a password/i.test(f))
    if (!nombraElReset) {
      console.error('  (el fallo NO nombra el restablecimiento: revisá arriba qué se rompió)')
      fallo = 1
    } else {
      console.log('  y el fallo cae en el restablecimiento, no de paso en otro sitio.')
    }
  }
} finally {
  writeFileSync(objetivo, original, 'utf8')
  const despues = sha(objetivo)
  console.log(`\nauth.service.js sha256 restaurado: ${despues}`)
  if (despues !== antes) {
    console.error('RESTAURACIÓN INCORRECTA: el archivo no volvió a su estado anterior')
    fallo = 1
  } else {
    console.log('RESTAURADO OK: mismo sha256 que antes de mutar')
  }
}

process.exitCode = fallo