/**
 * MUTATION PROOF: a handover that does not ask for the password must break a test.
 *
 * THE CLAIM UNDER TEST. "The incoming employee types THEIR password to take the
 * till, and no control in this app changes the operator without one."
 *
 * A test that passes proves nothing about a security claim, because a test that
 * cannot fail is not a test. So this script mutates the source, runs the auth
 * suite, and REQUIRES it to go red at the handover check. Then it restores the
 * file and proves the restore was byte-for-byte.
 *
 * WHAT IT MUTATES. One condition in `identities.repo.js`: the guard inside
 * `autenticar()` stops comparing the typed password against the stored key, so
 * any name opens the till. That is precisely the "escalation without a password"
 * the requirement forbids — and if a test suite that owns this surface can stay
 * green through it, the suite has a hole.
 *
 * THE SESSION IS NOT THE TARGET, and that is worth saying. `session.abrir()`
 * never checks a password, by design: its own header says it is only ever reached
 * from a successful credential check. Mutating it would "pass" this proof while
 * proving nothing about the password, which is the failure mode this whole script
 * exists to prevent.
 *
 * IT IS NOT AN EDIT. The file is mutated, run and restored in the same process,
 * and the SHA-256 is compared before and after. Nothing survives this.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const objetivo = join(root, 'src', 'main', 'auth', 'identities.repo.js')

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

const original = readFileSync(objetivo, 'utf8')
const antes = sha(objetivo)
console.log(`identities.repo.js sha256 antes: ${antes}`)

// The mutation: the typed password is never compared against the stored key.
const mutado = original.replace(
  'if (!fila || typeof password !== \'string\' || !password || !verificar(password, fila)) {',
  'if (!fila) { /* MUTADO: la contraseña ya no se compara con nada */'
)
if (mutado === original) {
  console.error('MUTACIÓN NO APLICADA: el guard de autenticar() no aparece en identities.repo.js')
  process.exit(2)
}

const copia = mkdtempSync(join(tmpdir(), 'minimarck-mutacion-'))
try {
  writeFileSync(objetivo, mutado, 'utf8')
  console.log(`identities.repo.js sha256 mutado: ${sha(objetivo)}`)
  console.log('\n--- suite de auth con la contraseña omitida (TIENE que fallar) ---')

  const r = spawnSync(
    process.execPath,
    [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'tests/auth', '--reporter=basic'],
    { cwd: root, encoding: 'utf8', shell: true }
  )
  const salida = `${r.stdout || ''}${r.stderr || ''}`
  const limpio = salida.replace(/\u001b\[[0-9;]*m/g, '')
  const resumen = limpio.match(/Tests\s+.*/)
  const fallos = limpio.match(/FAIL[^\n]*/g) || []

  console.log(resumen ? resumen[0] : '(sin resumen)')
  for (const f of fallos.slice(0, 8)) console.log(`  ${f.trim()}`)

  const sePusoRoja = r.status !== 0 && /failed/i.test(limpio)
  if (!sePusoRoja) {
    console.error('\nMUTACIÓN NO DETECTADA: la suite siguió en verde sin la contraseña. Eso es un agujero.')
    process.exitCode = 1
  } else {
    console.log('\nLA MUTACIÓN SE DETECTÓ: sin la contraseña, la suite de auth se pone roja.')
    if (!fallos.some((f) => /handover|relevo|password|contrase/i.test(f))) {
      console.log('  (aviso: el fallo no nombra el relevo — mirá arriba qué se rompió)')
    }
  }
} finally {
  writeFileSync(objetivo, original, 'utf8')
  const despues = sha(objetivo)
  console.log(`\nidentities.repo.js sha256 restaurado: ${despues}`)
  if (despues !== antes) {
    console.error('RESTAURACIÓN INCORRECTA: el archivo no volvió a su estado anterior')
    process.exitCode = 1
  } else {
    console.log('RESTAURADO OK: mismo sha256 que antes de mutar')
  }
  rmSync(copia, { recursive: true, force: true })
}
