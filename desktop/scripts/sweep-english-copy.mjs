/**
 * Sweep for user-visible strings that are still in English.
 *
 * WHY A SCRIPT AND NOT A GREP: the thing that matters is not "does the file contain the word
 * 'Search'" but "does a string a PERSON READS contain English". Comments are in English on
 * purpose — every module in this app explains itself in English and the owner never sees a
 * comment. A grep cannot tell the two apart, so it either drowns in comments or needs a
 * hand-written list of literals and misses the rest.
 *
 * So this reads the source, drops comments and template-literal holes, and keeps what is left:
 * string literals, JSX text and object-literal values. Of those, it prints the ones that look
 * English: two or more English words, and at least one of them not also a Spanish word.
 *
 * `html` and `css` are excluded because those files are markup and stylesheet, not copy.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

const RAIZ = process.argv[2] ?? 'src'
const EXT = new Set(['.js', '.jsx', '.mjs'])

// English words that are also common Spanish words, or that show up in CSS classes and
// identifiers. Without this list every `className="text-sm font-bold"` reads as English.
const COMUN = new Set([
  'de', 'la', 'el', 'no', 'a', 'y', 'en', 'con', 'un', 'una', 'que', 'por', 'para', 'del', 'al',
  'es', 'son', 'se', 'su', 'sus', 'lo', 'mas', 'menos', 'dia', 'dias', 'mes', 'anio', 'venta',
  'ventas', 'compra', 'compras', 'caja', 'producto', 'productos', 'cliente', 'clientes',
  'deudor', 'deudores', 'deuda', 'proveedor', 'proveedores', 'pago', 'pagos', 'gasto', 'gastos',
  'total', 'monto', 'fecha', 'nombre', 'estado', 'stock', 'precio', 'costo', 'iva', 'neto',
  'bruto', 'margen', 'caja', 'articulo', 'unidades', 'unidad', 'tarjeta', 'efectivo', 'credito',
  'transferencia', 'promedio', 'saldo', 'saldo', 'inicial', 'final', 'abrir', 'cerrar', 'nuevo',
  'nueva', 'editar', 'eliminar', 'buscar', 'guardar', 'cancelar', 'confirmar', 'volver',
  'siguiente', 'anterior', 'primero', 'ultimo', 'todos', 'ninguno', 'vacio', 'cargando', 'error',
  'ayuda', 'volver', 'titulo', 'descripcion', 'observaciones', 'notas', 'telefono', 'email',
  'direccion', 'contacto', 'activo', 'inactivo', 'pendiente', 'completada', 'cancelada',
  'papel', 'metal', 'plastico', 'vidrio', 'carton', 'unidad', 'kilo', 'gramo', 'litro',
  'pan', 'queso', 'gaseosa', 'bebida', 'almacen', 'kiosco', 'negocio', 'sucursal', 'caja',
  'session', 'user', 'role', 'admin', 'supervisor', 'vendedor', 'ventas'
])

const PALABRA = /[A-Za-zÁÉÍÓÚáéíóúÑñ]{3,}/g

/** Strip line and block comments, so English in prose is not mistaken for English in copy. */
function sinComentarios(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

/** Every string literal, JSX text node and object value that a person could read on screen. */
function literales(src) {
  const fuera = []
  // "doble", 'simple' and `plantilla`
  for (const m of src.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) fuera.push(m[1])
  for (const m of src.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) fuera.push(m[1])
  for (const m of src.matchAll(/`((?:[^`\\]|\\.)*)`/g)) fuera.push(m[1])
  return fuera
    .flatMap((t) => t.split(/\$\{[^}]*\}/))
    .map((t) => t.trim())
    .filter((t) => t.length > 1)
}

function pareceIngles(texto) {
  // A bare identifier, a URL, a path, a class list or a code snippet is not copy.
  if (/^[\w./#:@-]+$/.test(texto)) return false
  if (/^(https?:|app:|minimarck:|\/)/.test(texto)) return false
  if (/[{}<>;=|^~`]/.test(texto)) return false
  if (/^[a-z-]+(\s+[a-z-]+)*$/.test(texto) && /^[a-z-]+$/.test(texto.split(' ')[0])) {
    // kebab-case tokens: class names and ids
    if (!/\s/.test(texto)) return false
  }
  const palabras = texto.match(PALABRA) ?? []
  if (palabras.length < 2) return false
  const inglesas = palabras.filter((p) => !COMUN.has(p.toLowerCase()))
  if (inglesas.length < 2) return false
  // Two or more words that are NOT Spanish words, and a space: the shape of an English phrase.
  return inglesas.length >= 2 && / /.test(texto)
}

function archivos(dir) {
  const salida = []
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre)
    if (statSync(ruta).isDirectory()) salida.push(...archivos(ruta))
    else if (EXT.has(extname(nombre))) salida.push(ruta)
  }
  return salida
}

let hallazgos = 0
for (const ruta of archivos(RAIZ)) {
  const src = sinComentarios(readFileSync(ruta, 'utf8'))
  for (const texto of literales(src)) {
    if (pareceIngles(texto)) {
      hallazgos += 1
      console.log(`${relative('.', ruta)} :: ${JSON.stringify(texto)}`)
    }
  }
}
console.log(`\n${hallazgos} cadenas en inglés que ve una persona`)
