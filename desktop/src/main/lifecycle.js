/**
 * Electron lifecycle, kept OUT of `index.js` so it is reachable from tests.
 *
 * Three requirements live here, and the separation is the point: `index.js` is the only module
 * that talks to the real `app`, and it does that with a handful of one-line registrations. Every
 * decision — what to do on a second launch, what a crashed renderer means, what happens to the
 * database on quit — is a pure or injectable function below, so it can be tested without booting
 * Electron. A lifecycle rule that can only be proven by launching the app is a lifecycle rule
 * that will silently regress.
 */

/**
 * PLAT-4 — a second launch focuses the first window instead of opening a second one.
 *
 * Two windows on one SQLite file is the corruption path this whole slice is built to prevent:
 * both windows would hold their own connection, and `BEGIN IMMEDIATE` makes one of them fail
 * with SQLITE_BUSY rather than interleave writes. Focusing is not a UX nicety here, it is the
 * enforcement.
 */
export function handleSecondInstance({ getWindows = () => [], focus = true } = {}) {
  const [win] = getWindows()
  if (!win) return { focused: false, reason: 'no_window' }
  if (win.isMinimized?.()) win.restore()
  if (focus) win.focus()
  return { focused: true }
}

/**
 * PLAT-5 — the renderer crashed.
 *
 * The design rule is "main re-reads the database instead of re-invoking the failed call", and
 * the reason is the thing worth stating: a crashed renderer is an UNKNOWN outcome, not a failed
 * one. `ventas.crear` may have committed 200 lines and died on the way back. Re-invoking it
 * silently duplicates the sale; SALE-2 (idempotency key) is what makes a replay safe, and until
 * that key exists the correct behaviour is to re-READ, re-open the window and let the operator
 * see the committed state.
 *
 * So `retryFailedCall` is `false` unconditionally. It is returned as data rather than left as
 * an omission so the test can assert the decision exists and is negative — an absent line of
 * code is not the same as a rejected one.
 */
export function planRendererRecovery({ reason = 'crashed', exitCode = null, reconcile } = {}) {
  const steps = [
    { step: 'log', detail: { reason, exitCode } },
    // Re-read, never re-send. See above.
    { step: 'reread_state', retryFailedCall: false },
    // S17 owns reconcile; until then `reconcile` is absent and the step is recorded as skipped
    // rather than silently omitted.
    { step: 'reconcile', run: typeof reconcile === 'function', result: null },
    { step: 'reopen_window' }
  ]
  return Object.freeze({
    reason,
    exitCode,
    retryFailedCall: false,
    steps: Object.freeze(steps.map(Object.freeze))
  })
}

/**
 * PLAT-6 — checkpoint and close the database before the process exits.
 *
 * Runs on `before-quit`, which is the last point where the main process still owns the
 * connection. A `writable` sqlite file after an abrupt exit is NOT corrupt — that is the entire
 * point of WAL — but it IS incomplete: without a checkpoint, every row committed since the last
 * auto-checkpoint lives in `minimarck.db-wal`, and copying `minimarck.db` to another machine
 * loses them. `PRAGMA wal_checkpoint(TRUNCATE)` then `close()` makes the single file complete.
 *
 * `hasOpenRegister` warns before closing. S4 adds the caja (cash drawer): closing a database
 * under an open register is a real accounting problem, not a technical one, so the hook exists
 * now and the predicate arrives with the feature.
 */
export function runBeforeQuit({
  conn,
  hasOpenRegister = () => false,
  log = () => {},
  warn = () => {}
} = {}) {
  const report = { openRegister: false, checkpointed: false, closed: false, walBytesAfter: null }

  try {
    report.openRegister = Boolean(hasOpenRegister())
  } catch (err) {
    warn(`[lifecycle] open-register check failed: ${err.message}`)
  }
  if (report.openRegister) {
    warn('[lifecycle] Closing with an open cash register. The S4 register must be closed first.')
  }

  if (!conn || typeof conn.checkpointAndClose !== 'function') {
    warn('[lifecycle] before-quit: no open database connection; nothing to checkpoint.')
    return report
  }

  const result = conn.checkpointAndClose()
  report.checkpointed = result.checkpointed
  report.closed = result.closed
  report.walBytesAfter = result.walBytesAfter

  if (result.checkpointError) {
    warn(`[lifecycle] WAL checkpoint failed: ${result.checkpointError}`)
  }
  if (result.closeError) {
    warn(`[lifecycle] database close failed: ${result.closeError}`)
  }
  if (!result.closed) {
    warn('[lifecycle] database was not closed cleanly; the WAL will be recovered on next launch.')
  } else {
    // The counters in `detail` are always {0,0,0} under node:sqlite, so this logs the byte
    // evidence instead. See connection.js for the measurement.
    log(`[lifecycle] checkpointed and closed (wal ${result.walBytesBefore} -> ${result.walBytesAfter} bytes)`)
  }
  return report
}
