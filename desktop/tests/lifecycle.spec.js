import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../src/main/db/connection.js'
import { handleSecondInstance, planRendererRecovery, runBeforeQuit } from '../src/main/lifecycle.js'

/**
 * PLAT-4, PLAT-5, PLAT-6.
 *
 * These are the requirements that were previously an empty comment in `index.js`, so the point
 * of this file is that a rule nobody could reach is now a rule a test reaches. Each test drives
 * the SAME function `index.js` calls — not a reimplementation of it.
 */

let base
let dbFile
let walFile

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'mm-lifecycle-'))
  dbFile = path.join(base, 'minimarck.db')
  walFile = path.join(base, 'minimarck.db-wal')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('PLAT-4: a second launch focuses, never opens a second window', () => {
  it('restores a minimised window and focuses it', () => {
    const win = { isMinimized: () => true, restore: vi.fn(), focus: vi.fn() }
    const out = handleSecondInstance({ getWindows: () => [win] })
    expect(out).toEqual({ focused: true })
    expect(win.restore).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(1)
  })

  it('focuses an already-visible window without a pointless restore', () => {
    const win = { isMinimized: () => false, restore: vi.fn(), focus: vi.fn() }
    handleSecondInstance({ getWindows: () => [win] })
    expect(win.restore).not.toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalledTimes(1)
  })

  it('reports no_window instead of throwing when the first window is gone', () => {
    expect(handleSecondInstance({ getWindows: () => [] })).toEqual({
      focused: false,
      reason: 'no_window'
    })
  })
})

describe('PLAT-5: a crashed renderer is an unknown outcome, not a failed call', () => {
  it('re-reads state and NEVER replays the failed call', () => {
    // The whole requirement: replaying a mutation whose response never arrived can duplicate
    // a COMMITTED sale. S4's idempotency key is what makes replay safe; until then, don't.
    const plan = planRendererRecovery({ reason: 'crashed', exitCode: 9 })
    expect(plan.retryFailedCall).toBe(false)
    expect(plan.steps.map((s) => s.step)).toEqual([
      'log',
      'reread_state',
      'reconcile',
      'reopen_window'
    ])
    const reread = plan.steps.find((s) => s.step === 'reread_state')
    expect(reread.retryFailedCall).toBe(false)
  })

  it('does not claim to run reconcile while S17 has not implemented it', () => {
    const plan = planRendererRecovery({ reason: 'crashed' })
    const step = plan.steps.find((s) => s.step === 'reconcile')
    expect(step.run).toBe(false)
  })

  it('marks reconcile as running when a reconcile function is supplied', () => {
    const plan = planRendererRecovery({ reason: 'crashed', reconcile: () => ({ status: 'clean' }) })
    expect(plan.steps.find((s) => s.step === 'reconcile').run).toBe(true)
  })

  it('carries the reason and exit code through to the log', () => {
    const plan = planRendererRecovery({ reason: 'oom', exitCode: -2147483648 })
    expect(plan.reason).toBe('oom')
    expect(plan.exitCode).toBe(-2147483648)
    expect(plan.steps[0].detail).toEqual({ reason: 'oom', exitCode: -2147483648 })
  })
})

describe('PLAT-6: before-quit checkpoints and closes', () => {
  it('checkpoints the WAL to zero bytes and closes the connection', () => {
    const conn = openDatabase(dbFile, { walFile, tables: ['t'] })
    conn.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    conn.db.exec('PRAGMA wal_autocheckpoint = 0')
    conn.db.prepare('INSERT INTO t (id) VALUES (1)').run()

    const report = runBeforeQuit({ conn })

    expect(report.checkpointed).toBe(true)
    expect(report.closed).toBe(true)
    expect(report.openRegister).toBe(false)
    expect(report.walBytesAfter).toBe(0)
    expect(conn.isOpen()).toBe(false)
  })

  it('WARNS when a cash register is still open (S4 supplies the predicate)', () => {
    // Closing the database under an open register is an accounting problem, not a technical
    // one, so it must be visible rather than silent.
    const conn = openDatabase(dbFile, { walFile })
    const warn = vi.fn()
    const report = runBeforeQuit({ conn, hasOpenRegister: () => true, warn })
    expect(report.openRegister).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/open cash register/i))
    expect(conn.isOpen()).toBe(false)
  })

  it('still closes when the open-register check itself throws', () => {
    const conn = openDatabase(dbFile, { walFile })
    const warn = vi.fn()
    const report = runBeforeQuit({
      conn,
      hasOpenRegister: () => { throw new Error('S4 marker unreadable') },
      warn
    })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/open-register check failed/i))
    // A broken check must not leak the database open.
    expect(report.closed).toBe(true)
    expect(conn.isOpen()).toBe(false)
  })

  it('warns instead of throwing when there is no connection at all', () => {
    const warn = vi.fn()
    const report = runBeforeQuit({ conn: null, warn })
    expect(report.closed).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no open database connection/i))
  })

  it('reports rather than crashes when a close fails', () => {
    const conn = openDatabase(dbFile, { walFile })
    // A closed connection with the flag still claiming to be open: the pathological case a
    // defensive report has to survive.
    conn.checkpointAndClose()
    Object.defineProperty(conn, 'isOpen', { value: () => true })
    const warn = vi.fn()
    const report = runBeforeQuit({ conn, warn })
    expect(report.closed).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not closed cleanly/i))
  })

  it('is safe to call twice — quit handlers can fire more than once', () => {
    const conn = openDatabase(dbFile, { walFile })
    expect(runBeforeQuit({ conn }).closed).toBe(true)
    expect(runBeforeQuit({ conn }).closed).toBe(false)
  })
})
