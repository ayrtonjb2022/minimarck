/**
 * S0 runtime spike — THE abort criterion for the whole desktop change.
 *
 * Design §0.4 proved on paper that electron@44.4.5 bundles Node v24.21.0 and that
 * `setAuthorizer` (Node 24.10.0), `enableDefensive` (24.12.0) and `backup()` (23.8.0)
 * all exist there. Paper is not a build. This script runs UNDER ELECTRON and asserts
 * the real runtime, so a wrong pin is discovered on day one, not day forty.
 *
 * It MUST be run with `npm run spike` (i.e. `electron ...`), never with system node:
 * the whole point is Electron's bundled Node, not whatever nvm happens to have active.
 *
 * THE ABORT QUESTION, in one line: does electron@44.4.5 ship a working, stable
 * `node:sqlite`, so this project needs no native rebuild, no node-gyp, no
 * `better-sqlite3` and no prebuilt binaries? If any assertion below fails, the answer
 * is NO, design §H.1 is false, §E must be rewritten around `VACUUM INTO`, and no later
 * slice is safe to review.
 *
 * CORRECTION vs the S0 slice profile: the profile said to assert that
 * `DatabaseSync.prototype` carries `backup`. It does not, and never did. `backup` is a
 * MODULE-LEVEL export (`backup(sourceDb, destinationPath)` -> Promise), exactly as
 * design §0.4 recorded. `setAuthorizer` and `enableDefensive` ARE prototype methods.
 * The profile's sentence conflated the two surfaces; design §0.4 was right.
 *
 * Pass = exit 0. Fail = exit 1 with the missing capability named.
 */
import { DatabaseSync, backup } from 'node:sqlite'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const results = []
const fail = (msg) => results.push({ ok: false, msg })
const pass = (msg) => results.push({ ok: true, msg })

// ---------------------------------------------------------------- 1. real versions
// Report what Electron ACTUALLY gave us, never what the design predicted.
const nodeVersion = process.versions.node
const chromeVersion = process.versions.chrome
const electronVersion = process.versions.electron
const sqliteVersion = process.versions.sqlite

console.log('=== S0 node:sqlite runtime spike (under Electron) ===')
console.log(`electron       : ${electronVersion}`)
console.log(`node (bundled) : ${nodeVersion}`)
console.log(`chrome         : ${chromeVersion}`)
console.log(`sqlite (lib)   : ${sqliteVersion}`)

if (electronVersion === '44.4.5') pass(`electron pin is 44.4.5`)
else fail(`electron pin drifted to ${electronVersion}; the API surface below is pinned to 44.4.5`)

// ------------------------------------------------- 2. the three design capabilities
// Two are DatabaseSync instance methods; `backup` is a module export. Assert each on
// the surface where it actually lives.
for (const m of ['setAuthorizer', 'enableDefensive']) {
  if (typeof DatabaseSync.prototype[m] === 'function') pass(`DatabaseSync.prototype.${m} present`)
  else fail(`MISSING DatabaseSync.prototype.${m}`)
}
if (typeof backup === 'function' && backup.length === 2) pass('module export backup() present, arity 2')
else fail(`module export backup() missing or wrong arity (got ${typeof backup}, length ${backup?.length})`)

// ------------------------------------ 3. a real DB file, table, insert, read back
// Plus the two claims design §C.5 rests on: WAL is actually applied, and a committed
// write is visible from a SECOND independent read handle.
// `MINIMARCK_SPIKE_TMP` is set by `scripts/spike.mjs`, which created it with the PARENT process's
// `mkdtempSync`. The fallback below is the original behaviour and still correct on a developer
// machine; the override exists because an Electron main process cannot always create an entry
// directly inside `%TEMP%` — it answers EPERM on a shell with no interactive desktop session, and
// the gate is run from exactly that kind of shell. See `scripts/electron-runner.mjs`.
//
// `dirEsPropio` decides who cleans up, and it has to be the same decision in both directions: an
// Electron main process can create an entry INSIDE a directory it was given but cannot REMOVE one
// from `%TEMP%`, so a handed-over directory is deleted by the parent that created it. A `finally`
// that tried anyway threw EPERM out of the cleanup, Electron's default app swallowed it as "threw
// an error during load", and the process then sat there forever with no exit code — a gate that
// cannot report a failure is a gate that proves nothing.
const dir = process.env.MINIMARCK_SPIKE_TMP || mkdtempSync(join(tmpdir(), 'mm-spike-'))
const dirEsPropio = !process.env.MINIMARCK_SPIKE_TMP
const file = join(dir, 'spike.db')
const backupFile = join(dir, 'spike-backup.db')
try {
  const writer = new DatabaseSync(file)
  writer.exec('PRAGMA journal_mode = WAL')
  const mode = writer.prepare('PRAGMA journal_mode').get().journal_mode
  if (String(mode).toLowerCase() === 'wal') pass('journal_mode = WAL')
  else fail(`journal_mode is ${mode}, expected wal`)

  writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
  writer.prepare('INSERT INTO t (id, name) VALUES (?, ?)').run(1, 'minimarck')
  const viaWriter = writer.prepare('SELECT name FROM t WHERE id = ?').get(1)
  if (viaWriter?.name === 'minimarck') pass('create table + insert + read back on writer handle')
  else fail(`writer read-back wrong: ${JSON.stringify(viaWriter)}`)

  // Second, independent handle: the committed row is durable and concurrently visible.
  // This is exactly the WAL property §C.5 depends on to replace SELECT ... FOR UPDATE.
  const reader = new DatabaseSync(file)
  const viaReader = reader.prepare('SELECT name FROM t WHERE id = ?').get(1)
  if (viaReader?.name === 'minimarck') pass('row visible from a second read handle (WAL concurrency)')
  else fail(`second handle read wrong: ${JSON.stringify(viaReader)}`)
  reader.close()

  // backup() must actually RUN, not merely exist: S15's whole engine is built on it.
  await backup(writer, backupFile)
  if (existsSync(backupFile)) {
    const restored = new DatabaseSync(backupFile)
    const row = restored.prepare('SELECT name FROM t WHERE id = ?').get(1)
    restored.close()
    if (row?.name === 'minimarck') pass('backup() produced a readable file containing the committed row')
    else fail(`backup() file unreadable or empty: ${JSON.stringify(row)}`)
  } else {
    fail('backup() did not produce a file')
  }

  writer.close()
  if (existsSync(file)) pass('database file created on disk')
  else fail('database file not created on disk')

  // Enumerate the real surface so the record is exact, not inferred.
  console.log('--- actual node:sqlite surface under Electron ---')
  console.log(`module exports    : ${Object.keys(await import('node:sqlite')).sort().join(', ')}`)
  console.log(`DatabaseSync.proto: ${Object.getOwnPropertyNames(DatabaseSync.prototype).sort().join(', ')}`)
  console.log(`spike dir contents: ${readdirSync(dir).sort().join(', ')}`)
} catch (e) {
  fail(`sqlite file operation threw: ${e && e.message}`)
} finally {
  if (dirEsPropio) rmSync(dir, { recursive: true, force: true })
}

console.log('--- results ---')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.msg}`)
const failed = results.filter((r) => !r.ok)
console.log(`=== ${results.length - failed.length}/${results.length} passed; electron node=${nodeVersion} ===`)

if (failed.length) {
  console.error('ABORT CRITERION TRIPPED: electron@44.4.5 does not give us the node:sqlite this design assumes.')
  console.error('Re-design around better-sqlite3 + VACUUM INTO; design §H.1 and §E are invalid as written.')
  process.exit(1)
}
console.log('ABORT CRITERION CLEARED: no native rebuild, no node-gyp, no better-sqlite3, no prebuilt binaries.')
process.exit(0)
