/**
 * PASSWORD HASHING — Node's built-in `scrypt`, no native module, no dependency.
 *
 * WHY scrypt AND NOT bcrypt/argon2. Both are better algorithms and both are native addons, and
 * this project has a hard ban on compiled code: `better-sqlite3` alone already forced a
 * `node-gyp` toolchain into the build, and shipping a binary that has to be recompiled per
 * Electron/Node/ABI is how an install breaks on a machine that is not the developer's.
 * `crypto.scrypt` is memory-hard, is in the standard library, and cannot drift out of step with
 * the runtime that hashes with it.
 *
 * WHAT IS STORED, AND WHAT IS NOT. `salt` is 16 random bytes per identity, hex encoded.
 * `secret` is the 64-byte scrypt-derived key, hex encoded. The plaintext password is an
 * argument to `scryptSync` and is never written anywhere — not to the database, not to a log,
 * not to an error message. There is a test that greps the database FILE for the literal
 * password, and a test that asserts no `console` call in this module's callers receives it.
 *
 * WHY THE PARAMETERS ARE STORED PER IDENTITY AND NOT HARD-CODED AT VERIFY TIME. The cost of
 * hashing is a policy that will change; a hash recorded under the 2026 policy must stay
 * verifiable under the 2029 one. `parametros` is JSON `{N, r, p, keylen}`, read back when
 * verifying, and `auth.login` re-derives and re-stores the secret when it sees parameters older
 * than the current policy. Verify with the parameters that HASHED the secret; store with the
 * parameters that are current.
 *
 * WHY `timingSafeEqual` AND NOT `===`. A byte-by-byte string compare returns at the first
 * differing byte, so how long a comparison takes leaks how much of the guess was right. That is
 * a real signal against an offline attacker with a word list, and it costs one import to close.
 * `timingSafeEqual` throws if the two buffers are different lengths, so both sides are compared
 * against a same-length expected value: a length mismatch is reported as a mismatch, and the
 * DERIVED KEYS are always the same length by construction, which is the case that matters.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * The current cost policy. N=16384 (2^14), r=8, p=1 is the OWASP-recommended floor for
 * scrypt and costs roughly 100ms and 16MB on the hardware a till machine actually has.
 * These are DEFAULTS for a new identity, never for verifying an existing one.
 */
export const PARAMETROS_ACTUALES = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 })

/** Bytes of random salt per identity. 16 is the usual floor and is what the policy above assumes. */
export const BYTES_SAL = 16

/**
 * Reject a password the app must not accept, before it is ever hashed.
 *
 * The floor is 8 characters because this is a till machine where a password is typed by a
 * person standing at a counter, often with wet hands, in a hurry — a policy that demands a
 * symbol forces it to be written on a card taped next to the machine, which is a worse outcome
 * than a slightly weaker password. The CEILING exists for a different reason: scrypt input is
 * copied into a kernel buffer, so an unbounded string is a memory-growth vector.
 */
export const MIN_PASSWORD = 8
export const MAX_PASSWORD = 200

function politicaValida(p) {
  return (
    p &&
    Number.isSafeInteger(p.N) && p.N > 1 && (p.N & (p.N - 1)) === 0 &&
    Number.isSafeInteger(p.r) && p.r > 0 &&
    Number.isSafeInteger(p.p) && p.p > 0 &&
    Number.isSafeInteger(p.keylen) && p.keylen >= 16 && p.keylen <= 1024
  )
}

/**
 * Derive a secret for `password` under `params`, returning everything that gets persisted.
 *
 * Synchronous on purpose. This is called from an IPC handler, and a `promisify`d scrypt would
 * buy nothing here: the work is ~100ms, it runs once per sign-in, and the alternative is an
 * async repository whose every call site has to be awaited, in code that is otherwise
 * synchronous. A sign-in that takes 100ms is invisible; a code path that can interleave is a
 * class of bug nobody can test for.
 */
export function derivar(password, params = PARAMETROS_ACTUALES) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new Error(`La contraseña necesita al menos ${MIN_PASSWORD} caracteres`)
  }
  if (password.length > MAX_PASSWORD) {
    throw new Error(`La contraseña no puede pasar de ${MAX_PASSWORD} caracteres`)
  }
  const p = politicaValida(params) ? params : PARAMETROS_ACTUALES
  const salt = randomBytes(BYTES_SAL)
  const secret = scryptSync(password, salt, p.keylen, { N: p.N, r: p.r, p: p.p, maxmem: 256 * 1024 * 1024 })
  return {
    salt: salt.toString('hex'),
    secret: secret.toString('hex'),
    algoritmo: 'scrypt',
    // The parameters travel WITH the hash, JSON-encoded, because a verifier that assumed the
    // current policy would reject every hash written under a previous one.
    parametros: JSON.stringify(p)
  }
}

/**
 * True when `password` re-derives `secret` under the parameters recorded beside it.
 *
 * A missing secret, a missing salt, an unknown algorithm, or unparseable parameters are all a
 * FALSE, never a throw: a login that cannot be verified is a refused login, and a corrupt row
 * must not be able to crash the sign-in screen.
 */
export function verificar(password, { secret, salt, parametros }) {
  if (typeof password !== 'string') return false
  if (typeof secret !== 'string' || typeof salt !== 'string' || !secret || !salt) return false

  let p
  try {
    p = JSON.parse(parametros)
  } catch {
    return false
  }
  if (!politicaValida(p)) return false

  const esperado = Buffer.from(secret, 'hex')
  // A stored key of the wrong length cannot be compared at all, and a hex string that is not
  // even hex decodes to a different length. Refuse rather than pad.
  if (esperado.length !== p.keylen) return false

  let calculado
  try {
    calculado = scryptSync(password, Buffer.from(salt, 'hex'), p.keylen, {
      N: p.N,
      r: p.r,
      p: p.p,
      maxmem: 256 * 1024 * 1024
    })
  } catch {
    return false
  }
  return timingSafeEqual(esperado, calculado)
}

/** True when a stored identity was hashed under a policy weaker than the current one. */
export function necesitaRehash(parametros) {
  let p
  try {
    p = JSON.parse(parametros)
  } catch {
    return true
  }
  if (!politicaValida(p)) return true
  const actual = PARAMETROS_ACTUALES
  return p.N < actual.N || p.r < actual.r || p.p < actual.p || p.keylen < actual.keylen
}

/** Fold a sign-in name to the form stored in `external_id`: trimmed, lowercased. */
export function normalizarNombre(nombre) {
  return String(nombre ?? '').trim().toLowerCase()
}
