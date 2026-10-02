/**
 * THE LAUNCHER, AS A PROCESS — because every one of its interesting failures happened OUTSIDE the
 * functions a unit test can call.
 *
 * These tests spawn the real script. That is deliberate and not a shortcut: the bugs this file
 * exists for were all invisible to a unit test of `parsear` or `leerPassword`, because they were
 * about what the surrounding PROCESS does.
 *
 *   - `npm run … -- --user dueña` silently did NOTHING. Not an error: npm swallowed `--user` as its
 *     own configuration and the tool exited 2 with a usage message that did not say so. A unit test
 *     of the parser passes forever while the documented command does nothing.
 *   - `echo clave.txt | …` HUNG after printing the prompt, because `readline.question` waits for a
 *     newline that a file written with `-NoNewline` never sends. "Did not return" is not something
 *     an assertion on a resolved value can notice.
 *   - Exit codes are the interface. "it failed" and "there is no database here" and "you gave me a
 *     password on the command line" have to be told apart by a script, so the numbers are asserted.
 *
 * The password-refusal test also asserts the secret is ABSENT FROM THE OUTPUT, which is the property
 * that matters and the one a "does it throw" test cannot see.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { tienda } from '../db/fixtures/tienda.js'
import { openDatabase } from '../../src/main/db/connection.js'
import { createSession } from '../../src/main/auth/session.js'
import { login } from '../../src/main/auth/auth.service.js'
import { guardarCredencial } from '../../src/main/auth/identities.repo.js'

const SCRIPT = path.resolve(process.cwd(), 'scripts', 'auth-reset-admin.mjs')
const VIEJA = 'LaViejaDePrueba2026'
const NUEVA = 'LaNuevaDePrueba2026'
const TIMEOUT_MS = 30000

let t
let perfil
/** Empty APPDATA, so the tool's real-profile fallback can never find this machine's shop. */
let vacioAppdata

beforeEach(() => {
  t = tienda()
  vacioAppdata = mkdtempSync(path.join(tmpdir(), 'mm-appdata-'))
  guardarCredencial(t.conn, t.usuarioId, 'dueño', VIEJA)
  t.conn.checkpointAndClose()
  // The tool looks for <base>/data/minimarck.db, so the shop gets the shape it has on a machine.
  perfil = mkdtempSync(path.join(tmpdir(), 'mm-perfil-'))
  mkdirSync(path.join(perfil, 'data'))
  // copyFileSync, NOT writeFileSync(readFileSync(...)). The shop file is SQLite: writing it as a
  // string re-encodes every byte pair and the tool refuses it with "file is not a database" — a
  // failure in the FIXTURE that reads exactly like a failure in the tool.
  copyFileSync(t.archivo, path.join(perfil, 'data', 'minimarck.db'))
})

afterEach(() => {
  rmSync(perfil, { recursive: true, force: true })
  rmSync(vacioAppdata, { recursive: true, force: true })
  t.cerrar()
})

/**
 * Run the launcher the way a person would, and hand back what the SHELL would see: the exit code
 * and both streams. `entrada` is passed on stdin, which is the only channel the password is allowed
 * to travel through.
 */
function correr(args, { entrada = null, conTimeout = true } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    // APPDATA is pointed at an empty directory as well. The tool falls back to the REAL profile
    // when MINIMARCK_DATA_DIR has no database, and this machine has a real MiniMarck shop in it —
    // so a test that only redirected the variable would quietly reset a real account. The
    // environment is part of the isolation, not a detail.
    env: { ...process.env, MINIMARCK_DATA_DIR: perfil, APPDATA: vacioAppdata },
    input: entrada,
    encoding: 'utf8',
    // A hang must FAIL a test, not freeze the suite: the previous version of this tool hung exactly
    // here, and a test runner with no timeout would wait on it forever and say nothing.
    timeout: conTimeout ? TIMEOUT_MS : undefined
  })
  return {
    codigo: r.status,
    salida: r.stdout ?? '',
    error: r.stderr ?? '',
    senal: r.signal ?? null,
    todo: `${r.stdout ?? ''}${r.stderr ?? ''}`
  }
}

function entra(nombre, password) {
  const conn = openPara(path.join(perfil, 'data', 'minimarck.db'))
  try {
    return attempt(conn, nombre, password)
  } finally {
    conn.checkpointAndClose()
  }
}

describe('auth:reset-admin — the launcher, as a process', () => {
  it('--help exits 0 and prints how to use it', () => {
    const r = correr(['--help'])
    expect(r.codigo).toBe(0)
    expect(r.salida).toContain('Recuperación de contraseña')
    expect(r.salida).toContain('--listar')
  })

  it('with no arguments it explains itself and exits 2, rather than doing nothing quietly', () => {
    const r = correr([])
    expect(r.codigo).toBe(2)
    expect(r.error).toContain('Recuperación de contraseña')
  })

  it('refuses a password ARGUMENT, and never prints it', () => {
    // The whole point: a password on a command line is in the process list and in the shell
    // history. Asserting the code is not enough — asserting the secret is ABSENT is the property.
    for (const flag of ['--password', '--contrasena', '--clave']) {
      const r = correr([flag, NUEVA])
      expect(r.codigo).toBe(2)
      expect(r.todo).not.toContain(NUEVA)
      expect(r.error.toLowerCase()).toContain('no se acepta por argument')
    }
  })

  it('refuses `--password=valor` too, because splitting on `=` is the obvious thing to try', () => {
    const r = correr([`--password=${NUEVA}`])
    expect(r.codigo).toBe(2)
    expect(r.todo).not.toContain(NUEVA)
  })

  it('--listar exits 0 and names the account, without printing anything secret', () => {
    const r = correr(['--listar'])
    expect(r.codigo).toBe(0)
    expect(r.salida).toContain('dueño')
    expect(r.todo).not.toContain(VIEJA)
    expect(r.todo).not.toContain('secret')
  })

  it('resets a POSITIONAL handle, which is the form that survives npm', () => {
    // `npm run … -- --user dueña` does not reach the script on Windows: npm consumes `--user` as its
    // own config. So the documented form is positional, and this test is what makes that a fact
    // rather than a claim in a README.
    const r = correr(['dueño'], { entrada: `${NUEVA}\n` })
    expect(r.codigo).toBe(0)
    expect(r.salida).toContain('Contraseña restablecida')
    expect(r.todo).not.toContain(NUEVA)
  })

  it('accepts the password from a pipe with NO trailing newline', () => {
    // THE REGRESSION. `readline.question` waits for a `line` event, which needs a newline. A file
    // written with `-NoNewline` never sends one, so the tool printed its prompt and hung forever —
    // and a test that only ever piped `"${PASSWORD}\n"` would never have noticed.
    const r = correr(['dueño'], { entrada: NUEVA })
    expect(r.senal).toBeNull()
    expect(r.codigo).toBe(0)
    expect(r.salida).toContain('Contraseña restablecida')
  })

  it('the reset it performed is real: the new password signs in and the old one is rejected', () => {
    expect(correr(['dueño'], { entrada: `${NUEVA}\n` }).codigo).toBe(0)

    // Re-open the shop file the tool wrote to and ask the sign-in path itself.
    const dbFile = path.join(perfil, 'data', 'minimarck.db')
    const conn = openPara(dbFile)
    const nueva = attempt(conn, 'dueño', NUEVA)
    const vieja = attempt(conn, 'dueño', VIEJA)
    expect(nueva.entro).toBe(true)
    expect(vieja.codigo).toBe('CREDENCIALES_INVALIDAS')
    conn.checkpointAndClose()
  })

  it('an EMPTY password writes nothing and exits 2', () => {
    const r = correr(['dueño'], { entrada: '\n' })
    expect(r.codigo).toBe(2)
    expect(r.error).toContain('No se escribió nada')
    // …and the old password still works, so a mistyped attempt is not a second lockout.
    const conn = openPara(path.join(perfil, 'data', 'minimarck.db'))
    expect(attempt(conn, 'dueño', VIEJA).entro).toBe(true)
    conn.checkpointAndClose()
  })

  it('a handle nobody has exits 3 with a code, and the shop still opens for its owner', () => {
    const r = correr(['nadie'], { entrada: `${NUEVA}\n` })
    expect(r.codigo).toBe(3)
    expect(r.error).toContain('USUARIO_NO_ENCONTRADO')
    const conn = openPara(path.join(perfil, 'data', 'minimarck.db'))
    expect(attempt(conn, 'dueño', VIEJA).entro).toBe(true)
    conn.checkpointAndClose()
  })

  it('refuses two handles instead of guessing which one was meant', () => {
    const r = correr(['dueño', 'otro'], { entrada: `${NUEVA}\n` })
    expect(r.codigo).toBe(2)
    expect(r.error).toContain('sobresaron argumentos')
  })

  it('exits 5, and lists every path it looked at, when there is no database here', () => {
    // The tool checks TWO candidates: MINIMARCK_DATA_DIR and the real profile directory. This
    // machine HAS a real MiniMarck profile, so pointing only the first one at an empty directory is
    // not enough — the tool would find the real shop and reset somebody's password mid-test. APPDATA
    // is redirected too, so both candidates are empty and the test cannot touch a real shop.
    const vacio = mkdtempSync(path.join(tmpdir(), 'mm-vacio-'))
    const appdata = mkdtempSync(path.join(tmpdir(), 'mm-appdata-'))
    try {
      const r = spawnSync(process.execPath, [SCRIPT, 'dueño'], {
        env: { ...process.env, MINIMARCK_DATA_DIR: vacio, APPDATA: appdata },
        input: `${NUEVA}\n`,
        encoding: 'utf8',
        timeout: TIMEOUT_MS
      })
      expect(r.status).toBe(5)
      expect(r.stderr).toContain('No encontré la base de datos')
      // The message has to NAME the paths, or a person with a relocated shop cannot tell what to
      // put in MINIMARCK_DATA_DIR. A generic "not found" is the one answer that helps nobody.
      expect(r.stderr).toContain(path.join(vacio, 'data', 'minimarck.db'))
      expect(r.stderr).toContain('MINIMARCK_DATA_DIR')
    } finally {
      rmSync(vacio, { recursive: true, force: true })
      rmSync(appdata, { recursive: true, force: true })
    }
  })

  it('says the app may be open, because a running app keeps its session', () => {
    // It cannot CHECK whether the app is running — Chromium's single-instance lock is unusable in
    // a shell with no interactive session — so it states the conditional rather than claiming a
    // check it did not do.
    const r = correr(['dueño'], { entrada: `${NUEVA}\n` })
    expect(r.error).toContain('Si MiniMarck está abierto')
  })

  it('the password never reaches the command line, by construction', () => {
    // The launcher refuses the flags; this also pins that the positional slot is the HANDLE, so a
    // password pasted where the handle goes is refused as a missing/short handle rather than
    // becoming somebody's sign-in name.
    const r = correr([NUEVA], { entrada: 'otra-cosa\n' })
    expect(r.codigo).toBe(3)
    expect(r.error).toContain('USUARIO_NO_ENCONTRADO')
  })
})

// ── helpers ────────────────────────────────────────────────────────────────────────────────────

/** Open a shop file the way the tool does: allowlisted for the two auth tables. */
function openPara(dbFile) {
  return openDatabase(dbFile, { walFile: `${dbFile}-wal`, tables: ['users', 'user_identidades'] })
}

/** Sign in through the real path and report the outcome instead of throwing. */
function attempt(conn, nombre, password) {
  try {
    const r = login(conn, createSession(conn), { nombre, password })
    return { entro: true, rol: r.rol }
  } catch (err) {
    return { entro: false, codigo: err.code }
  }
}