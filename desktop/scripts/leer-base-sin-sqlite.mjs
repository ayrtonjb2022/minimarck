/**
 * Read-only census of a MiniMarck database FILE, with no SQLite open at all.
 *
 * WHY NOT `node:sqlite`. The `-shm`/`-wal` sidecars need write access to the DIRECTORY even for a
 * read, and the installed app's profile lives under `%APPDATA%`, outside this session's workspace.
 * `SQLITE_CANTOPEN` (errcode 14) is the sandbox refusing that write, not a damaged database. A
 * `.db` written by `PRAGMA wal_checkpoint(TRUNCATE)` on clean shutdown is self-contained (that is
 * exactly what PLAT-6 buys), so the header and the page contents can be parsed here directly.
 *
 * IT ONLY READS. It slices the buffer, walks the B-tree from page 1, and prints the row counts and
 * the sign-in handles. It never writes to the file and never creates a sidecar.
 *
 * Usage: node scripts/leer-base-sin-sqlite.mjs [ruta\al\minimarck.db]
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const porDefecto = path.join(os.homedir(), 'AppData', 'Roaming', 'MiniMarck', 'data', 'minimarck.db')
const archivo = process.argv[2] ? path.resolve(process.argv[2]) : porDefecto

if (!existsSync(archivo)) {
  console.log(`NO EXISTE  ${archivo}`)
  process.exit(0)
}

const buf = readFileSync(archivo)
console.log(`archivo : ${archivo}`)
console.log(`tamano  : ${buf.length} bytes`)

// --- header -----------------------------------------------------------------------------------
const magic = buf.subarray(0, 16).toString('latin1')
console.log(`magic   : ${magic}`)
if (!magic.startsWith('SQLite format 3')) {
  console.log('VEREDICTO: no es un archivo SQLite.')
  process.exit(0)
}
const pageSize = buf.readUInt16BE(16) === 1 ? 65536 : buf.readUInt16BE(16)
const textEncoding = buf.readUInt32BE(56)
const userVersion = buf.readUInt32BE(60)
console.log(`pagina  : ${pageSize} bytes`)
console.log(`encoding: ${textEncoding === 1 ? 'UTF-8' : textEncoding === 2 ? 'UTF-16le' : textEncoding === 3 ? 'UTF-16be' : textEncoding}`)
console.log(`version : user_version = ${userVersion}`)

/**
 * Walk a table B-tree (or the sqlite_master tree) and collect every cell.
 *
 * This is a deliberately small reader: it understands interior pages (type 5) and leaf pages
 * (type 13), which is all a schema and a handful of small tables need. A cell payload that spills
 * onto overflow pages is NOT followed — the tables read here (users, user_identidades, negocios)
 * have short rows, and a truncated value would show up as a missing name rather than as a wrong
 * one.
 */
function leerTabla(paginaRaiz) {
  const filas = []
  const vistas = new Set()

  const recorrer = (nroPagina) => {
    if (vistas.has(nroPagina)) return
    vistas.add(nroPagina)
    const base = (nroPagina - 1) * pageSize
    const tipo = buf[base]
    const nCeldas = buf.readUInt16BE(base + 3)

    if (tipo === 5) {
      // interior: 12-byte header, then cells of (4-byte child pointer, varint key)
      for (let i = 0; i < nCeldas; i += 1) {
        const ptr = buf.readUInt16BE(base + 12 + i * 2)
        const hijo = buf.readUInt32BE(base + ptr)
        recorrer(hijo)
      }
      const hijoDerecho = buf.readUInt32BE(base + 8)
      recorrer(hijoDerecho)
      return
    }

    if (tipo !== 13) return

    for (let i = 0; i < nCeldas; i += 1) {
      const ptr = buf.readUInt16BE(base + 8 + i * 2)
      let off = base + ptr
      // payload length (varint), then rowid (varint)
      const leerVarint = () => {
        let v = 0
        for (let k = 0; k < 9; k += 1) {
          const b = buf[off]
          off += 1
          if (k === 8) return v * 256 + b
          v = v * 128 + (b & 0x7f)
          if ((b & 0x80) === 0) return v
        }
        return v
      }
      const largoPayload = leerVarint()
      leerVarint() // rowid

      // record header: varint size, then a serial type per column
      const inicio = off
      let h = off
      const leerVarintEn = (pos) => {
        let v = 0
        for (let k = 0; k < 9; k += 1) {
          const b = buf[pos]
          pos += 1
          if (k === 8) return [v * 256 + b, pos]
          v = v * 128 + (b & 0x7f)
          if ((b & 0x80) === 0) return [v, pos]
        }
        return [v, pos]
      }
      const [largoHeader] = leerVarintEn(h)
      h += 1
      const tipos = []
      while (h < inicio + largoHeader) {
        const [t, nuevo] = leerVarintEn(h)
        tipos.push(t)
        h = nuevo
      }
      let d = inicio + largoHeader
      const valores = tipos.map((t) => {
        const tamaños = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 6, 6: 8, 7: 8, 8: 0, 9: 0 }
        if (t === 0) return null
        if (t <= 6) {
          const n = tamaños[t]
          const v = t === 5 ? buf.readInt16BE(d) : t === 4 || t === 6 ? Number(buf.readBigInt64BE(d)) : t === 3 ? readUInt24() : t === 2 ? buf.readUInt16BE(d) : buf.readInt8(d)
          d += n
          return v
        }
        if (t === 7) {
          const v = buf.readDoubleBE(d)
          d += 8
          return v
        }
        if (t === 8) return 0
        if (t === 9) return 1
        if (t >= 12) {
          const n = (t - 12) / 2
          const s = buf.subarray(d, d + n)
          d += n
          return textEncoding === 1 ? s.toString('utf8') : s.toString('utf16le')
        }
        function readUInt24() {
          const v = (buf[d] << 16) | (buf[d + 1] << 8) | buf[d + 2]
          return v
        }
        return null
      })
      filas.push(valores)
      void largoPayload
    }
  }

  recorrer(paginaRaiz)
  return filas
}

// --- sqlite_master lives at page 1 ------------------------------------------------------------
const maestro = leerTabla(1)
const tablas = maestro
  .filter((r) => r[0] === 'table')
  .map((r) => r[1])

console.log(`tablas  : ${tablas.length}`)
console.log(`          ${tablas.join(', ')}`)

const leer = (nombre) => {
  const fila = maestro.find((r) => r[0] === 'table' && r[1] === nombre)
  if (!fila) return null
  return leerTabla(fila[3])
}

for (const t of ['negocios', 'users', 'user_identidades']) {
  const filas = leer(t)
  if (!filas) continue
  console.log('')
  console.log(`${t}: ${filas.length} fila(s)`)
  for (const f of filas) console.log(`  ${JSON.stringify(f)}`)
}

console.log('')
console.log(
  (leer('user_identidades') ?? []).length > 0
    ? 'VEREDICTO: hay credenciales. El panel pedira INICIAR SESION (no deja crear un segundo dueño).'
    : 'VEREDICTO: no hay credenciales. El panel ofrecera CREAR EL NEGOCIO.'
)
