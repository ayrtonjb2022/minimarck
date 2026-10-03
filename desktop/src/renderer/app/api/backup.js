import { llamar } from './ipc'

/**
 * Respaldos, over IPC — the shop's file, made survivable.
 *
 * ── WHY THIS GROUP HAS NO TENANT AND NO PAGINATION ────────────────────────────────────────────
 *
 * Every other API module pages and filters because its subject is rows of one business. This one's
 * subject is the FILE: a shop has a handful of backups, not thousands, and a backup is not scoped to
 * a business because it IS every business in the file. So `list` answers everything at once and
 * carries the directory path, which is what the screen needs to tell somebody where their backups
 * live.
 *
 * ── `restore` IS THE ONE CALL IN THIS APP WITH NO UNDO ────────────────────────────────────────
 *
 * It replaces the database every other screen is reading. Main verifies the archive first and takes
 * an automatic safety backup of the current file before it touches anything — so "undo" is one more
 * restore from `restaurado.seguridad`, which is returned for exactly that reason. Nothing in this
 * file needs to know that; it is stated here because the caller is the one that has to ask the
 * operator first.
 */
export const backupAPI = {
  /** Take a backup. Resolves to the catalog row of what was written. */
  crear: (params = {}) =>
    llamar('backup', 'create', { motivo: params.motivo ?? 'manual', nota: params.nota ?? null }),

  /** The catalog, newest first, plus the directory it lives in. */
  listar: () => llamar('backup', 'list', {}),

  /**
   * Does this archive actually restore? Answers `{ ok, motivo, checksumCoincide, migracionesOk, ... }`
   * — every part is reported rather than folded into one boolean, because "the file is intact but
   * this build cannot open it" is a different problem from "the file is truncated".
   */
  verificar: (id) => llamar('backup', 'verify', { id }),

  /**
   * Put an archive back, and reopen the database on it.
   *
   * Resolves to `{ restaurado, id, seguridad, userVersion, ventas }`. `seguridad` is the id of the
   * automatic backup taken from the state being replaced: restoring THAT is the undo.
   */
  restaurar: (id) => llamar('backup', 'restore', { id }),

  /** Keep the newest `conservar` and delete the rest. Resolves to what went and what stayed. */
  podar: (conservar = 10) => llamar('backup', 'prune', { conservar }),

  /**
   * Progress events, on the topic the preload already guards (`TOPICS` in `ipc-contract.js`).
   *
   * A backup takes seconds, and a screen with no feedback for several seconds is a screen somebody
   * clicks twice. Returns the unsubscribe function `on()` gives back, so an effect can clean up.
   */
  alProgresar: (cb) => {
    const mm = globalThis.minimarck
    // No bridge (a unit test, or a window that lost it): return a no-op unsubscribe rather than
    // throwing. A SCREEN that cannot show progress is fine; a screen that crashes without a preload
    // is not the failure this app wants to have.
    if (!mm || typeof mm.on !== 'function') return () => {}
    return mm.on('backup:progress', cb)
  }
}
