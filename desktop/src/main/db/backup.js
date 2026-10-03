import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'
import { IpcError } from '../bridge/errors.js'

/**
 * `backup.*` — the five operations that make the shop's file survivable.
 *
 * ── WHY THIS IS A NEW FILE AND NOT PART OF THE DATA LAYER ─────────────────────────────────────
 *
 * Every other repository works on ROWS. This one works on the FILE: it copies it, hashes it, checks
 * it, swaps it, and deletes old copies. That is why it is the only module here allowed to reach for
 * `node:fs`, and why it never opens a `ctx` transaction — a backup must see the database as a
 * whole, not a consistent slice of it, and `PRAGMA wal_checkpoint` cannot run inside a transaction
 * anyway.
 *
 * ── WHAT A BACKUP IS, AND WHAT IT IS NOT ─────────────────────────────────────────────────────
 *
 * It is ONE file produced by SQLite's own online backup API (`node:sqlite`'s module-level
 * `backup()`, which the S0 spike already proved works and produces a readable copy). That API reads
 * the database through a second connection while the shop keeps selling, so "make a backup" is not
 * a maintenance window.
 *
 * It is NOT a copy of `minimarck.db`. The live file is in WAL mode, so the committed rows can be in
 * `minimarck.db-wal` while the `.db` is behind. Copying the bare file is the exact failure S1's
 * negative control demonstrates — "after a hard kill, copying only the .db LOSES EVERYTHING". So a
 * backup CHECKPOINTS FIRST and then copies, and the manifest records what was verified rather than
 * what was hoped.
 *
 * ── WHY THERE IS A MANIFEST ──────────────────────────────────────────────────────────────────
 *
 * A `.db` alone cannot say when it was taken, by whom, or what schema it holds without opening it.
 * `list` would have to open every file to answer, which on a directory of twelve backups is twelve
 * SQLite connections per page load. The manifest is a small JSON beside each archive, written AFTER
 * the archive is complete and verified, so a manifest can never describe a backup that is not
 * there. If it is missing, `list` falls back to the filesystem and SAYS the archive is unverified
 * rather than inventing the missing fields — `origen: 'archivo'`.
 */

/** The archive extension, and the manifest that always sits beside it. */
const EXT = '.db'
const EXT_MANIFIESTO = '.db.json'

/**
 * The `schema_migrations` ledger of a database file, read WITHOUT opening it for writing.
 *
 * Read-only is chosen because this runs against archives and against the LIVE file during
 * verification: the one thing a verification must not do is write to what it is verifying.
 *
 * IT IS NOT SIDECAR-FREE. An earlier comment here said a backup is "a plain rollback-journal file
 * with no sidecars, so read-only works here", and MEASURED, both halves of that are wrong:
 *   - `SQLITE_CANTOPEN` is what read-only hits on a WAL database when the DIRECTORY is not
 *     writable, because the connection cannot build the `-shm` index. It is not about WAL itself.
 *   - `copyFileSync` and SQLite's own `backup()` both leave the archive in `journal_mode=wal` — the
 *     journal mode is a property of the FILE, not of how it was copied. So this very read CREATES
 *     `<id>.db-wal` and `<id>.db-shm` beside every snapshot: four files instead of two. They are
 *     never listed (`listarRespaldos` filters on `.endsWith('.db')`) and `podarRespaldos` deletes
 *     them with the archive.
 */
function leerLedger(archivo) {
  let db
  try {
    db = new DatabaseSync(archivo, { readOnly: true })
  } catch (err) {
    return { ok: false, motivo: `no se pudo abrir: ${err.message}` }
  }
  try {
    const integridad = db.prepare('PRAGMA integrity_check').get()
    // `integrity_check` answers one row with `ok`, or one row per problem found.
    const valor = integridad ? Object.values(integridad)[0] : null
    if (valor !== 'ok') {
      return { ok: false, motivo: `integrity_check dijo: ${valor}` }
    }
    const userVersion = db.prepare('PRAGMA user_version').get().user_version
    const migraciones = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all()
    // The 20 business tables, counted rather than named: a backup of a migrated database has them,
    // and an empty or truncated file does not. `sqlite_master` is readable without the allowlist
    // because this is a different connection with no authorizer attached.
    const tablas = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .get().n
    // Counted ONLY when the table exists. A brand-new file — a first launch, where `001` is still
    // pending — has no `ventas`, and the unconditional query this replaced reported a perfectly
    // good copy of an empty database as unreadable. `null` is a fact, not a failure.
    const hayVentas =
      db
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'ventas'")
        .get().n > 0
    const ventas = hayVentas ? db.prepare('SELECT COUNT(*) AS n FROM ventas').get().n : null
    return { ok: true, userVersion, migraciones, tablas, ventas }
  } catch (err) {
    return { ok: false, motivo: `ilegible o incompleto: ${err.message}` }
  } finally {
    try {
      db.close()
    } catch {
      /* the verdict is already formed */
    }
  }
}

/** The file's SHA-256, streamed in one read. Used to detect a truncated or edited archive. */
function hashDe(archivo) {
  return createHash('sha256').update(readFileSync(archivo)).digest('hex')
}

function tamanoDe(archivo) {
  try {
    return statSync(archivo).size
  } catch {
    return null
  }
}

/**
 * THE SIDECARS an archive's read leaves on disk, deleted with the archive they belong to.
 *
 * `leerLedger` opens every snapshot it verifies in read-only and the copied file is still in
 * `journal_mode=wal`, so that read creates `<id>.db-wal` and `<id>.db-shm` beside it. They were never
 * catalogued (`listarRespaldos` filters on `.endsWith('.db')`), which is why deleting only the
 * `.db` + `.db.json` left two files per snapshot FOREVER.
 *
 * ── WHY THIS EXISTS AS A HELPER AND NOT AS A LOOP IN THREE PLACES ──────────────────────────────
 *
 * Because the leak was closed in `podarRespaldos` first and left open in the REJECTION paths, which
 * is the worst possible shape: a prune walking the catalog did not cover it either, because a
 * rejected archive never reaches the catalog — the catalog is precisely what the rejection prevents.
 * Three copies of this loop is how the next one drifts, so the reason lives here once.
 *
 * TOLERANT on purpose, and it is never what decides anything: the sidecars may not exist (the
 * archive was never opened, or the read checkpointed them away), and a sidecar held by a scanner on
 * Windows is reaped when it lets go. Neither is a reason to fail an operation that has ALREADY
 * deleted the archive, and neither may be reported as a failed deletion.
 */
function borrarSidecars(archivo) {
  for (const sufijo of ['-wal', '-shm']) {
    try {
      rmSync(`${archivo}${sufijo}`, { force: true })
    } catch {
      /* the archive it belonged to is already deleted */
    }
  }
}

/**
 * The identifier of an archive, derived from its filename and never from its contents.
 *
 * THIS IS THE TENANT BOUNDARY of every operation in this file, and it is why the id is not a
 * database row id: an archive is a file on disk, and a caller that passed `../../minimarck.db`
 * would be a caller asking to restore or delete the live database. `path.basename` plus a format
 * check means the id can only ever name a file INSIDE the backup directory, so the worst a
 * malicious payload can do is ask for a backup that does not exist.
 */
function idDeArchivo(nombre) {
  return nombre.endsWith(EXT) ? path.basename(nombre, EXT) : path.basename(nombre)
}

function exigirId(valor) {
  const id = String(valor ?? '').trim()
  // The name we generate is `minimarck-<iso>`, and the pattern is anchored so it can match nothing
  // else — no separators, no dots, no traversal.
  if (!/^minimarck-[0-9TZ:.-]+$/.test(id)) {
    throw new IpcError('RESPALDO_ID_INVALIDO', 400, `Identificador de respaldo inválido: ${valor}`)
  }
  return id
}

/** The absolute path of an archive, asserted to be inside the backup directory. */
function rutaDeArchivo(paths, id) {
  const archivo = path.join(paths.backupDir, `${exigirId(id)}${EXT}`)
  const resuelto = path.resolve(archivo)
  if (path.dirname(resuelto) !== path.resolve(paths.backupDir)) {
    throw new IpcError('RESPALDO_ID_INVALIDO', 400, 'El respaldo pedido no está en la carpeta de respaldos')
  }
  return resuelto
}

/** The name of a new archive, from the clock. Sortable as text, which is what `list` relies on. */
function nombreNuevo(ahora) {
  return `minimarck-${ahora.toISOString().replace(/[:.]/g, '-')}`
}

/**
 * What a manifest holds, and why each field is there.
 *
 * `checksum` is the whole point: `verify` recomputes it, so a truncated or edited archive is
 * detectable without opening SQLite. `userVersion` and `tablas` are what make `list` answerable
 * without a connection. `motivo` records WHY the backup was taken (`manual`), because a scheduled
 * backup and a hand-made one are read differently by whoever finds the directory later.
 */
function escribirManifiesto(paths, id, datos) {
  const destino = path.join(paths.backupDir, `${id}${EXT_MANIFIESTO}`)
  // Written to a temporary name and renamed, so a manifest is never half-written. The rename is
  // atomic on NTFS, which is the only platform this app ships to.
  const temporal = `${destino}.tmp`
  writeFileSync(temporal, `${JSON.stringify(datos, null, 2)}\n`, 'utf8')
  renameSync(temporal, destino)
  return destino
}

function leerManifiesto(paths, id) {
  const ruta = path.join(paths.backupDir, `${id}${EXT_MANIFIESTO}`)
  if (!existsSync(ruta)) return null
  try {
    return JSON.parse(readFileSync(ruta, 'utf8'))
  } catch {
    // A corrupt manifest does not invalidate the ARCHIVE. `list` reports the row as unverified and
    // `verify` re-derives everything from the file itself, so a broken JSON here loses the notes
    // and nothing else.
    return null
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// create
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Take a backup. Returns the catalog row of what was written.
 *
 * ── THE ORDER, AND WHY IT IS THIS ORDER ──────────────────────────────────────────────────────
 *
 *   1. CHECKPOINT the live database. Without this the committed rows can still be in the `-wal`,
 *      and the archive would be a consistent snapshot of a database that is missing them.
 *   2. `backup()` — SQLite's own online API, which reads through a second connection. Safe with the
 *      shop selling, and safe with the connection open.
 *   3. VERIFY the archive by opening it read-only: `integrity_check`, the schema ledger and two
 *      row counts. A backup that was never read is a file with a hopeful name.
 *   4. Hash it and write the manifest LAST. A manifest that exists therefore always describes a
 *      complete, verified archive, and the reverse ordering would create the one state worse than
 *      no backup: a catalog entry for a file that is half-written.
 */
export async function crearRespaldo(conn, paths, { motivo = 'manual', nota = null } = {}) {
  // NO `requireTenant` HERE, and the absence is the design rather than an oversight: a backup is
  // the whole FILE, not one business's rows. A shop file has exactly one business in it today, but
  // the operation would be the same with ten — and demanding a tenant would make the one operation
  // that has to work when something is wrong with the data layer depend on resolving a business out
  // of it. `requireTenant` is called by every OTHER handler in this group for the shape it gives
  // the rest of the app; here it would be a way to be locked out of your own backups.
  if (!paths?.backupDir) {
    throw new IpcError('RESPALDO_SIN_CARPETA', 500, 'No hay carpeta de respaldos resuelta')
  }
  if (!existsSync(paths.dbFile)) {
    throw new IpcError('RESPALDO_SIN_BASE', 409, 'Todavía no hay una base de datos para respaldar')
  }
  /**
   * THE DIRECTORY IS CREATED HERE, not assumed to exist.
   *
   * `ensureDataDirs` creates it on first run, and relying on that was a real failure in the first
   * version of this module: a test fixture that built its own paths got `SQLITE_CANTOPEN` from
   * `backup()` — server error 14, "unable to open database file", pointing at the SOURCE database
   * — because the DESTINATION directory was missing. The message names the wrong file, which is
   * exactly the kind of error that costs an afternoon.
   *
   * It is also the right behaviour for a person: somebody who deleted the folder, or who restored a
   * machine and copied only `data/`, should get their backups working again rather than an error
   * about a path they never chose.
   */
  mkdirSync(paths.backupDir, { recursive: true })

  // 1. The WAL goes into the `.db` before anything is copied out of it.
  try {
    conn.pragma('wal_checkpoint(TRUNCATE)')
  } catch (err) {
    // A checkpoint failure is reported rather than swallowed: the archive can still be taken (the
    // backup API reads through the WAL correctly), but the manifest says the checkpoint did not
    // happen so a later reader is not told the file was self-contained when it was not.
    console.warn(`[backup] el checkpoint falló antes del respaldo: ${err.message}`)
  }

  const ahora = new Date()
  const id = nombreNuevo(ahora)
  const destino = path.join(paths.backupDir, `${id}${EXT}`)

  // 2. SQLite's own copy. `backup` is a MODULE export, not a method on the database handle — the
  //    spike's header records that trap because it is the kind of thing that reads like a typo.
  await backup(conn.db, destino)

  // 3. Read it back before believing it.
  const verificado = leerLedger(destino)
  if (!verificado.ok) {
    // An archive that cannot be read is deleted rather than left behind under a name that claims it
    // is a backup. Leaving it would make `list` offer a restore into a corrupt file.
    try {
      rmSync(destino, { force: true })
    } catch {
      /* the refusal below is the result */
    }
    // AND THE SIDECARS, outside the `try`. Step 3 above OPENED the archive, and that read left
    // `<id>.db-wal` and `<id>.db-shm` beside it — measured, not inferred. Deleting only the `.db`
    // would strand both, with no manifest and no catalog row that could ever reap them. This is the
    // shape the refusal has, so there is no `podarRespaldos` pass coming: it walks the CATALOG, and a
    // rejected archive never gets an entry.
    borrarSidecars(destino)
    throw new IpcError(
      'RESPALDO_ILEGIBLE',
      500,
      `El respaldo se escribió pero no se pudo leer: ${verificado.motivo}`
    )
  }

  // 4. The manifest, last.
  const fila = {
    id,
    archivo: `${id}${EXT}`,
    creadoAt: ahora.toISOString(),
    bytes: tamanoDe(destino),
    checksum: hashDe(destino),
    userVersion: verificado.userVersion,
    tablas: verificado.tablas,
    ventas: verificado.ventas,
    motivo,
    nota: nota === null ? null : String(nota).slice(0, 500)
  }
  escribirManifiesto(paths, id, fila)
  return fila
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// respaldarAntesDeMigrar — NOT an operation. There is no IPC contract for it.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * `user_version` and the applied-migration ledger of the OPEN connection, read before the copy.
 *
 * `schema_migrations` exists by the time the hook fires: `migrate()` calls `ensureLedger` on its
 * first statement and the snapshot runs from inside it.
 */
function ledgerDe(conn) {
  return {
    userVersion: conn.userVersion(),
    migraciones: conn.db
      .prepare('SELECT version, checksum FROM schema_migrations ORDER BY version')
      .all()
      .map((r) => ({ version: Number(r.version), checksum: r.checksum }))
  }
}

/** Two ledgers agree when they list the same versions with the same checksums, in the same order. */
function mismoLedger(a, b) {
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((m, i) => m.version === b[i].version && m.checksum === b[i].checksum)
}
/**
 * The pre-migration snapshot: the parachute, taken automatically before the first pending
 * migration runs. It is the only backup this file produces that nobody asked for.
 *
 * ── WHY IT IS NOT `crearRespaldo`, MEASURED RATHER THAN ASSUMED ─────────────────────────────────
 *
 * `VACUUM INTO` is the synchronous snapshot the original design named, and **this connection
 * refuses it**: `VACUUM INTO` internally ATTACHes the destination, action 24 is `SQLITE_ATTACH`,
 * and the authorizer denies it unconditionally — `connection.js:62,80`, "one machine, one process,
 * one database file". Probed, it comes back `ERR_SQLITE_ERROR 23` / "authorization denied".
 * Weakening that deny to enable a backup would trade a security control for a convenience.
 *
 * `crearRespaldo` is the right idea with the wrong shape here: `node:sqlite`'s online `backup()`
 * is a promise, `migrate()` is synchronous, and `TxRunner` refuses a thenable body by design
 * (`connection.js:114`). Making bootstrap `async` to await it would ripple into the `tienda()`
 * fixture that ~20 spec files share. So this runs **at startup, where nothing else is writing**,
 * with only synchronous calls.
 *
 * ── THE ORDER, AND WHAT EACH STEP BUYS ────────────────────────────────────────────────────────
 *
 *   1. `wal_checkpoint(TRUNCATE)` — the `.db` becomes self-contained. Unlike `crearRespaldo`, a
 *      failure here is FATAL rather than warned about: the online API reads through the WAL
 *      correctly, a plain `copyFileSync` does not, and continuing would archive a file that is
 *      missing committed sales. Refusing to migrate is the right answer to that.
 *   2. `copyFileSync` to `<id>.db.parcial` — a crash leaves a file `listarRespaldos` ignores,
 *      because it does not end in `.db` and there is no manifest beside it.
 *   3. `renameSync` — atomic on NTFS, same directory, same volume. The archive is there or it is
 *      not; there is never a half-written file under a name that claims to be a backup.
 *   4. `leerLedger` — the copy is read back. A backup that was never read is a file with a hopeful
 *      name.
 *   5. `escribirManifiesto` LAST — so a manifest can never describe an archive that is not there.
 *
 * ── WHY THE COPY IS COMPARED AGAINST THE SOURCE AND NOT AGAINST A TABLE COUNT ──────────────────
 *
 * `integrity_check: ok` proves the archive is a valid SQLite file; it cannot tell "the database we
 * are about to migrate" from "some other valid database". So `user_version` and the
 * `schema_migrations` ledger are compared with the live connection's. That comparison is also what
 * makes the snapshot correct on a first launch, where the file is empty and there is nothing to
 * count.
 *
 * ── WHAT RESTORING IT COSTS, AND WHY THAT IS FINE ─────────────────────────────────────────────
 *
 * Reverting a schema slice is always enough for the app to RUN — extra columns are ignored and a
 * trigger that never fires refuses nothing. This snapshot is only needed to UNDO the DDL, and
 * restoring it costs every sale rung up since the migration ran. That asymmetry is the argument for
 * taking it, and the reason it is a slice of its own that lands before any schema change.
 *
 * NOTE, because somebody will read it as a bug: `verificarRespaldo` reports this archive as NOT
 * restorable by this build — its `faltantes` names the migration it predates — and
 * `restaurarRespaldo` refuses it. That is correct. This build's code expects the new schema, and
 * undoing a migration is an out-of-band file copy with the app closed, not a click in Respaldos.
 */
export function respaldarAntesDeMigrar(conn, paths, { nota = null } = {}) {
  // NO `requireTenant` here, for the same reason `crearRespaldo` has none: this is the whole FILE.
  // A migration is not scoped to a business, and the operation that has to work when the data
  // layer is already wrong must not depend on resolving a business out of it.
  if (!paths?.backupDir) {
    throw new IpcError('RESPALDO_SIN_CARPETA', 500, 'No hay carpeta de respaldos resuelta')
  }
  if (!existsSync(paths.dbFile)) {
    throw new IpcError('RESPALDO_SIN_BASE', 409, 'Todavía no hay una base de datos para respaldar')
  }

  // 1. The WAL goes into the `.db` before anything is copied out of it.
  try {
    conn.pragma('wal_checkpoint(TRUNCATE)')
  } catch (err) {
    throw new IpcError(
      'RESPALDO_CHECKPOINT_FALLIDO', 500,
      `No se pudo consolidar el WAL antes de migrar: ${err.message}`
    )
  }

  // What the archive has to turn out to be, read from the source rather than assumed afterwards.
  const esperado = ledgerDe(conn)

  mkdirSync(paths.backupDir, { recursive: true })
  const ahora = new Date()
  // `nombreNuevo`'s id and NOT a new `antes-de-migrar-` prefix, which is what the design sketched.
  // `exigirId` accepts `minimarck-<iso>` and nothing else, so a second prefix would make the one
  // snapshot that matters impossible to NAME through the very operations that list, verify and
  // restore backups. `motivo` below is the field whose job is to tell two archives apart.
  const id = nombreNuevo(ahora)
  const destino = path.join(paths.backupDir, `${id}${EXT}`)

  // Idempotence: if there's already a pre-migration snapshot for the SAME source user_version and
  // the same migration ledger (the state before applying this pending batch), reuse it instead of
  // creating another copy. A second snapshot of the identical pre-migration state is redundant.
  try {
    const existentes = listarRespaldos(paths).filas
    for (const f of existentes) {
      if (f.motivo !== 'antes-de-migrar') continue
      try {
        const v = verificarRespaldo(paths, f.id)
        if (v.ok && v.userVersion === esperado.userVersion) {
          const leidoExistente = leerLedger(rutaDeArchivo(paths, f.id))
          if (leidoExistente.ok && mismoLedger(leidoExistente.migraciones, esperado.migraciones)) {
            return f
          }
        }
      } catch {
        // ignore this entry and try others
      }
    }
  } catch {
    // if listing/verifying fails, proceed to create a new snapshot
  }

  const parcial = `${destino}.parcial`

  // 2 + 3. Copy to a name nobody lists, then make it real in one atomic step.
  copyFileSync(paths.dbFile, parcial)
  renameSync(parcial, destino)

  // 4. Read it back — and read back the RIGHT thing.
  const leido = leerLedger(destino)
  const motivo =
    !leido.ok
      ? leido.motivo
      : leido.userVersion !== esperado.userVersion
        ? `el archivo tiene user_version ${leido.userVersion} y la base abierta tiene ${esperado.userVersion}`
        : !mismoLedger(leido.migraciones, esperado.migraciones)
          ? 'el archivo tiene un historial de migraciones distinto al de la base abierta'
          : null
  if (motivo) {
    // Deleted rather than left under a name that claims it is a backup: `listarRespaldos` would
    // offer it, and a file that is not the pre-migration state is the one thing this whole
    // snapshot exists to make impossible.
    try {
      rmSync(destino, { force: true })
    } catch {
      /* the refusal below is the result */
    }
    // AND THE SIDECARS, outside the `try`, same as `crearRespaldo`. Step 4 above opened the copy and
    // that read left `<id>.db-wal` and `<id>.db-shm` beside it. WORSE HERE THAN ANYWHERE ELSE: this
    // snapshot is taken immediately before an `ALTER`, so a rejection means the database was ALREADY
    // suspect — and the two orphans would sit in the backup folder with no manifest and no catalog
    // row, which is the one thing `podarRespaldos` cannot reach.
    borrarSidecars(destino)
    throw new IpcError(
      'RESPALDO_ILEGIBLE', 500,
      `El respaldo previo a la migración no sirve: ${motivo}`
    )
  }

  // 5. The manifest, last, in the SAME shape `crearRespaldo` writes — so the catalog treats both
  // identically and only `motivo` says why this one is there.
  const fila = {
    id,
    archivo: `${id}${EXT}`,
    creadoAt: ahora.toISOString(),
    bytes: tamanoDe(destino),
    checksum: hashDe(destino),
    userVersion: leido.userVersion,
    tablas: leido.tablas,
    ventas: leido.ventas,
    motivo: 'antes-de-migrar',
    nota: nota === null ? null : String(nota).slice(0, 500)
  }
  escribirManifiesto(paths, id, fila)
  return fila
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// list
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The catalog, newest first.
 *
 * ── WHY IT READS THE DIRECTORY AND NOT JUST THE MANIFESTS ────────────────────────────────────
 *
 * A manifest can be deleted on its own, and a `.db` can be copied into the folder by hand — both
 * are things a person restoring a machine actually does. Listing only the manifests would hide an
 * archive that is perfectly restorable, and listing only the files would lose the checksum. So the
 * DIRECTORY is the source of truth for "what exists" and the manifest is the source of truth for
 * "what is known about it", and a file with no manifest is reported as `verificado: false` instead
 * of being invented into the catalog.
 *
 * `origen` says which of the two answered: `manifiesto` or `archivo`. A caller that wants only
 * trustworthy rows can filter on it; a screen shows them with the difference visible.
 */
export function listarRespaldos(paths) {
  if (!paths?.backupDir || !existsSync(paths.backupDir)) return { filas: [], total: 0 }

  const filas = []
  for (const nombre of readdirSync(paths.backupDir)) {
    if (!nombre.endsWith(EXT)) continue
    const id = idDeArchivo(nombre)
    const ruta = path.join(paths.backupDir, nombre)
    const manifiesto = leerManifiesto(paths, id)
    const stat = statSync(ruta)

    if (manifiesto) {
      filas.push({
        ...manifiesto,
        id,
        archivo: nombre,
        // The size on disk is re-read rather than trusted: a manifest that says 400 KB over a file
        // that is now 2 KB is exactly the corruption this screen exists to make visible.
        bytes: stat.size,
        bytesEsperados: manifiesto.bytes ?? null,
        verificado: manifiesto.checksum ? manifiesto.bytes === stat.size : false,
        origen: 'manifiesto'
      })
    } else {
      filas.push({
        id,
        archivo: nombre,
        creadoAt: stat.mtime.toISOString(),
        bytes: stat.size,
        bytesEsperados: null,
        checksum: null,
        userVersion: null,
        tablas: null,
        ventas: null,
        motivo: null,
        nota: null,
        // Not an error and not a lie: this archive is there, nobody recorded anything about it, and
        // `verify` can still tell whether it is restorable.
        verificado: false,
        origen: 'archivo'
      })
    }
  }

  // Newest first. The id is `minimarck-<iso>` with the separators normalised, so it sorts as text
  // in the same order as the clock — which is why `creadoAt` is not the sort key.
  filas.sort((a, b) => b.id.localeCompare(a.id))
  return { filas, total: filas.length }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// verify
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Does this archive actually restore?
 *
 * ── WHAT IS CHECKED, IN ORDER OF HOW MUCH IT COSTS TO LEARN ─────────────────────────────────
 *
 *   1. The file exists and is not empty. The cheapest failure, and the one a hand-copied file
 *      usually has.
 *   2. Its SHA-256 matches the manifest. Catches a truncated copy, a partial write and an edit —
 *      without opening SQLite at all. Only checked when a manifest exists, and `checksumCoincide`
 *      is `null` (not `false`) when there is nothing to compare against, because "unknown" and
 *      "wrong" are different answers.
 *   3. `PRAGMA integrity_check` on the file itself, plus its schema ledger and row counts.
 *   4. THE MIGRATION MATCH, which is the check that matters most and is easiest to forget. The app
 *      refuses to start when an applied migration's checksum does not match the file on disk
 *      (`MIGRATION_CHECKSUM_MISMATCH`) — so an archive taken under a DIFFERENT build can be a
 *      perfectly valid SQLite database that this app cannot open. Restoring it would turn a
 *      recovery into a shop that will not launch. Comparing the archive's ledger against the
 *      CURRENT migrations is what turns that into a refusal here, while the till still works.
 */
export function verificarRespaldo(paths, id) {
  const archivo = rutaDeArchivo(paths, id)
  if (!existsSync(archivo)) {
    throw new IpcError('RESPALDO_NO_ENCONTRADO', 404, 'Ese respaldo no está en la carpeta de respaldos')
  }
  const bytes = tamanoDe(archivo)
  if (!bytes) {
    return { id, ok: false, motivo: 'el archivo está vacío', bytes: 0 }
  }

  const manifiesto = leerManifiesto(paths, id)
  let checksumActual = null
  let checksumCoincide = null
  if (manifiesto?.checksum) {
    checksumActual = hashDe(archivo)
    checksumCoincide = checksumActual === manifiesto.checksum
    if (!checksumCoincide) {
      return {
        id,
        ok: false,
        motivo: 'el archivo cambió desde que se creó (el checksum no coincide)',
        bytes,
        checksumActual,
        checksumEsperado: manifiesto.checksum,
        checksumCoincide: false
      }
    }
  }

  const leido = leerLedger(archivo)
  if (!leido.ok) {
    return { id, ok: false, motivo: leido.motivo, bytes, checksumActual, checksumCoincide }
  }

  const esperadas = migracionesEsperadas(paths)
  const enDisco = new Map(leido.migraciones.map((m) => [Number(m.version), m.checksum]))
  const faltantes = esperadas.filter((m) => !enDisco.has(m.version)).map((m) => m.version)
  const distintas = esperadas
    .filter((m) => enDisco.has(m.version) && enDisco.get(m.version) !== m.checksum)
    .map((m) => m.version)
  const migracionesOk = faltantes.length === 0 && distintas.length === 0

  return {
    id,
    ok: migracionesOk,
    motivo: migracionesOk
      ? null
      : distintas.length > 0
        ? `el respaldo se hizo con una versión distinta de la migración ${distintas.join(', ')}`
        : `al respaldo le faltan las migraciones ${faltantes.join(', ')}`,
    bytes,
    checksumActual,
    checksumCoincide,
    userVersion: leido.userVersion,
    tablas: leido.tablas,
    ventas: leido.ventas,
    migracionesOk,
    faltantes,
    distintas
  }
}

/**
 * The migration ledger THIS build expects, read from the migration files on disk.
 *
 * The runner records a SHA-256 of each file as it applies it (`migrate.js`), so the expected
 * checksum is the hash of the file the app would apply today. Computed here rather than read from
 * the live database on purpose: the live database describes what was applied, and the question is
 * what the app would REFUSE to start against.
 *
 * HASHED AS TEXT, WITH THE SAME CALL AS THE RUNNER. `migrate.js` does
 * `createHash('sha256').update(sql, 'utf8')` where `sql` came from `readFileSync(p, 'utf8')`, and
 * this has to produce the same digest or `verify` would reject every valid backup. Hashing the raw
 * Buffer instead agrees only while the file has no BOM and no invalid byte sequences — and the
 * project ships a `check-commit-bom.mjs` gate precisely because that is not a safe assumption. The
 * two calls are kept textually identical so a change to one shows up against the other.
 */
function migracionesEsperadas(paths) {
  const dir = paths?.migrationsDir
  if (!dir || !existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort()
    .map((f) => {
      const sql = readFileSync(path.join(dir, f), 'utf8')
      const version = Number.parseInt(f.split('_')[0], 10)
      return { version, checksum: createHash('sha256').update(sql, 'utf8').digest('hex'), archivo: f }
    })
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// restore
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Put an archive back, and leave the connection pointing at it.
 *
 * ── THE HARD PART, AND WHY IT IS NOT A FILE COPY ─────────────────────────────────────────────
 *
 * Every handler in the app closed over the SAME connection object at registration
 * (`registerXHandlers(registry, { conn: db.conn })`), and that object holds a `node:sqlite`
 * handle. Replacing the file underneath an open handle does not work: SQLite keeps its own
 * descriptor, and the app would keep reading the old data — or worse, corrupt the new file on its
 * next write.
 *
 * So the restore does three things in this order:
 *
 *   1. VERIFY the archive. Restoring an unverified file over the only copy of a shop's sales is the
 *      single most destructive thing this app could do, and it is the one operation with no undo.
 *   2. BACK THE CURRENT FILE UP FIRST, automatically. It is the safety net for the case where
 *      somebody restores the wrong archive: two clicks, and the shop is back. This is why restore
 *      is the only destructive operation here that does not ask the caller to have planned ahead.
 *   3. SWAP the file and REOPEN the connection IN PLACE (`conn.reopen()`), which closes the old
 *      handle and opens a new one on the replaced file. In place because the closures cannot be
 *      rewritten — see `connection.js#reopen`, which exists for this call and nothing else.
 *
 * ── WHY THE COPY GOES THROUGH A TEMPORARY FILE ───────────────────────────────────────────────
 *
 * The archive is copied to `<db>.restaurando` and then RENAMED over the live file. A rename is
 * atomic on NTFS, so a crash mid-restore leaves either the old database or the new one, never a
 * half-written mixture. Writing directly to the live path would leave the shop with no database at
 * all if the process died between the first byte and the last.
 *
 * The `-wal` and `-shm` sidecars are DELETED as part of the swap. That is not tidiness: a WAL left
 * over from the OLD database reattached to the NEW file is a set of committed transactions that
 * belong to a different schema, which is how a restore turns into corruption. The old ones are
 * removed after the old database has been backed up and closed.
 */
export async function restaurarRespaldo(conn, paths, id) {
  const archivo = rutaDeArchivo(paths, id)

  const verificado = verificarRespaldo(paths, id)
  if (!verificado.ok) {
    throw new IpcError(
      'RESPALDO_INVALIDO',
      409,
      `No se puede restaurar: ${verificado.motivo}. El respaldo está en la carpeta, pero no es una base válida para esta versión.`
    )
  }

  // 2. The safety net. `crearRespaldo` checkpoints, copies and verifies, and its manifest is what
  //    makes "the copy taken just before the restore" identifiable later.
  const seguridad = await crearRespaldo(conn, paths, {
    motivo: 'antes-de-restaurar',
    nota: `copia automática previa a restaurar ${id}`
  })

  // 3. Close, swap, reopen. The reopen is what makes the swap visible to every handler.
  conn.checkpointAndClose()

  const temporal = `${paths.dbFile}.restaurando`
  try {
    copyFileSync(archivo, temporal)
    renameSync(temporal, paths.dbFile)
  } catch (err) {
    // The old file is still where it was unless the rename succeeded, and the safety backup above
    // is on disk either way. Reopening the ORIGINAL is the recovery, and it is attempted here so a
    // failed restore does not leave the shop with no database open.
    try {
      conn.reopen()
    } catch {
      /* reported below */
    }
    throw new IpcError('RESPALDO_NO_RESTAURADO', 500, `No se pudo reemplazar la base: ${err.message}`)
  }

  // Sidecars of the OLD database. Removed AFTER the swap, because they belong to the closed handle
  // and a leftover WAL is reattached on the next open.
  for (const lado of [paths.walFile, paths.shmFile]) {
    if (lado && existsSync(lado)) {
      try {
        rmSync(lado, { force: true })
      } catch {
        /* a locked sidecar on Windows is reaped by the OS; the reopen below is the result */
      }
    }
  }

  conn.reopen()

  // What actually came back, read from the reopened connection rather than from the manifest: the
  // manifest describes the archive, and the question the caller is asking is what the shop has now.
  return {
    restaurado: true,
    id,
    seguridad: seguridad.id,
    userVersion: conn.userVersion(),
    ventas: conn.db.prepare('SELECT COUNT(*) AS n FROM ventas').get().n
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// prune
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Keep the newest N and delete the rest.
 *
 * ── WHY THE POLICY IS N AND NOT AGE ──────────────────────────────────────────────────────────
 *
 * A shop's database grows slowly and backups are taken when something is about to change. "Keep the
 * last 10" has a bounded cost in disk that a person can predict, and it survives a quiet month
 * without deleting everything; "delete anything older than 30 days" deletes every backup a shop
 * that closed for a holiday had. The count is the policy that cannot surprise anybody, and it is
 * the one the manifest makes possible to apply without opening a single file.
 *
 * ── WHAT IT DELETES, AND WHAT IT REFUSES TO ──────────────────────────────────────────────────
 *
 * An archive and its manifest go together. `conservar` is floored at 1: a prune that could delete
 * every backup is a prune that can turn a full disk into an unrecoverable shop, and no caller has a
 * reason to ask for zero — deleting them all is a different operation with a different name.
 */
export function podarRespaldos(paths, { conservar = 10 } = {}) {
  const n = Number(conservar)
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new IpcError('RESPALDO_RETENCION_INVALIDA', 400, `Hay que conservar al menos 1 respaldo, llegó: ${conservar}`)
  }

  const { filas } = listarRespaldos(paths)
  const sobran = filas.slice(n)
  const eliminados = []
  const fallidos = []

  for (const fila of sobran) {
    const archivo = path.join(paths.backupDir, fila.archivo)
    const manifiesto = path.join(paths.backupDir, `${fila.id}${EXT_MANIFIESTO}`)
    try {
      rmSync(archivo, { force: true })
      // The manifest is deleted too, and never on its own: a manifest with no archive is a catalog
      // entry for a file that does not exist, which is worse than neither.
      if (existsSync(manifiesto)) rmSync(manifiesto, { force: true })
      eliminados.push({ id: fila.id, bytes: fila.bytes ?? 0 })
    } catch (err) {
      // A locked file on Windows is a normal outcome (a scanner, or a second instance), and it must
      // not abort the rest of the prune. Reported per file so the screen can say which one stayed.
      fallidos.push({ id: fila.id, motivo: err.message })
    }

    // THE SIDECARS, deleted with the archive they belong to. `borrarSidecars` carries the reason;
    // what matters HERE is that the call is OUTSIDE the `try` above: the archive is already gone,
    // which is what this operation promised, and a sidecar locked by a scanner is reaped when it
    // lets go — it must not turn a deleted archive into a `fallidos` entry.
    borrarSidecars(archivo)
  }

  return {
    eliminados,
    fallidos,
    liberadoBytes: eliminados.reduce((s, e) => s + (e.bytes ?? 0), 0),
    conservados: Math.min(n, filas.length),
    totalAntes: filas.length,
    totalDespues: filas.length - eliminados.length
  }
}
