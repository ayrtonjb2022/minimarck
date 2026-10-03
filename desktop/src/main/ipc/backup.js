import { crearRespaldo, listarRespaldos, podarRespaldos, restaurarRespaldo, verificarRespaldo } from '../db/backup.js'

/**
 * The `backup.*` handlers — all five contract operations.
 *
 * ── WHY THIS GROUP DOES NOT RECEIVE A `ctx` ───────────────────────────────────────────────────
 *
 * Every other group is handed `{ conn }` and builds a request context with a tenant and an actor.
 * This one is handed the CONNECTION ITSELF and the resolved PATHS, because its subject is the file
 * rather than a table: a backup is the whole shop, and a restore replaces the file every other
 * handler is reading. Demanding a tenant here would make the one operation that has to work when the
 * data layer is misbehaving depend on resolving a business out of that data layer.
 *
 * ── `backup:progress`, THE FIRST EVENT THIS APP ACTUALLY EMITS ────────────────────────────────
 *
 * The preload has exposed `on(topic, cb)` and the contract has declared four topics since S0, and
 * until now nothing ever sent one — the subscription surface existed and was never exercised. A
 * backup is the honest first use: it is the one operation here that takes seconds instead of
 * milliseconds (SQLite copies the database file by file, block by block), and a screen with no
 * feedback for several seconds is a screen somebody clicks twice.
 *
 * The sender is passed in rather than reached for, so this file stays testable without Electron and
 * the channel name is spelled in exactly one place.
 */
export function registerBackupHandlers(registry, { conn, paths, send = () => {} }) {
  /** One progress line per operation, on the topic the preload guards. */
  const progreso = (fase, extra = {}) => {
    try {
      send('backup:progress', { fase, at: new Date().toISOString(), ...extra })
    } catch {
      // A window that went away mid-backup must not fail the backup. The event is a courtesy; the
      // operation's result is what the caller awaits.
    }
  }

  registry.register('backup', {
    /**
     * Take a backup.
     *
     * ASYNC, and the only handler in this app that is. `node:sqlite`'s `backup()` returns a promise
     * — it copies in chunks so the shop keeps selling — and `installIpc` awaits whatever a handler
     * returns, so the caller gets the catalog row rather than a pending object. Nothing else here is
     * async because everything else is synchronous SQLite; this is not a crack in that rule but the
     * one place the runtime itself is asynchronous.
     */
    create: async (payload) => {
      progreso('iniciando', { motivo: payload?.motivo ?? 'manual' })
      const fila = await crearRespaldo(conn, paths, {
        motivo: payload?.motivo ?? 'manual',
        nota: payload?.nota ?? null
      })
      progreso('listo', { id: fila.id, bytes: fila.bytes })
      return fila
    },

    /**
     * The catalog, newest first. Reads the backup directory, not the database — a restore needs to
     * be possible while the database is the thing that is wrong.
     */
    list: (_payload) => {
      const { filas, total } = listarRespaldos(paths)
      return { filas, total, backupDir: paths.backupDir }
    },

    /**
     * Does this archive actually restore?
     *
     * The expensive half of the answer (opening the file and running `integrity_check`) and the
     * important half (comparing its migration ledger against this build's) both live in the
     * repository. This handler adds nothing but the progress event, so a UI can show that something
     * is happening while a 90 MB archive is read.
     */
    verify: (payload) => {
      progreso('verificando', { id: payload?.id })
      const res = verificarRespaldo(paths, payload?.id)
      progreso('verificado', { id: res.id, ok: res.ok })
      return res
    },

    /**
     * Put an archive back. THE DESTRUCTIVE ONE.
     *
     * It verifies first, takes an automatic safety backup of the current file, swaps the database
     * and reopens the connection in place — see `backup.js#restaurarRespaldo` for why each of those
     * three steps exists and why the order is the order.
     *
     * `db:changed` IS EMITTED AFTER A SUCCESSFUL RESTORE, and it is the one place in this app where
     * that topic means exactly what its name says: every number the renderer is holding — the open
     * till, the catalogue, the reports — belongs to a database that no longer exists. A screen that
     * kept showing them would be showing another shop's day.
     */
    restore: async (payload) => {
      progreso('restaurando', { id: payload?.id })
      const res = await restaurarRespaldo(conn, paths, payload?.id)
      progreso('restaurado', { id: res.id, seguridad: res.seguridad })
      send('db:changed', { motivo: 'restore', id: res.id })
      return res
    },

    /** Keep the newest N, delete the rest, report what stayed and why. */
    prune: (payload) => {
      const res = podarRespaldos(paths, { conservar: payload?.conservar ?? 10 })
      progreso('podado', { eliminados: res.eliminados.length, liberadoBytes: res.liberadoBytes })
      return res
    }
  })

  return registry
}
