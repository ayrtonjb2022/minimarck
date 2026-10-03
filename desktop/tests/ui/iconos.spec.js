import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/**
 * THE ICONS THE JSX ASKS FOR MUST HAVE A GLYPH.
 *
 * ── THE BUG THIS EXISTS TO CATCH ──────────────────────────────────────────────────────────────
 *
 * `styles/icons.css` replaces the Font Awesome CDN with one inline SVG data-URI per glyph, keyed by
 * the class the vendored JSX already writes (`className="fa-solid fa-search"`). The base rule gives
 * EVERY `.fa-solid` a 1em box and `background-color: currentColor`; the glyph itself is a
 * `mask-image` that a per-icon rule supplies.
 *
 * So a class with no rule is not a missing icon and not an error — it is a small EMPTY BOX that
 * renders at the right size, takes the right space, and shows nothing. It fails silently in the
 * most expensive way a UI can: it looks deliberate.
 *
 * That is not hypothetical. Seventeen classes were in that state when this test was written, and
 * they were the ones an operator looks at most: the "Buscar" button on the debtors screen, the
 * customers/searches/suppliers entries in the top bar, six of the ten report tabs, and the "Cargar
 * catálogo de ejemplo" button on a brand-new install. Nothing in the suite could see any of it,
 * because a test asserting "the app rendered" is satisfied by an empty box.
 *
 * ── WHY BOTH DIRECTIONS ARE ASSERTED ──────────────────────────────────────────────────────────
 *
 * The forward check is the one that matters: every `fa-*` class the JSX writes has a glyph. The
 * reverse check (every glyph is used) is reported but NOT enforced — a glyph can be legitimately
 * unused while a screen is being built, and failing on that would push a reviewer to delete an
 * icon five minutes before it is needed. It is asserted here only as a number, so the file cannot
 * grow without anyone noticing.
 *
 * ── AND WHY THERE IS A NEGATIVE CONTROL ───────────────────────────────────────────────────────
 *
 * A checker that cannot fail is not a checker. The second `describe` runs the same function against
 * a synthetic source containing a class that is definitely not in the stylesheet, and requires it to
 * be reported. Without that, a typo in the regex below — `fa-[a-z0-9-]*` with a star, say, matching
 * the empty string — would make the whole file pass while the drift came back.
 */

/**
 * Where the renderer lives, anchored on the process CWD.
 *
 * This used to be `join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer')`, which
 * resolved to `<desktop>/tests/src/renderer` — ONE LEVEL TOO SHALLOW, because this file is under
 * `tests/ui/`, not `tests/`. The stylesheet therefore was not found at COLLECTION time and the file
 * contributed ZERO tests: the forward check, the mask check, and — worst of all — the deliberate
 * `NEGATIVE CONTROL: the checker can actually fail` block below were all running against nothing
 * while `npm test` reported this file as simply absent from the run. Fifty-five source files and
 * roughly 11,900 lines were going unscanned and no gate noticed, which is the exact failure the
 * vacuity check in the first `it()` was written to catch — it could not, because it never ran.
 *
 * The CWD anchor is the repo's OWN convention and not a fresh invention: `tests/db/fixtures/tienda.js:37-49`
 * already records this exact anti-pattern, notes that it "stopped working the moment `tests/ui/`
 * arrived", and replaced it with a `process.cwd()` walk plus an `existsSync` guard. Vitest roots
 * every run at `desktop/`, which is the directory that actually holds `src/renderer`.
 */
const desktopRoot = resolve(process.cwd())
const dirRenderer = resolve(process.cwd(), 'src', 'renderer')
const archivoCss = join(dirRenderer, 'app', 'styles', 'icons.css')

if (!existsSync(archivoCss)) {
  throw new Error(
    `No se encuentra la hoja de iconos en ${archivoCss}. ` +
      `Este spec se ancla en el CWD (${process.cwd()}); corré los tests desde desktop/.`
  )
}

/** Every file under `src/renderer/` whose extension can carry a `className`. */
function archivosFuente(dir) {
  const salida = []
  for (const entrada of readdirSync(dir)) {
    const ruta = join(dir, entrada)
    if (statSync(ruta).isDirectory()) {
      salida.push(...archivosFuente(ruta))
    } else if (/\.(jsx?|html)$/.test(entrada)) {
      salida.push(ruta)
    }
  }
  return salida
}

/**
 * Font Awesome classes the stylesheet DEFINES, as a set of bare names.
 *
 * The CSS writes them as `.fa-solid.fa-search` (compound, so the glyph only applies to an element
 * that also carries the style class), so `\.fa-[a-z0-9-]+` over the whole file collects both
 * halves — `fa-solid` included. It is filtered out by the caller.
 */
function glifosDefinidos(css) {
  return new Set([...css.matchAll(/\.(fa-[a-z0-9-]+)/g)].map((m) => m[1]))
}

/**
 * Font Awesome classes the SOURCE asks for.
 *
 * Only strings, deliberately: a `className={` template like
 * `` `fa-solid ${debe > 0 ? "fa-coins" : "fa-eye"}` `` is two separate literals in the file, and
 * scanning the raw text catches both. Parsing JSX would be more precise and would also MISS a
 * class assembled at runtime — the failure mode is that the icon is blank either way.
 *
 * THE TRAILING `(?![a-z0-9-])` IS LOAD-BEARING. `Sidebar.jsx` writes
 * `` `fa-solid fa-chevron-${collapsed ? "right" : "left"}` ``, so the raw text contains the
 * fragment `fa-chevron-`. Without the lookahead that half-name is collected as a class, the
 * stylesheet has no `.fa-chevron`, and the checker reports a failure that is about the scanner
 * rather than about the code. Requiring the match not to continue into another name-ish character
 * drops the fragment and keeps the real classes (`fa-chevron-left`, written literally in four other
 * files) intact.
 */
function glifosUsados(texto) {
  const encontrados = new Set()
  for (const m of texto.matchAll(/\b(fa-[a-z0-9-]*[a-z0-9])(?![a-z0-9-])/g)) encontrados.add(m[1])
  // `fa-solid`/`fa-regular` are the STYLE classes: the base rule styles them, they have no glyph of
  // their own and are not supposed to have one. `fa-spin` is an animation, not a picture.
  for (const exento of ['fa-solid', 'fa-regular', 'fa-spin']) encontrados.delete(exento)
  return encontrados
}

const css = readFileSync(archivoCss, 'utf8')
const definidos = glifosDefinidos(css)

const usados = new Set()
const porArchivo = []
for (const archivo of archivosFuente(dirRenderer)) {
  const encontrados = glifosUsados(readFileSync(archivo, 'utf8'))
  if (encontrados.size === 0) continue
  for (const c of encontrados) usados.add(c)
  porArchivo.push({ archivo: relative(desktopRoot, archivo), encontrados: [...encontrados].sort() })
}

/** The forward check, as a pure function so the negative control can drive the same code path. */
export function glifosSinDefinir(usadas, definidas) {
  return [...usadas].filter((c) => !definidas.has(c)).sort()
}

describe('every icon the renderer asks for has a glyph', () => {
  it('finds CSS rules at all — a checker over an empty set passes vacuously', () => {
    // The gate that scans nothing is the failure mode `verify-offline` names for itself: a file
    // that failed to parse yields zero definitions, and every usage then "has no glyph".
    expect(definidos.size).toBeGreaterThan(30)
    expect(usados.size).toBeGreaterThan(20)
  })

  it('has no undefined Font Awesome class, anywhere in src/renderer/', () => {
    const faltan = glifosSinDefinir(usados, definidos)
    const detalle = faltan
      .map((c) => {
        const donde = porArchivo.filter((f) => f.encontrados.includes(c)).map((f) => f.archivo)
        return `  ${c}  <- ${donde.join(', ')}`
      })
      .join('\n')
    // The message names WHICH FILE asks for the missing class, because the fix is either "add the
    // glyph to icons.css" or "the JSX meant a name that already exists" — and that second case is
    // the one that produced 17 blank icons, not a missing drawing.
    expect(
      faltan,
      faltan.length === 0
        ? ''
        : `clases sin glifo en styles/icons.css (se dibujan como cajas vacias):\n${detalle}`
    ).toEqual([])
  })

  it('every glyph is a real data-URI mask, not a colour or a border', () => {
    // A rule that sets a colour instead of a mask LOOKS like a defined icon to the check above and
    // is a solid square on screen. The count is compared against the number of glyph selectors so
    // this cannot pass by finding one mask and ignoring the rest.
    const bloques = [...css.matchAll(/\.fa-solid\.(fa-[a-z0-9-]+)[^{]*\{([^}]*)\}/g)]
    expect(bloques.length).toBeGreaterThan(30)
    const sinMascara = bloques.filter((b) => !/mask-image:\s*url\(/.test(b[2])).map((b) => b[1])
    expect(sinMascara, `glifos sin mask-image:\n  ${sinMascara.join('\n  ')}`).toEqual([])
  })

  it('reports unused glyphs as a number, not as a failure', () => {
    // Reported rather than enforced: an icon can be legitimately unused while a screen is being
    // built, and a red suite for that would push somebody to delete it five minutes before it is
    // needed. Asserted as a bound so the file cannot silently double.
    const sinUsar = [...definidos].filter((c) => !usados.has(c))
    expect(sinUsar.length).toBeLessThan(definidos.size / 2)
  })
})

describe('NEGATIVE CONTROL: the checker can actually fail', () => {
  it('reports a class that is definitely not in the stylesheet', () => {
    // Without this, a regex typo would make the suite green while the blank boxes came back — the
    // exact defect the file exists for. `fa-definitely-not-a-real-glyph` is not in the stylesheet
    // and is not going to be added.
    const inventado = glifosUsados('<i className="fa-solid fa-definitely-not-a-real-glyph"></i>')
    expect(inventado.has('fa-definitely-not-a-real-glyph')).toBe(true)
    expect(glifosSinDefinir(inventado, definidos)).toEqual(['fa-definitely-not-a-real-glyph'])
  })

  it('does not flag the style classes that have no glyph on purpose', () => {
    const soloEstilo = glifosUsados('<i className="fa-solid fa-spin"></i>')
    expect([...soloEstilo]).toEqual([])
    expect(glifosSinDefinir(soloEstilo, definidos)).toEqual([])
  })
})
