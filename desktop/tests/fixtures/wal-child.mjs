/**
 * Child process for the PLAT-6 WAL durability proof.
 *
 * WHY A SEPARATE PROCESS, and not another in-process test:
 *
 * The claim being proven is about a file on disk AFTER a process exits. Every in-process
 * assertion runs while the same `DatabaseSync` handle is still open, which means the WAL
 * contents are still reachable and the assertions are really only proving "SQLite works".
 * The actual user-facing promise is narrower and specific:
 *
 *     quit the app, copy minimarck.db to another machine, open it, and the data is there.
 *
 * That promise is only testable across an exit boundary and against a copy with NO sidecars.
 * So: this script writes and quits in one process, and the spec then hands a bare `.db` to a
 * second process and counts the rows. If `before-quit` did not checkpoint, the row count in
 * the second process would be 0 — not an error, a silent data loss, which is exactly the bug
 * this catches.
 *
 * Run with system `node` (not Vitest), so it is a genuine separate process.
 */
import { statSync, existsSync } from 'node:fs'
import { openDatabase } from '../../src/main/db/connection.js'
import { runBeforeQuit } from '../../src/main/lifecycle.js'

const [mode, dbFile, walFile, arg] = process.argv.slice(2)
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

function sizeOf(file) {
  try {
    return existsSync(file) ? statSync(file).size : 0
  } catch {
    return 0
  }
}

if (mode === 'write') {
  const rows = Number(arg ?? 1)
  const conn = openDatabase(dbFile, { walFile, tables: ['ventas'] })
  conn.db.exec('CREATE TABLE ventas (id INTEGER PRIMARY KEY, total REAL)')
  // Autocheckpoint OFF so the frames are guaranteed to still be in the WAL when before-quit
  // runs. With the default 1000-page threshold a small insert would be folded in by SQLite
  // itself and the test would pass without the checkpoint doing anything.
  conn.db.exec('PRAGMA wal_autocheckpoint = 0')
  conn.tx(() => {
    const ins = conn.db.prepare('INSERT INTO ventas (id, total) VALUES (?, ?)')
    for (let i = 1; i <= rows; i += 1) ins.run(i, i * 10)
  })
  out({ stage: 'committed', rows, walBytesBefore: sizeOf(walFile) })
  // The REAL production quit path, not a hand-rolled close.
  out({ stage: 'quit', ...runBeforeQuit({ conn }) })
} else if (mode === 'hold') {
  // Commits, prints, then idles forever so the parent can HARD-KILL this process. Used for the
  // negative control: only a hard kill strands the -wal, because node:sqlite registers a
  // process-exit close hook and even a plain crash path ends up closing cleanly.
  const conn = openDatabase(dbFile, { walFile, tables: ['ventas'] })
  conn.db.exec('CREATE TABLE ventas (id INTEGER PRIMARY KEY, total REAL)')
  conn.db.exec('PRAGMA wal_autocheckpoint = 0')
  conn.tx(() => {
    const ins = conn.db.prepare('INSERT INTO ventas (id, total) VALUES (?, ?)')
    for (let i = 1; i <= Number(arg ?? 1); i += 1) ins.run(i, i * 10)
  })
  out({ stage: 'holding', walBytes: sizeOf(walFile) })
  setInterval(() => {}, 1000)
} else if (mode === 'read') {
  const conn = openDatabase(dbFile, { walFile, tables: [] })
  try {
    const count = conn.db.prepare('SELECT COUNT(*) AS c FROM ventas').get().c
    const sum = conn.db.prepare('SELECT COALESCE(SUM(total), 0) AS s FROM ventas').get().s
    out({ stage: 'read', count, sum })
  } catch (err) {
    out({ stage: 'read', error: err.message })
  } finally {
    runBeforeQuit({ conn })
  }
} else {
  out({ error: `unknown mode: ${mode}` })
  process.exitCode = 2
}
