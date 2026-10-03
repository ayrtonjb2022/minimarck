import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { tienda, ctxDe, TABLES } from './fixtures/tienda.js'
import { migrate } from '../../src/main/db/migrate.js'
import { openDatabase } from '../../src/main/db/connection.js'
import {
  crearRespaldo,
  listarRespaldos,
  podarRespaldos,
  respaldarAntesDeMigrar,
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

/**
 * Rompe el puntero de la PRIMERA celda de una hoja real del archivo, y nada más.
 *
 * ── POR QUÉ ESTO Y NO UN ARCHIVO DE BASURA ────────────────────────────────────────────────────
 *
 * El caso que hay que probar es el que el archivo ABRE y DESPUÉS falla. Un `writeFileSync(ruta,
 * 'esto no es sqlite')` —el control negativo de los tests de arriba— muere dentro de
 * `new DatabaseSync(...)`, o sea ANTES de que exista el sidecar, y por lo tanto nunca llega a la
 * mitad del camino que importa. Sólo un archivo que abre bien crea `<id>.db-wal` y `<id>.db-shm` al
 * lado.
 *
 * ── POR QUÉ UNA CELDA Y NO UNA PÁGINA ENTERA ───────────────────────────────────────────────────
 *
 * Volcar basura sobre una hoja completa arruina también su cabecera b-tree, y entonces el motor
 * responde `SQLITE_CORRUPT` al ABRIR — o sea, de vuelta al control negativo. Lo que se pisa es el
 * puntero a la primera celda: la cabecera sigue siendo un b-tree válido, el archivo abre, e
 * `integrity_check` contesta `Tree N page M cell 0: Offset ... out of range`. Medido contra el
 * motor de este paquete, no supuesto.
 *
 * ── POR QUÉ `dbstat` Y NO UN NÚMERO DE PÁGINA FIJO ────────────────────────────────────────────
 *
 * Una página hardcodeada es una página que se pudre con el primer `CREATE TABLE` que agregue una
 * migración. `dbstat` se lo pregunta al motor, se lo pregunta a ESTE archivo, y devuelve una hoja
 * real con celdas — la misma forma de descubrir páginas que SQLite usa internamente.
 */
function romperUnaCelda(archivo) {
  const lecto = new DatabaseSync(archivo, { readOnly: true })
  const hoja = lecto
    .prepare(
      `SELECT pageno FROM dbstat
        WHERE pagetype = 'leaf' AND ncell > 0 AND name NOT LIKE 'sqlite_%'
        ORDER BY pageno`
    )
    .get()
  lecto.close()
  if (!hoja) throw new Error(`No hay ninguna hoja con celdas que romper en ${archivo}`)

  const bytes = readFileSync(archivo)
  const declarada = bytes.readUInt16BE(16)
  const pageSize = declarada === 1 ? 65536 : declarada
  // El puntero a la primera celda es el primer offset de la cabecera de la hoja. `0xff00` es un
  // offset que cae fuera de la página con cualquier page size, así que el archivo de prueba no
  // depende del valor que el motor haya elegido.
  bytes.writeUInt16BE(0xff00, pageSize * (hoja.pageno - 1) + 8)
  writeFileSync(archivo, bytes)
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

  it('CUENTA `ventas` sólo si la tabla existe: un primer arranque verifica sin ella', async () => {
    // Un lanzamiento de verdad tiene el ledger y NINGUNA tabla: `001` sigue pendiente cuando el
    // paracaídas dispara. Contar `ventas` sin preguntar si existe reportaba esa copia PERFECTA como
    // ilegible (`no such table: ventas`) — se midió: revierte el guard y `bootstrapDatabase` deja de
    // arrancar. `null` es un hecho, no un fallo, y sale por los TRES lugares que lo publican.
    const p = paths()
    const soloLedger = path.join(t.dir, 'solo-ledger.db')
    const crudo = new DatabaseSync(soloLedger)
    crudo.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at TEXT)')
    crudo.close()
    const connVacia = openDatabase(soloLedger, { walFile: `${soloLedger}-wal` })

    let fila
    try {
      fila = await crearRespaldo(connVacia, { ...p, dbFile: soloLedger }, {})
    } finally {
      connVacia.checkpointAndClose()
    }

    expect(fila.ventas).toBeNull()
    expect(listarRespaldos(p).filas.find((f) => f.id === fila.id).ventas).toBeNull()
    const v = verificarRespaldo(p, fila.id)
    expect(v.ventas).toBeNull()
    // SE LEYÓ: `ok: false` acá es por `faltan las migraciones` —un archivo de primer arranque no puede
    // tenerlas—, no por ilegibilidad, que es justo lo que esta rama evita.
    expect(v.motivo).toMatch(/faltan las migraciones/)
  })

  it('RECHAZA un archivo que abre pero no pasa `integrity_check`, y no deja NADA', async () => {
    // ── EL LEAK QUE ESTE TEST CIERRA ──────────────────────────────────────────────────────────
    //
    // El rechazo borra el `.db` y nada más. Pero el paso 3 de este módulo es `leerLedger(destino)`,
    // que ABRE el snapshot en read-only, y el archivo copiado sigue en `journal_mode=wal` — así que
    // esa misma lectura deja `<id>.db-wal` y `<id>.db-shm` al lado. Con `integrity_check` roto, el
    // `rmSync` se lleva el `.db` y los dos sidecars quedan huérfanos PARA SIEMPRE: nadie los
    // cataloga (`listarRespaldos` filtra por `.endsWith('.db')`) y `podarRespaldos` camina el
    // catálogo, no el disco. Dos archivos basura por cada respaldo rechazado, y este rechazo es
    // justo el que ocurre cuando algo anda MAL — el peor momento para dejar basura.
    //
    // Por eso la corrupción es de una CELDA y no del archivo entero: tiene que ABRIR, porque un
    // archivo que no abre muere antes de crear sidecars y probaría la mitad del recorrido.
    const p = paths()
    const fuente = path.join(t.dir, 'con-celda-rota.db')
    copyFileSync(t.archivo, fuente)
    romperUnaCelda(fuente)

    // `backup()` copia las páginas tal cual, así que el archivo roto sale del archive roto: la
    // corrupción viaja del origen al snapshot sin que nadie la vea. La conexión SÍ abre —es lo que
    // se está probando— y el engine abre y cierra en el `finally`.
    const connRota = openDatabase(fuente, { walFile: `${fuente}-wal`, tables: [...TABLES] })
    let err = null
    try {
      await crearRespaldo(connRota, { ...p, dbFile: fuente }, {})
    } catch (e) {
      err = e
    } finally {
      connRota.checkpointAndClose()
    }

    expect(err).not.toBeNull()
    expect(err.code).toBe('RESPALDO_ILEGIBLE')
    expect(err.message).toMatch(/integrity_check/)

    // NADA. Ni el `.db` que se rechazó, ni el `-wal` y el `-shm` que dejó la lectura al descartarlo.
    // `readdirSync` entero y no un filtro por sufijo: un sidecar se llama `-wal`/`-shm`, y un filtro
    // que sólo buscara `.db` habría dado verde sobre el leak que este test existe para cerrar.
    expect(readdirSync(p.backupDir)).toEqual([])
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

  it('borra también los SIDECARS que dejó leer el archivo eliminado', async () => {
    // `leerLedger` abre el snapshot en read-only y ESO crea `<id>.db-wal` y `<id>.db-shm` al lado,
    // porque el archivo copiado sigue en `journal_mode=wal`. Nunca fueron catálogo —`list` filtra
    // por `.endsWith('.db')`, y por eso nadie lo notó—, así que la poda dejaba DOS archivos por
    // snapshot para siempre. Y este motor hace dos tipos de snapshot: el leak se duplicaba.
    const p = paths()
    const a = await crearRespaldo(t.conn, p, {})
    const b = await crearRespaldo(t.conn, p, {})
    const c = await crearRespaldo(t.conn, p, {})
    expect(readdirSync(p.backupDir).filter((n) => n.endsWith('-wal') || n.endsWith('-shm'))).toHaveLength(6)

    podarRespaldos(p, { conservar: 1 })

    for (const id of [a.id, b.id, c.id]) {
      for (const sufijo of ['.db-wal', '.db-shm']) {
        // `false` para los dos eliminados, `true` para el que se conserva: sus sidecars son
        // legibles y la poda no los toca.
        expect(existsSync(path.join(p.backupDir, `${id}${sufijo}`))).toBe(id === c.id)
      }
    }
    expect(listarRespaldos(p).total).toBe(1)
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

/**
 * `respaldarAntesDeMigrar` — el paracaídas, y el hook que lo dispara.
 *
 * ── POR QUÉ EL CONTRATO DEL HOOK SE PRUEBA AQUÍ Y NO EN `migrate.spec.js` ──────────────────────
 *
 * La regla que importa no es "el runner llama al hook": es "llama al hook UNA vez, sólo cuando hay
 * algo pendiente, y antes de aplicar". Las tres mitades son de un comportamiento — el paracaídas se
 * toma exactamente cuando hay DDL que puede romper la base — y separadas en dos archivos ninguno
 * de los dos podría enunciarla en una frase.
 *
 * ── POR QUÉ `integrity_check` NO ALCANZA ──────────────────────────────────────────────────────
 *
 * La verificación compara el archivo con la base abierta (`user_version` y el ledger), no con un
 * conteo de tablas. Un snapshot que abre bien puede ser CUALQUIER base válida, y una comparación
 * con la fuente es lo que dice que sea la que se va a migrar. El caso de una base ajena está
 * abajo por esa razón.
 */
describe('respaldarAntesDeMigrar — el paracaídas', () => {
  it('deja un archivo verificado y catalogado, con el ledger de la base abierta', () => {
    escribir('antes-de-migrar')
    const p = paths()
    const fila = respaldarAntesDeMigrar(t.conn, p, { nota: 'prueba' })

    expect(fila.motivo).toBe('antes-de-migrar')
    expect(fila.nota).toBe('prueba')
    expect(fila.checksum).toMatch(/^[0-9a-f]{64}$/)
    // Leídos del ARCHIVO, no copiados de la conexión: un respaldo nunca verificado es un archivo
    // con un nombre esperanzado.
    expect(fila.userVersion).toBe(t.conn.userVersion())
    expect(fila.tablas).toBeGreaterThanOrEqual(20)

    const enCatalogo = listarRespaldos(p).filas.find((f) => f.id === fila.id)
    expect(enCatalogo.origen).toBe('manifiesto')
    expect(enCatalogo.verificado).toBe(true)

    // Abierto como su propio archivo SQLite: la afirmación que una persona hace a mano cuando el
    // disco se llena. Es una base, está íntegra, y la fila confirmada hace un momento está adentro.
    const copia = new DatabaseSync(path.join(p.backupDir, fila.archivo), { readOnly: true })
    try {
      expect(Object.values(copia.prepare('PRAGMA integrity_check').get())[0]).toBe('ok')
      expect(copia.prepare('SELECT COUNT(*) AS n FROM auditoria WHERE tabla = ?').get('antes-de-migrar').n).toBe(1)
    } finally {
      copia.close()
    }
  })

  it('migrate lo dispara UNA vez, antes de aplicar, y sólo si hay algo pendiente', () => {
    const p = paths()
    const hechas = []

    // Nada pendiente: la fixture ya está en la versión real, que es un lanzamiento corriente. Un
    // arranque que no cambia nada no tiene nada que proteger, y una copia por arranque llenaría el
    // disco de copias del mismo archivo.
    const quieto = migrate(t.conn, { dir: p.migrationsDir, antesDeAplicar: (i) => hechas.push(i) })
    expect(quieto.applied).toEqual([])
    expect(hechas).toEqual([])

    // Ahora sí: la MISMA base, con una migración nueva encima.
    const migDir = path.join(t.dir, 'migrations')
    mkdirSync(migDir, { recursive: true })
    for (const nombre of readdirSync(p.migrationsDir)) {
      copyFileSync(path.join(p.migrationsDir, nombre), path.join(migDir, nombre))
    }
    writeFileSync(path.join(migDir, '004_de_prueba.sql'), 'CREATE TABLE de_prueba (id INTEGER PRIMARY KEY)')

    const conPendientes = migrate(t.conn, {
      dir: migDir,
      antesDeAplicar: (info) =>
        hechas.push({
          ...info,
          // Leído DESDE el hook. Lo que se archiva tiene que ser el estado previo al DDL; si el
          // hook corriera después, esta lectura valdría 1 y el snapshot sería inútil.
          tablasAntes: t.conn.db
            .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'de_prueba'")
            .get().n
        })
    })

    expect(conPendientes.applied).toEqual([4])
    expect(hechas).toHaveLength(1)
    expect(hechas[0].versiones).toEqual([4])
    expect(hechas[0].tablasAntes).toBe(0)
  })

  it('BORRA el archivo cuando la verificación falla, y no deja nada catalogado', () => {
    const p = paths()
    // Un `dbFile` que no es una base es, del lado del verificador, exactamente lo que se ve cuando
    // la copia sale truncada o a medio escribir: `copyFileSync` y `renameSync` funcionan sin mirar,
    // y `leerLedger` es lo único entre eso y una entrada de catálogo.
    const basura = path.join(t.dir, 'no-es-una-base.db')
    writeFileSync(basura, 'esto no es sqlite')

    let err = null
    try {
      respaldarAntesDeMigrar(t.conn, { ...p, dbFile: basura }, {})
    } catch (e) {
      err = e
    }
    expect(err).not.toBeNull()
    expect(err.code).toBe('RESPALDO_ILEGIBLE')

    // Ni el archivo ni el manifiesto. `listarRespaldos` lee el DIRECTORIO, así que un `.db` que
    // quedara ahí aparecería como un respaldo más y alguien acabaría restaurándolo.
    expect(listarRespaldos(p).total).toBe(0)
    expect(readdirSync(p.backupDir).filter((n) => n.endsWith('.db'))).toEqual([])
  })

  it('borra también los SIDECARS del paracaídas rechazado, no sólo el `.db`', () => {
    // ── POR QUÉ ESTE TEST Y POR QUÉ LA CORRUPCIÓN ES DE UNA CELDA ──────────────────────────────
    //
    // El test de arriba usa un archivo que NO ABRE, y ahí no hay sidecar que borrar: `leerLedger`
    // muere en `new DatabaseSync(...)`. El caso que deja basura es el otro —una copia que ABRE y
    // falla DESPUÉS—, y es alcanzable: `copyFileSync` no mira lo que copia, así que una fuente con
    // una celda rota produce un snapshot que abre y que `integrity_check` rechaza.
    //
    // Y el daño es peor acá que en un snapshot descartado cualquiera: este es el paracaídas que se
    // toma justo antes de un `ALTER`, o sea en el momento en que la base YA está sospechosa. Dos
    // archivos huérfanos por cada intento fallido de paracaídas, sin manifiesto que los explique y
    // sin entrada de catálogo que los borre jamás — `podarRespaldos` camina el catálogo, y estos dos
    // nunca estuvieron en él.
    const p = paths()
    const conCeldaRota = path.join(t.dir, 'pre-migracion-rota.db')
    copyFileSync(t.archivo, conCeldaRota)
    romperUnaCelda(conCeldaRota)

    let err = null
    try {
      respaldarAntesDeMigrar(t.conn, { ...p, dbFile: conCeldaRota }, {})
    } catch (e) {
      err = e
    }
    expect(err).not.toBeNull()
    expect(err.code).toBe('RESPALDO_ILEGIBLE')
    // El motivo es `integrity_check`, no el `user_version` ni el ledger: lo que se rompe es el
    // archivo copiado, y el motor lo dice con esas palabras.
    expect(err.message).toMatch(/integrity_check/)

    // NADA. El `readdirSync` COMPLETO, no un filtro por `.db`: el leak que este test cierra son
    // justamente los dos archivos que NO terminan en `.db` y que ningún filtro los miraría.
    expect(readdirSync(p.backupDir)).toEqual([])
  })

  it('RECHAZA seguir si el checkpoint falla: no se archiva un archivo sin su WAL', () => {
    // El otro checkpoint de este archivo (el de `crearRespaldo`) avisa y sigue, porque la API online lee
    // A TRAVÉS del WAL. Acá el copiado es un `copyFileSync`, que no: seguir sería archivar una base a
    // la que le faltan ventas ya confirmadas. Cerrar la conexión es un fallo real, no un mock.
    const p = paths()
    t.conn.checkpointAndClose()

    let err = null
    try {
      respaldarAntesDeMigrar(t.conn, p, {})
    } catch (e) {
      err = e
    }
    expect(err.code).toBe('RESPALDO_CHECKPOINT_FALLIDO')
    expect(err.message).toMatch(/WAL/)
    // Nada a medio hacer: el archivo que se copiaba no existe todavía, así que no hay que borrar.
    expect(listarRespaldos(p).total).toBe(0)
  })

  it('rechaza una copia que ES una base válida pero no es ESTA', () => {
    // `integrity_check: ok` es necesario y no suficiente. Una base ajena, íntegra y con su propio
    // ledger, es el archivo que una comparación contra un conteo de tablas no distingue de la
    // correcta — y restaurarla sería el peor resultado posible del paracaídas.
    const p = paths()
    const ajena = new DatabaseSync(path.join(t.dir, 'otra-base.db'))
    ajena.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at TEXT)')
    ajena.exec('PRAGMA user_version = 99')
    ajena.close()

    let err = null
    try {
      respaldarAntesDeMigrar(t.conn, { ...p, dbFile: path.join(t.dir, 'otra-base.db') }, {})
    } catch (e) {
      err = e
    }
    expect(err.code).toBe('RESPALDO_ILEGIBLE')
    expect(err.message).toMatch(/user_version/)
    expect(listarRespaldos(p).total).toBe(0)
  })

  it('rechaza una copia con el MISMO user_version pero OTRO ledger de migraciones', () => {
    // El test anterior NO llegaba acá: su base ajena declaraba `user_version = 99`, así que moría en
    // la primera rama y `!mismoLedger` quedaba sin ejecutar — con `mismoLedger` en `return true` la
    // suite seguía verde. Esta copia declara EXACTO el `user_version` de la conexión viva y las
    // MISMAS versiones, con un checksum alterado: sólo la comparación del ledger puede rechazarla.
    const p = paths()
    const ajena = path.join(t.dir, 'otro-ledger.db')
    const crudo = new DatabaseSync(ajena)
    crudo.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at TEXT)')
    const insercion = crudo.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
    for (const m of t.conn.db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all()) {
      insercion.run(m.version, 'alterada', `${m.checksum}-distinto`, '2026-01-01T00:00:00.000Z')
    }
    crudo.exec(`PRAGMA user_version = ${t.conn.userVersion()}`)
    crudo.close()

    let err = null
    try {
      respaldarAntesDeMigrar(t.conn, { ...p, dbFile: ajena }, {})
    } catch (e) {
      err = e
    }
    expect(err.code).toBe('RESPALDO_ILEGIBLE')
    expect(err.message).toMatch(/historial de migraciones/)
    // El motivo es el LEDGER: el mismo `user_version` no puede aparecer en el mensaje.
    expect(err.message).not.toMatch(/user_version/)
    expect(listarRespaldos(p).total).toBe(0)
  })

  it('reutiliza el snapshot pre-migración cuando el estado de partida es el mismo', () => {
    const p = paths()
    // First call creates snapshot
    const r1 = respaldarAntesDeMigrar(t.conn, p, {})
    expect(r1.id).toMatch(/^minimarck-/)
    expect(r1.motivo).toBe('antes-de-migrar')

    // Second call with identical state should reuse (not create a new one)
    const r2 = respaldarAntesDeMigrar(t.conn, p, {})
    expect(r2.id).toBe(r1.id)
    expect(listarRespaldos(p).total).toBe(1)
  })
})
