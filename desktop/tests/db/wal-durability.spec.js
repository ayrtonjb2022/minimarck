import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, copyFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * PLAT-6, proved across a real process boundary.
 *
 * This is the only test in the repo that can catch the failure the requirement exists for:
 * committed sales that are still sitting in `minimarck.db-wal` when the user quits, so copying
 * `minimarck.db` to a USB stick and opening it on another machine loses them. Nothing about
 * that is visible from inside the process that wrote the rows, which is why the reader here is
 * a SECOND process handed a `.db` with no sidecars.
 *
 * `fileURLToPath`, not `new URL(...).pathname` — the latter yields `/C:/...` on Windows, which
 * is why the child script path is resolved this way (same trap already fixed in
 * `vitest.config.js` and `scripts/verify-offline.mjs`).
 */

const childPath = fileURLToPath(new URL('../fixtures/wal-child.mjs', import.meta.url))
const ROWS = 400

let base
let dbFile
let walFile
let shmFile
let writeStages
let readStage

/** Run the child and parse the newline-delimited JSON it prints. */
function runChild(...args) {
  const stdout = execFileSync(process.execPath, [childPath, ...args], {
    encoding: 'utf8',
    // A child that throws must fail the test loudly, with its stderr attached.
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 'mm-wal-'))
  dbFile = path.join(base, 'minimarck.db')
  walFile = path.join(base, 'minimarck.db-wal')
  shmFile = path.join(base, 'minimarck.db-shm')

  // Process 1: create, commit, then run the REAL before-quit path and exit.
  writeStages = runChild('write', dbFile, walFile, String(ROWS))
}, 60_000)

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('PLAT-6 WAL durability across a process boundary', () => {
  it('had real frames in the WAL before quitting, so the checkpoint had work to do', () => {
    // Guards the test itself: if the WAL were already empty, the rest of these assertions
    // would pass without PLAT-6 doing anything.
    const committed = writeStages.find((s) => s.stage === 'committed')
    expect(committed.rows).toBe(ROWS)
    expect(committed.walBytesBefore).toBeGreaterThan(0)
  })

  it('before-quit checkpointed and closed', () => {
    const quit = writeStages.find((s) => s.stage === 'quit')
    expect(quit.checkpointed).toBe(true)
    expect(quit.closed).toBe(true)
  })

  it('left NO -wal/-shm sidecars behind after the process exited', () => {
    // Measured, not assumed: on a clean close SQLite checkpoints and then DELETES both
    // sidecars, rather than leaving a zero-byte -wal. An earlier draft of this test asserted
    // "exists and is 0 bytes" and failed — the stronger, correct claim is that the main
    // database file is the only thing left in the data directory.
    expect(existsSync(walFile)).toBe(false)
    expect(existsSync(shmFile)).toBe(false)
    expect(quitWalBytes(writeStages)).toBe(0)
  })

  it('the .db is self-contained: a bare copy with NO sidecars still has every row', () => {
    // The real user workflow. Process 2 opens a copy of ONLY minimarck.db; the original
    // directory's -wal/-shm are gone, so nothing can be recovered from them.
    const bareDir = mkdtempSync(path.join(tmpdir(), 'mm-bare-'))
    const bareDb = path.join(bareDir, 'minimarck.db')
    try {
      copyFileSync(dbFile, bareDb)
      expect(existsSync(`${bareDb}-wal`)).toBe(false)
      expect(existsSync(`${bareDb}-shm`)).toBe(false)

      const stages = runChild('read', bareDb, path.join(bareDir, 'minimarck.db-wal'))
      readStage = stages.find((s) => s.stage === 'read')
      expect(readStage.error).toBeUndefined()
      expect(readStage.count).toBe(ROWS)
      expect(readStage.sum).toBe((ROWS * (ROWS + 1)) / 2 * 10)
    } finally {
      rmSync(bareDir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32')(
    'CONTROL: after a hard kill, copying only the .db LOSES EVERYTHING — the checkpoint is what prevents it',
    async () => {
      // Why this control exists at all: everything above would also pass if the WAL were
      // cleaned up by something other than our checkpoint. This is the case where it is NOT.
      //
      // Two measured facts make it work:
      //   1. A NORMAL exit never strands the -wal — node:sqlite registers a process-exit close
      //      hook, so even skipping db.close() checkpoints and removes it. A control built on
      //      "just don't close it" silently proves nothing (it did, in an earlier draft).
      //   2. A HARD KILL does strand it: the -wal is left on disk with every committed frame.
      //
      // MEASURED, and it is WORSE than this test originally claimed. The draft asserted the
      // bare copy would read "zero rows", on the assumption that only the INSERTs were still in
      // flight. In fact `CREATE TABLE` had not been checkpointed either, so a sidecar-free copy
      // does not have an empty `ventas` — it has NO `ventas` table at all, and the reader fails
      // with "no such table". The data loss is total, not row-level. The assertion below matches
      // what actually happens instead of the tidier story the author assumed.
      const ctrlDir = mkdtempSync(path.join(tmpdir(), 'mm-ctrl-'))
      const ctrlDb = path.join(ctrlDir, 'minimarck.db')
      const ctrlWal = path.join(ctrlDir, 'minimarck.db-wal')
      try {
        const child = spawn(process.execPath, [childPath, 'hold', ctrlDb, ctrlWal, String(ROWS)], {
          stdio: ['ignore', 'pipe', 'pipe']
        })
        // Wait for the child to report that it has committed.
        await new Promise((resolve, reject) => {
          let buf = ''
          child.stdout.on('data', (d) => {
            buf += d
            if (buf.includes('holding')) resolve()
          })
          child.on('error', reject)
          setTimeout(() => reject(new Error('control child never committed')), 30_000)
        })
        expect(existsSync(ctrlWal)).toBe(true)
        expect(statSync(ctrlWal).size).toBeGreaterThan(0)

        execFileSync('taskkill', ['/F', '/PID', String(child.pid)], { stdio: 'pipe' })

        // The user copies minimarck.db and nothing else.
        const bare = path.join(ctrlDir, 'copied.db')
        copyFileSync(ctrlDb, bare)
        expect(existsSync(`${bare}-wal`)).toBe(false)
        const read = runChild('read', bare, `${bare}-wal`).find((s) => s.stage === 'read')
        // The table itself is gone, so there is no count to assert — the reader errors. This is
        // the whole point of the control: without before-quit's checkpoint, the copy is a file
        // with no data and no schema in it.
        expect(read.error).toMatch(/no such table: ventas/)
        expect(read.count).toBeUndefined()
      } finally {
        rmSync(ctrlDir, { recursive: true, force: true })
      }
    },
    60_000
  )
})

function quitWalBytes(stages) {
  const quit = stages.find((s) => s.stage === 'quit')
  return quit.walBytesAfter
}
