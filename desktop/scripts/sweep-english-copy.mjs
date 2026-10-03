/**
 * Sweep for user-visible strings that are still in English.
 *
 * WHY A SCRIPT AND NOT A GREP: the thing that matters is not "does the file contain the word
 * 'Search'" but "does a string a PERSON READS contain English". Comments are in English on
 * purpose — every module in this app explains itself in English and the owner never sees a
 * comment. A grep cannot tell the two apart, so it either drowns in comments or needs a
 * hand-written list of literals and misses the rest.
 *
 * WHAT COUNTS AS COPY, and what does not:
 *
 *   - `src/renderer/app/**` — JSX text and string props. This is the interface.
 *   - `src/main/**`       — only the message of a thrown `IpcError`/`Error`, because that is the
 *                           one thing main puts in front of a person through the bridge.
 *
 * Excluded on purpose: `*-drive.js` and `spike/` are automation, `probe.js` is the security probe.
 * None of them render, and all three are full of JavaScript that a grep for English would report
 * as untranslated copy. Also excluded: SQL, because `GROUP BY` and `ORDER BY` are English words,
 * and markup, because a print stylesheet is not a sentence.
 *
 * THE FIRST TWO VERSIONS OF THIS SCRIPT WERE WRONG, AND THE REASONS ARE THE POINT:
 *
 * 1. Scoring a string by how many words it did NOT recognise flagged "La contraseña necesita al
 *    menos" as English, because `contraseña` was not on the Spanish list. A Spanish sentence about
 *    a subject nobody listed is indistinguishable from English that way. The discriminator has to
 *    be POSITIVE: a closed set of English words Spanish cannot spell.
 *
 * 2. Two English words is a PHRASE and one is a coincidence. "Unknown group:" is English;
 *    "1.1.01 Caja" is not.
 *
 * `html` and `css` files are skipped: those are markup and stylesheets, not copy.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

const EXT = new Set(['.js', '.jsx', '.mjs'])

/**
 * WORDS SPANISH CANNOT PRODUCE. `de`, `la`, `el`, `no`, `a`, `y`, `con`, `en`, `un`, `una`,
 * `que`, `para` and `error` are DELIBERATELY ABSENT — they are Spanish words too, so they prove
 * nothing. A marker that Spanish also spells is not evidence of anything.
 */
const INGLES_SOLO = new Set([
  'the', 'is', 'are', 'was', 'were', 'be', 'been', 'this', 'that', 'these', 'those', 'its', 'they',
  'them', 'their', 'such', 'each', 'every', 'any', 'some', 'none', 'both', 'into', 'onto', 'over',
  'under', 'above', 'below', 'between', 'through', 'during', 'before', 'after', 'while', 'when',
  'then', 'than', 'else', 'not', 'only', 'also', 'still', 'already', 'must', 'should', 'shall',
  'cannot', 'could', 'would', 'will', 'can', 'may', 'might', 'ought', 'of', 'to', 'and', 'or',
  'for', 'with', 'from', 'by', 'as', 'at', 'on', 'an', 'per', 'via', 'if', 'do', 'does', 'did',
  'done', 'has', 'have', 'had', 'what', 'which', 'who', 'whose', 'there', 'here', 'now', 'never',
  'always', 'often', 'please', 'thanks', 'hello', 'loading', 'search', 'settings', 'file', 'files',
  'name', 'names', 'value', 'values', 'data', 'item', 'items', 'list', 'save', 'saved', 'delete',
  'deleted', 'open', 'close', 'closed', 'unknown', 'unhandled', 'invalid', 'required', 'missing',
  'failed', 'failure', 'unexpected', 'denied', 'forbidden', 'unable', 'empty', 'exists', 'alone',
  'default', 'null', 'void', 'enough', 'less', 'more', 'most', 'least', 'own', 'same', 'toward',
  'off', 'out', 'up', 'down', 'again', 'once', 'ever', 'very', 'just', 'quite', 'rather', 'soon'
])

const PALABRA = /[A-Za-zÁÉÍÓÚáéíóúÑñ']+/g

/** SQL is not copy, and it is written in English keywords. Matched ANYWHERE, not just at the start. */
const SQL = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|FROM|WHERE|GROUP\s+BY|ORDER\s+BY|JOIN|VALUES|PRAGMA|INTO|ESCAPE|COALESCE|CREATE\s+TABLE|IS\s+NULL|IS\s+NOT|NOT\s+NULL)\b/i

/** Markup, generic-parameter strings and print stylesheets are not sentences. */
const MARCA = /[<>{}]/

/** `nopmva` — automation and diagnostics. They render nothing. */
const NO_ES_COPY = /(-drive\.js|[\\/]spike[\\/]|probe\.js)$/

function sinComentarios(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

/** Every candidate string: quoted literals, plus JSX text nodes, which are NOT quoted. */
function literales(src) {
  const fuera = []
  // A CSS class list is not a sentence. `className="flex items-center justify-between"` is three
  // English words and was the single loudest false positive in the whole sweep.
  const sinClases = src.replace(/(className|class)\s*=\s*(?:"[^"]*"|'[^']*'|\{`[^`]*`\})/g, ' ')
  for (const m of sinClases.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) fuera.push(m[1])
  for (const m of sinClases.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) fuera.push(m[1])
  for (const m of sinClases.matchAll(/`((?:[^`\\]|\\.)*)`/g)) fuera.push(m[1])
  // `<p>Todavía no hay ventas registradas.</p>` is a literal to a reader and invisible to a
  // quoted-string regex. THIS WAS A REAL HOLE: every untranslated JSX TEXT NODE passed the sweep.
  for (const m of sinClases.matchAll(/>([^<>{}]{2,}?)</g)) fuera.push(m[1])
  return fuera
    .flatMap((t) => t.split(/\$\{[^}]*\}/))
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 1)
}

function pareceIngles(texto) {
  if (SQL.test(texto)) return false
  if (MARCA.test(texto)) return false
  if (/^(https?:|app:|minimarck:|data:|\/)/.test(texto)) return false
  if (!/\s/.test(texto)) return false
  const palabras = (texto.match(PALABRA) ?? []).map((p) => p.toLowerCase())
  return palabras.filter((p) => INGLES_SOLO.has(p)).length >= 2
}

function archivos(dir) {
  const salida = []
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre)
    if (statSync(ruta).isDirectory()) salida.push(...archivos(ruta))
    else if (EXT.has(extname(nombre)) && !NO_ES_COPY.test(nombre) && !NO_ES_COPY.test(ruta)) {
      salida.push(ruta)
    }
  }
  return salida
}

/** Only the messages main actually shows: the text of a thrown IpcError/Error. */
function mensajesDeMain(src) {
  const fuera = []
  for (const m of src.matchAll(/new\s+IpcError\(\s*'[^']+'\s*,\s*\d+\s*,\s*([\s\S]*?)\)/g)) fuera.push(m[1])
  for (const m of src.matchAll(/new\s+Error\(\s*([`'"][\s\S]*?[`'"])\s*\)/g)) fuera.push(m[1])
  return fuera
}

let hallazgos = 0
for (const [raiz, soloMensajes] of [
  ['src/renderer/app', false],
  ['src/main', true]
]) {
  for (const ruta of archivos(raiz)) {
    const src = sinComentarios(readFileSync(ruta, 'utf8'))
    for (const bruto of soloMensajes ? mensajesDeMain(src) : literales(src)) {
      for (const texto of bruto.split(/\$\{[^}]*\}/).map((t) => t.replace(/\s+/g, ' ').trim())) {
        if (texto.length > 1 && pareceIngles(texto)) {
          hallazgos += 1
          console.log(`${relative('.', ruta)} :: ${JSON.stringify(texto)}`)
        }
      }
    }
  }
}
console.log(`\n${hallazgos} cadenas en inglés que ve una persona`)