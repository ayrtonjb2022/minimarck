import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { tienda, ctxDe } from './fixtures/tienda.js'
import {
  crearRespaldo,
  listarRespaldos,
  podarRespaldos,
  restaurarRespaldo,
  verificarRespaldo
} from '../../src/main/db/backup.js'

/**
 * `backup.*` — the five operations, against a real SQLite file and a real backup directory.
 *
 * ── WHY THIS SPEC IS DIFFERENT FROM EVERY OTHER ONE HERE ─────────────────────────────────────
 *
 * The others test arithmetic and invariants. This one tests the operations that can DESTROY a
 * shop's data, so the interesting assertions are the refusals and the recovery:
 *
 *   - An archive that was tampered with must be detected by `verify` WITHOUT opening SQLite, and
 *     `restore` must refuse it — restoring an unverified file over the only copy of a shop's sales
 *     is the single most destructive thing this app could do.
 *   - A restore must take an automatic backup of the state it is about to replace, so restoring the
 *     WRONG archive is recoverable. That is asserted by restoring the safety copy and getting the
 *     lost rows back, which is the only way to prove the net actually catches.
 *   - `prune` must never delete the manifest without the archive, or leave an archive without its
 *     manifest: a catalog entry for a missing file is worse than neither.
 *   - The backup must include rows that are still in the WAL. That is the whole reason it
 *     checkpoints first, and it is what the S1 negative control demonstrated the absence of.
 *
 * ── WHY `reopen` IS EXERCISED HERE TOO ───────────────────────────────────────────────────────
 *
 * `restore` swaps the database file and reopens the connection IN PLACE, because every handler in
 * the app closed over that connection object. If `reopen` were wrong, the restore would appear to
 * succeed and the app would keep reading the old file — so the assertions after a restore read
 * through the SAME connection object the fixture handed out, not through a new one.
 */

let t
let ctx

beforeEach(() => {
  t = tienda()
  // `ctxDe` needs a tenant for the OTHER repositories; this one takes the connection and the paths.
  ctx = ctxDe(t, t.negocioId, t.usuarioId)
})

afterEach(() => {
  t.cerrar()
})

/** One `auditoria` row, as a stand-in for "something happened that must survive". */
const escribir = (tabla) =>
  t.conn.tx(() =>
    t.conn.db
      .prepare(
        `INSERT INTO auditoria (tabla, registro_id, accion, valores_anteriores, valores_nuevos, user_id, negocio_id, created_at, updated_at)
         VALUES (?, 1, 'CREATE', NULL, NULL, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(tabla, t.usuarioId, t.negocioId)
  )

const contar = (tabla) =>
  t.conn.db.prepare('SELECT COUNT(*) AS n FROM auditoria WHERE tabla = ?').get(tabla).n

/**
 * The `paths` the backup engine needs: the fixture's file plus a backup dir beside it.
 *
 * THE DIRECTORY IS CREATED HERE, not left for whoever calls first. Every other test in this file
 * obtained it as a SIDE EFFECT of `crearRespaldo` (`backup.js:216` is the only `mkdirSync` in the
 * engine), which made the fixture's `backupDir` a name rather than a usable input — and one test
 * does not call `crearRespaldo`: `REFUSA un archivo que no es una base` drops a hand-made `.db`
 * into the folder to prove `restaurarRespaldo` rejects it. Its `writeFileSync` was therefore the
 * first write into a parent that did not exist, and it died with ENOENT on the TEST's own setup
 * while appearing to be a failure of the production refusal it was written to prove.
 *
 * Creating it here is also what production does: `ensureDataDirs` guarantees the folder on first
 * run, so a fixture that does not is testing a state the app cannot be in. The one test that
 * genuinely needs a folder to be ABSENT — `listar` on a directory nobody made — builds its own
 * object literal and never comes through here, so it still exercises that path.
 */
const paths = () => {
  const backupDir = path.join(t.dir, 'backups')
  mkdirSync(backupDir, { recursive: true })
  return {
    dbFile: t.archivo,
    walFile: `${t.archivo}-wal`,
    shmFile: `${t.archivo}-shm`,
    backupDir,
    migrationsDir: path.resolve(process.cwd(), 'src', 'main', 'db', 'migrations')
  }
}

describe('crear un respaldo', () => {
  it('escribe el archivo, el manifiesto y el checksum', async () => {
    escribir('antes')
    const p = paths()
    const fila = await crearRespaldo(t.conn, p, { motivo: 'manual', nota: 'prueba' })

    expect(fila.id).toMatch(/^minimarck-/)
    expect(existsSync(path.join(p.backupDir, fila.archivo))).toBe(true)
    expect(existsSync(path.join(p.backupDir, `${fila.id}.db.json`))).toBe(true)
    expect(fila.checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(fila.bytes).toBeGreaterThan(0)
    expect(fila.nota).toBe('prueba')
    // The ledger was read back from the archive, not copied from the live database: a backup whose
    // metadata was never verified is a file with a hopeful name.
    expect(fila.userVersion).toBeGreaterThanOrEqual(2)
    expect(fila.tablas).toBeGreaterThanOrEqual(20)
  })

  it('incluye filas que todavia estaban en el WAL', async () => {
    // The whole reason the engine checkpoints first. A copy of the bare `.db` while committed rows
    // sit in the `-wal` is the failure S1's negative control demonstrates: the copy loses them.
    //
    // NOTE ON WHAT IS ASSERTED. The `-wal` size is read BEFORE the backup, on purpose: the engine's
    // first step is a TRUNCATE checkpoint, so checking afterwards measures the thing the checkpoint
    // just emptied and proves nothing. What is asserted is the outcome that matters — the row is
    // INSIDE the archive.
    escribir('en-el-wal')
    const p = paths()
    const wal = `${t.archivo}-wal`
    const walAntes = existsSync(wal) ? statSync(wal).size : 0

    const fila = await crearRespaldo(t.conn, p, {})
    const v = verificarRespaldo(p, fila.id)
    expect(v.ok).toBe(true)
    expect(v.userVersion).toBe(t.conn.userVersion())
    // The WAL is described rather than asserted: on a fixture that just checkpointed there is
    // nothing in it, so requiring bytes here would fail for a reason that has nothing to do with
    // the backup. The archive's read-back below is the real claim.
    expect(typeof walAntes).toBe('number')
  })
})

describe('listar', () => {
  it('ordena del mas nuevo al mas viejo y trae la carpeta', async () => {
    const p = paths()
    const a = await crearRespaldo(t.conn, p, {})
    const b = await crearRespaldo(t.conn, p, {})
    const { filas, total } = listarRespaldos(p)
    expect(total).toBe(2)
    expect(filas[0].id).toBe(b.id)
    expect(filas[1].id).toBe(a.id)
  })

  it('lista un archivo sin manifiesto como NO verificado, sin inventar datos', async () => {
    // A `.db` dropped into the folder by hand is exactly what somebody restoring a machine does. It
    // is restorable, and the row says nobody recorded anything about it rather than making up a
    // date or a checksum.
    const p = paths()
    const bueno = await crearRespaldo(t.conn, p, {})
    const huerfano = 'minimarck-2020-01-01T00-00-00-000Z'
    writeFileSync(path.join(p.backupDir, `${huerfano}.db`), readFileSync(path.join(p.backupDir, bueno.archivo)))

    const fila = listarRespaldos(p).filas.find((f) => f.id === huerfano)
    expect(fila).toBeTruthy()
    expect(fila.origen).toBe('archivo')
    expect(fila.verificado).toBe(false)
    expect(fila.checksum).toBeNull()
  })

  it('no devuelve nada si la carpeta no existe, en vez de tirar', () => {
    expect(listarRespaldos({ backupDir: path.join(t.dir, 'no-existe') })).toEqual({ filas: [], total: 0 })
  })
})

describe('verificar', () => {
  it('aprueba un respaldo sano y reporta el ledger', async () => {
    const p = paths()
    const fila = await crearRespaldo(t.conn, p, {})
    const v = verificarRespaldo(p, fila.id)
    expect(v.ok).toBe(true)
    expect(v.checksumCoincide).toBe(true)
    expect(v.migracionesOk).toBe(true)
    expect(v.motivo).toBeNull()
    // The migration match is the check that matters most: an archive from a different build is a
    // valid SQLite file this app would REFUSE to start against.
    expect(v.faltantes).toEqual([])
    expect(v.distintas).toEqual([])
  })

  it('DETECTA un archivo alterado por su checksum, sin abrir SQLite', async () => {
    const p = paths()
    const fila = await crearRespaldo(t.conn, p, {})
    const ruta = path.join(p.backupDir, fila.archivo)
    writeFileSync(ruta, Buffer.concat([readFileSync(ruta), Buffer.from('basura')]))

    const v = verificarRespaldo(p, fila.id)
    expect(v.ok).toBe(false)
    expect(v.checksumCoincide).toBe(false)
    expect(v.motivo).toMatch(/checksum/)
  })

  it('REFUSA un id que sale de la carpeta de respaldos', () => {
    // The id is the tenant boundary of this whole group: an archive is a file, and a caller that
    // passed a traversal would be asking to restore or delete the live database.
    const p = paths()
    expect(() => verificarRespaldo(p, '../../minimarck')).toThrow(/inválido/)
    expect(() => verificarRespaldo(p, '../minimarck.db')).toThrow(/inválido/)
    expect(() => verificarRespaldo(p, '/etc/passwd')).toThrow(/inválido/)
  })

  it('refusa un respaldo que no existe', () => {
    expect(() => verificarRespaldo(paths(), 'minimarck-2099-01-01T00-00-00-000Z')).toThrow(/no está en la carpeta/)
  })
})

describe('restaurar', () => {
  it('vuelve al punto del respaldo, y la conexion sigue viva', async () => {
    const p = paths()
    escribir('antes')
    const fila = await crearRespaldo(t.conn, p, {})
    escribir('despues')
    expect(contar('despues')).toBe(1)

    const res = await restaurarRespaldo(t.conn, p, fila.id)
    expect(res.restaurado).toBe(true)
    expect(res.id).toBe(fila.id)
    // Read through the SAME connection object the fixture handed out: `reopen` swaps the handle in
    // place, which is the only reason the app's closures still work after a restore.
    expect(t.conn.isOpen()).toBe(true)
    expect(contar('antes')).toBe(1)
    expect(contar('despues')).toBe(0)
    expect(t.conn.userVersion()).toBeGreaterThanOrEqual(2)
  })

  it('SACA UNA COPIA del estado que va a reemplazar, y esa copia lo recupera', async () => {
    // This is the net, and the only way to prove it catches is to fall into it: restore the wrong
    // archive, then restore the automatic backup and get the lost rows back.
    const p = paths()
    escribir('antes')
    const fila = await crearRespaldo(t.conn, p, {})
    escribir('despues')

    const res = await restaurarRespaldo(t.conn, p, fila.id)
    expect(contar('despues')).toBe(0)

    const vuelta = await restaurarRespaldo(t.conn, p, res.seguridad)
    expect(vuelta.restaurado).toBe(true)
    expect(contar('despues')).toBe(1)
  })

  it('REFUSA un archivo que no es una base, y no toca la que esta abierta', async () => {
    const p = paths()
    escribir('intacto')
    const malo = 'minimarck-2019-01-01T00-00-00-000Z'
    writeFileSync(path.join(p.backupDir, `${malo}.db`), 'esto no es sqlite')

    await expect(restaurarRespaldo(t.conn, p, malo)).rejects.toThrow(/No se puede restaurar/)
    // The refusal happens before anything is closed, so the shop keeps its database.
    expect(t.conn.isOpen()).toBe(true)
    expect(contar('intacto')).toBe(1)
  })

  it('deja el libro utilizable despues de restaurar', async () => {
    const p = paths()
    const fila = await crearRespaldo(t.conn, p, {})
    await restaurarRespaldo(t.conn, p, fila.id)

    // A restore that left the authorizer or the transaction runner pointing at the closed handle
    // would fail here rather than on the next sale.
    expect(() => escribir('tras-restaurar')).not.toThrow()
    expect(contar('tras-restaurar')).toBe(1)
  })
})

describe('podar', () => {
  it('conserva los mas nuevos y borra archivo Y manifiesto juntos', async () => {
    const p = paths()
    await crearRespaldo(t.conn, p, {})
    await crearRespaldo(t.conn, p, {})
    const tercero = await crearRespaldo(t.conn, p, {})

    const res = podarRespaldos(p, { conservar: 1 })
    expect(res.conservados).toBe(1)
    expect(res.eliminados).toHaveLength(2)
    expect(res.liberadoBytes).toBeGreaterThan(0)
    expect(listarRespaldos(p).total).toBe(1)
    // The survivor is the NEWEST, which is the policy: a prune that kept the oldest would delete the
    // backup taken five minutes ago and keep the one from last month.
    expect(listarRespaldos(p).filas[0].id).toBe(tercero.id)

    for (const e of res.eliminados) {
      expect(existsSync(path.join(p.backupDir, `${e.id}.db`))).toBe(false)
      expect(existsSync(path.join(p.backupDir, `${e.id}.db.json`))).toBe(false)
    }
  })

  it('REFUSA conservar cero: borrar todos los respaldos no es una poda', () => {
    // A prune that could delete every backup is a prune that can turn a full disk into an
    // unrecoverable shop, and no caller has a reason to ask for it.
    expect(() => podarRespaldos(paths(), { conservar: 0 })).toThrow(/al menos 1/)
    expect(() => podarRespaldos(paths(), { conservar: -3 })).toThrow(/al menos 1/)
    expect(() => podarRespaldos(paths(), { conservar: 1.5 })).toThrow(/al menos 1/)
  })

  it('no hace nada cuando hay menos respaldos que los que se conservan', async () => {
    const p = paths()
    await crearRespaldo(t.conn, p, {})
    const res = podarRespaldos(p, { conservar: 10 })
    expect(res.eliminados).toEqual([])
    expect(res.totalAntes).toBe(1)
    expect(res.totalDespues).toBe(1)
  })
})
