import { describe, it, expect, afterEach } from 'vitest'
import {
  buscarPorCodigo,
  crear,
  crearCategoria,
  listar,
  listarCategorias,
  mapProducto,
  obtener
} from '../../src/main/db/repositories/productos.repo.js'
import { crear as crearDeudor, listar as listarDeudores } from '../../src/main/db/repositories/deudores.repo.js'
import { tienda, ctxDe, insertarDeudor } from './fixtures/tienda.js'

/**
 * The catalogue and the debtors, on REAL sqlite.
 *
 * What these tests pin down, because each one is a place a sale is either right or plausibly
 * wrong:
 *
 *   - A price typed as `1050,50` is stored as the INTEGER 105050, and a weight typed as `0,5` is
 *     stored as the INTEGER 500. The web sent the same decimal shapes over HTTP, so this is the
 *     same conversion the web did — except the web did it in MySQL, on a float, and this does it
 *     in digit space (see `shared/money.js` for the measured eleven-of-twenty failure rate).
 *   - A thousands separator is REFUSED rather than guessed. `1.050` is 1050 in Argentina and 1.05
 *     in the US; a cash register that picks one is a complaint, one that asks is not.
 *   - A negative price is a 400 with a sentence, not a schema CHECK that surfaces as a 500.
 *   - A category must belong to THIS business. `productos.categoria_id REFERENCES categorias(id)`
 *     carries no `negocio_id`, so the foreign key would happily accept another tenant's id.
 *   - A barcode lookup is case-insensitive, because the web resolved it through MySQL's
 *     `utf8mb4_general_ci` and a barcode that works on one machine only is not a barcode.
 *   - A blank barcode is NULL, so a shop with twenty products that have no barcode is not one
 *     product with a barcode and nineteen that cannot exist.
 *   - A debtor's balance is read from `v_clientes_deudores` and never recomputed here.
 */

const stores = []
afterEach(() => {
  while (stores.length > 0) stores.pop().cerrar()
})

function tiendaCon() {
  const t = tienda()
  stores.push(t)
  return { t, ctx: ctxDe(t, t.negocioId, t.usuarioId) }
}

/**
 * A second business in the same file, inserted straight into the table.
 *
 * The fixture seeds exactly one, and tenant isolation is the property under test — so the other
 * tenant has to be CREATED rather than assumed. A row that only exists inside a test's imagination
 * proves nothing about the query that is supposed to exclude it.
 */
function otroNegocio(t) {
  const ts = '2026-01-01T00:00:00.000Z'
  const info = t.conn.db
    .prepare(
      `INSERT INTO negocios (nombre, ruc, tipo_comercio, configuracion, activo, created_at, updated_at)
       VALUES ('Otra Tienda', NULL, 'otro', '{}', 1, ?, ?)`
    )
    .run(ts, ts)
  return Number(info.lastInsertRowid)
}

function cuerpoProducto(over = {}) {
  return {
    nombre: 'Queso artesanal',
    codigo: '7791234567890',
    precio: '1050,50',
    stock: '3,5',
    stockMinimo: '1',
    unidadMedida: 'kg',
    ...over
  }
}

describe('productos.crear — the operator adds a product', () => {
  it('stores the typed pesos and stock as INTEGERS, not as floats', () => {
    const { ctx } = tiendaCon()
    const p = crear(ctx, cuerpoProducto())

    expect(p.precioCentavos).toBe(105050)
    expect(p.stockMilli).toBe(3500)
    expect(p.stockMinimoMilli).toBe(1000)
    // The stored values are integers, and `isCents`/`isMilli` are the shared predicates that
    // say so. This is the assertion that would fail if someone "simplified" the conversion.
    expect(Number.isInteger(p.precioCentavos)).toBe(true)
    expect(Number.isInteger(p.stockMilli)).toBe(true)
    expect(p.precio).toBeUndefined()
  })

  it('exposes es_pesable from the GENERATED column, not re-derived from the unit', () => {
    const { ctx } = tiendaCon()
    expect(crear(ctx, cuerpoProducto({ unidadMedida: 'KG' })).esPesable).toBe(true)
    expect(crear(ctx, cuerpoProducto({ codigo: 'OTRO-1', unidadMedida: 'unidad' })).esPesable).toBe(false)
  })

  it('normalises a capitalised unit and defaults a missing one', () => {
    const { ctx } = tiendaCon()
    expect(crear(ctx, cuerpoProducto({ unidadMedida: 'L' })).unidadMedida).toBe('l')
    const sinUnidad = cuerpoProducto({ codigo: 'SIN-UNIDAD' })
    delete sinUnidad.unidadMedida
    expect(crear(ctx, sinUnidad).unidadMedida).toBe('unidad')
  })

  it('refuses a blank name — the till would print an empty line', () => {
    const { ctx } = tiendaCon()
    expect(() => crear(ctx, cuerpoProducto({ nombre: '   ' }))).toThrow(
      expect.objectContaining({ code: 'PRODUCTO_NOMBRE_REQUERIDO', status: 400 })
    )
  })

  it('refuses a thousands separator instead of guessing between 1.050 and 1,05', () => {
    const { ctx } = tiendaCon()
    // The message is the shared one, verbatim: this is the sentence the operator reads.
    expect(() => crear(ctx, cuerpoProducto({ precio: '1.050,50' }))).toThrow(/no es un monto válido/)
  })

  it('refuses a negative price with a 400, NOT with a 500 from the schema CHECK', () => {
    const { ctx } = tiendaCon()
    // The value before this check existed: `toCents('-5')` is `-500`, and the insert fired
    // `SQLITE_CONSTRAINT_CHECK`, which `toIpcError` cannot classify and answers INTERNAL/500.
    let err = null
    try {
      crear(ctx, cuerpoProducto({ precio: -5 }))
    } catch (e) {
      err = e
    }
    expect(err).toMatchObject({ code: 'PRODUCTO_PRECIO_NEGATIVO', status: 400 })
    expect(err.message).toContain('-$5,00')
    expect(err.code).not.toBe('INTERNAL')
  })

  it('refuses a unit the schema CHECK would reject, with the list of legal ones', () => {
    const { ctx } = tiendaCon()
    let err = null
    try {
      crear(ctx, cuerpoProducto({ unidadMedida: 'galón' }))
    } catch (e) {
      err = e
    }
    expect(err).toMatchObject({ code: 'PRODUCTO_UNIDAD_INVALIDA', status: 400 })
    expect(err.message).toContain('unidad')
  })

  it('refuses a category that belongs to another business', () => {
    const { t, ctx } = tiendaCon()
    const catAjena = crearCategoria({ ...ctx, negocioId: otroNegocio(t) }, { nombre: 'Bebidas ajenas' })

    // The foreign key is satisfied — the row exists — so only an explicit tenant check refuses.
    expect(t.conn.db.prepare('SELECT id FROM categorias WHERE id = ?').get(catAjena.id)).toBeTruthy()
    expect(() => crear(ctx, cuerpoProducto({ categoriaId: catAjena.id }))).toThrow(
      expect.objectContaining({ code: 'CATEGORIA_NO_ENCONTRADA' })
    )
  })

  it('refuses a duplicate barcode in the SAME shop — including a different case', () => {
    const { t, ctx } = tiendaCon()
    crear(ctx, cuerpoProducto())
    expect(() => crear(ctx, cuerpoProducto({ nombre: 'Otro queso' }))).toThrow(
      expect.objectContaining({ code: 'PRODUCTO_CODIGO_DUPLICADO', status: 400 })
    )
    // BINARY index, case-sensitive: this is the pair the web's `utf8mb4_general_ci` refused and
    // SQLite would happily store. Two rows for one barcode make `findByCode` order-dependent.
    expect(() => crear(ctx, cuerpoProducto({ nombre: 'El mismo código', codigo: '7791234567890'.toUpperCase() }))).toThrow(
      expect.objectContaining({ code: 'PRODUCTO_CODIGO_DUPLICADO' })
    )

    // The index is scoped to the business, so a barcode is a per-shop fact and a franchise can
    // use the same one. Refusing here would be a bug, not a safety check.
    const gemelo = crear({ ...ctx, negocioId: otroNegocio(t) }, cuerpoProducto({ nombre: 'Queso de la otra' }))
    expect(gemelo.codigo).toBe('7791234567890')
  })

  it('stores a blank barcode as NULL, so unlimited products can have none', () => {
    const { ctx } = tiendaCon()
    const a = crear(ctx, cuerpoProducto({ codigo: '' }))
    const b = crear(ctx, cuerpoProducto({ codigo: '   ', nombre: 'Segundo' }))
    // `ux_productos_codigo_negocio` is PARTIAL on `codigo IS NOT NULL`. With '' the second
    // insert would have taken the one unique slot and failed for no reason an operator could
    // understand.
    expect(a.codigo).toBeNull()
    expect(b.codigo).toBeNull()
  })

  it('writes the audit row in the same transaction, or neither', () => {
    const { t, ctx } = tiendaCon()
    const p = crear(ctx, cuerpoProducto())
    const auditoria = t.conn.db
      .prepare(`SELECT * FROM auditoria WHERE tabla = 'productos' AND registro_id = ?`)
      .get(p.id)
    expect(auditoria).toBeTruthy()
    expect(auditoria.accion).toBe('CREATE')
    expect(auditoria.user_id).toBe(ctx.actorId)
    expect(auditoria.negocio_id).toBe(ctx.negocioId)
  })

  it('refuses to create without an operator', () => {
    const { t, ctx } = tiendaCon()
    expect(() => crear({ ...ctx, actorId: null }, cuerpoProducto())).toThrow(
      expect.objectContaining({ code: 'ACTOR_REQUERIDO', status: 401 })
    )
    expect(t.conn.db.prepare('SELECT COUNT(*) AS n FROM productos').get().n).toBe(0)
  })
})

describe('productos.list — the POS grid', () => {
  function sembrar(ctx) {
    const lacteo = crearCategoria(ctx, { nombre: 'Lácteos' })
    crear(ctx, cuerpoProducto({ nombre: 'Queso criollo', precio: '1050,50', categoriaId: lacteo.id }))
    crear(ctx, cuerpoProducto({ nombre: 'Pan de masa madre', codigo: 'AAA111', unidadMedida: 'unidad' }))
    crear(ctx, cuerpoProducto({ nombre: 'Yogur natural', codigo: 'BBB222' }))
    return lacteo
  }
  it('returns the catalogue alphabetically with a total, and the total is not the page length', () => {
    const { ctx } = tiendaCon()
    sembrar(ctx)
    const pagina = listar(ctx, { limit: 2 })
    expect(pagina.filas.map((p) => p.nombre)).toEqual(['Pan de masa madre', 'Queso criollo'])
    expect(pagina.total).toBe(3)
  })

  it('searches the name OR the barcode, case-insensitively', () => {
    const { ctx } = tiendaCon()
    sembrar(ctx)
    expect(listar(ctx, { search: 'yogur' }).filas.map((p) => p.nombre)).toEqual(['Yogur natural'])
    expect(listar(ctx, { search: 'BBB222' }).filas.map((p) => p.nombre)).toEqual(['Yogur natural'])
  })

  it('treats % and _ typed by the operator as literal characters, not LIKE wildcards', () => {
    const { ctx } = tiendaCon()
    crear(ctx, cuerpoProducto({ nombre: '100% cacao', codigo: 'CCC333' }))
    crear(ctx, cuerpoProducto({ nombre: 'Pan_de_trigo', codigo: 'DDD444' }))
    // Without the ESCAPE, '%' is a wildcard and this returns every product in the shop — which
    // looks like "the search is broken" rather than "the search matched too much".
    expect(listar(ctx, { search: '100%' }).filas.map((p) => p.nombre)).toEqual(['100% cacao'])
    expect(listar(ctx, { search: '%' }).filas).toHaveLength(1)
    expect(listar(ctx, { search: 'Pan_de' }).filas.map((p) => p.nombre)).toEqual(['Pan_de_trigo'])
    // `_` unescaped is "any one character", so this would return the 10-char `100% cacao` too.
    // Escaped, it is a literal underscore and only the one name contains one.
    expect(listar(ctx, { search: '_' }).filas.map((p) => p.nombre)).toEqual(['Pan_de_trigo'])
  })

  it('filters by category and hides deactivated products by default', () => {
    const { t, ctx } = tiendaCon()
    const lacteo = sembrar(ctx)
    expect(listar(ctx, { categoriaId: lacteo.id }).filas.map((p) => p.nombre)).toEqual(['Queso criollo'])

    t.conn.db.prepare('UPDATE productos SET activo = 0 WHERE nombre = ?').run('Yogur natural')
    expect(listar(ctx).filas.map((p) => p.nombre)).not.toContain('Yogur natural')
    // The override exists for an admin list, and it is opt-in precisely because forgetting it is
    // the dangerous direction.
    expect(listar(ctx, { soloActivos: false }).filas.map((p) => p.nombre)).toContain('Yogur natural')
  })

  it('never shows another business a product', () => {
    const { t, ctx } = tiendaCon()
    const mio = crear(ctx, cuerpoProducto())
    expect(() => obtener(ctx, mio.id)).not.toThrow()
    expect(() => obtener({ ...ctx, negocioId: mio.negocioId + 999 }, mio.id)).toThrow(
      expect.objectContaining({ code: 'PRODUCTO_NO_ENCONTRADO', status: 404 })
    )
    expect(listar({ ...ctx, negocioId: mio.negocioId + 999 }).filas).toEqual([])
  })

  it('refuses a tenant-less read rather than defaulting to some shop', () => {
    const { ctx } = tiendaCon()
    sembrar(ctx)
    expect(() => listar({ ...ctx, negocioId: null })).toThrow(
      expect.objectContaining({ code: 'TENANT_REQUIRED', status: 400 })
    )
  })
})

describe('productos.findByCode — the barcode a scanner sends', () => {
  it('finds a product by its code regardless of case', () => {
    const { ctx } = tiendaCon()
    const p = crear(ctx, cuerpoProducto({ codigo: 'AbC123' }))
    expect(buscarPorCodigo(ctx, 'AbC123').id).toBe(p.id)
    // NOCASE, because SQLite's `=` on TEXT is case-SENSITIVE and the web's MySQL collation was
    // not. A barcode that works on one machine and not another is not a barcode.
    expect(buscarPorCodigo(ctx, 'abc123').id).toBe(p.id)
  })

  it('answers null for an unknown code, because a scanner over a missing product is normal', () => {
    const { ctx } = tiendaCon()
    expect(buscarPorCodigo(ctx, '000000')).toBeNull()
    expect(buscarPorCodigo(ctx, '')).toBeNull()
    expect(buscarPorCodigo(ctx, null)).toBeNull()
  })

  it('does not find another business a product by code', () => {
    const { ctx } = tiendaCon()
    crear(ctx, cuerpoProducto({ codigo: 'Zzz999' }))
    expect(buscarPorCodigo({ ...ctx, negocioId: 4242 }, 'Zzz999')).toBeNull()
  })
})

describe('categorias — the grid filter and the fraccionar flow', () => {
  it('lists alphabetically, active only', () => {
    const { t, ctx } = tiendaCon()
    crearCategoria(ctx, { nombre: 'Lácteos' })
    crearCategoria(ctx, { nombre: 'Almacén' })
    t.conn.db.prepare(`UPDATE categorias SET activo = 0 WHERE nombre = 'Almacén'`).run()
    expect(listarCategorias(ctx).map((c) => c.nombre)).toEqual(['Lácteos'])
  })

  it('refuses a duplicate name in the same shop — including a different case', () => {
    const { t, ctx } = tiendaCon()
    crearCategoria(ctx, { nombre: 'Bebidas' })
    expect(() => crearCategoria(ctx, { nombre: 'bebidas' })).toThrow(
      expect.objectContaining({ code: 'CATEGORIA_NOMBRE_DUPLICADO' })
    )
    expect(crearCategoria({ ...ctx, negocioId: otroNegocio(t) }, { nombre: 'Bebidas' }).nombre).toBe('Bebidas')
  })

  it('never shows another business a category', () => {
    const { t, ctx } = tiendaCon()
    crearCategoria(ctx, { nombre: 'Lácteos' })
    expect(listarCategorias({ ...ctx, negocioId: otroNegocio(t) })).toEqual([])
  })
})

describe('deudores — who a credit sale can be billed to', () => {
  it('reads the balance from the view instead of storing or recomputing it', () => {
    const { t, ctx } = tiendaCon()
    const d = crearDeudor(ctx, { nombre: 'Juan Pérez', limiteCredito: '1000,00' })
    expect(d.deudaPendienteCentavos).toBe(0)
    expect(d.limiteCreditoCentavos).toBe(100000)

    const antes = t.conn.db
      .prepare('SELECT * FROM clientes_deudores WHERE id = ?')
      .get(d.id)
    expect(antes.deuda_total).toBeUndefined()
    expect(antes.deuda_pendiente).toBeUndefined()
  })

  it('searches by name or document and escapes LIKE wildcards', () => {
    const { ctx } = tiendaCon()
    crearDeudor(ctx, { nombre: '100% Films', documento: '30111222' })
    crearDeudor(ctx, { nombre: 'Keving', documento: '33444555' })
    expect(listarDeudores(ctx, { search: 'keving' }).filas.map((d) => d.nombre)).toEqual(['Keving'])
    expect(listarDeudores(ctx, { search: '30111' }).filas.map((d) => d.nombre)).toEqual(['100% Films'])
    expect(listarDeudores(ctx, { search: '%' }).filas).toHaveLength(1)
  })

  it('conDeuda narrows to the ones that actually owe something', () => {
    const { t, ctx } = tiendaCon()
    const debe = insertarDeudor(t, { negocioId: t.negocioId, usuarioId: t.usuarioId, nombre: 'Debe' })
    const noDebe = crearDeudor(ctx, { nombre: 'Al día', documento: '99988877' })
    const ts = '2026-01-01T00:00:00.000Z'
    // A CREDIT sale: the view counts `WHERE metodo_pago = 'credito'`, so a $50 cash sale would
    // leave the balance at zero and this test would pass for the wrong reason.
    t.conn.db
      .prepare(
        `INSERT INTO ventas (folio, metodo_pago, total_centavos, estado, deudor_id, user_id, negocio_id, created_at, updated_at)
         VALUES ('V-TEST-1', 'credito', 5000, 'completada', ?, ?, ?, ?, ?)`
      )
      .run(debe.id, ctx.actorId, ctx.negocioId, ts, ts)

    const conDeuda = listarDeudores(ctx, { conDeuda: true })
    expect(conDeuda.filas.map((d) => d.nombre)).toEqual(['Debe'])
    // The balance comes from the view, so it is the same number the accounts-receivable screen
    // would show — one copy, not two.
    expect(conDeuda.filas[0].deudaPendienteCentavos).toBe(5000)
    expect(listarDeudores(ctx).filas).toHaveLength(2)
    expect(noDebe.nombre).toBe('Al día')
  })

  it('refuses a negative credit limit with a 400 rather than letting the schema answer', () => {
    const { ctx } = tiendaCon()
    let err = null
    try {
      crearDeudor(ctx, { nombre: 'X', limiteCredito: -10 })
    } catch (e) {
      err = e
    }
    expect(err).toMatchObject({ code: 'DEUDOR_LIMITE_NEGATIVO', status: 400 })
  })

  it('never shows another business a debtor', () => {
    const { t, ctx } = tiendaCon()
    crearDeudor(ctx, { nombre: 'Privado' })
    expect(listarDeudores({ ...ctx, negocioId: otroNegocio(t) }).filas).toEqual([])
  })
})

describe('mapProducto — the row the renderer receives', () => {
  it('exposes canonical *Centavos and *Milli names and no snake_case', () => {
    const { ctx } = tiendaCon()
    const p = crear(ctx, cuerpoProducto())
    const keys = Object.keys(p)
    expect(keys).not.toContain('precio_centavos')
    expect(keys).not.toContain('stock_milli')
    expect(keys).toContain('precioCentavos')
    expect(keys).toContain('stockMilli')
    // Booleans are booleans: the vendored POS renders `esPesable` and a truthy 0/1 would put a
    // `0` on screen where the UI expects a yes/no.
    expect(p.tieneIva).toBe(false)
    expect(p.activo).toBe(true)
    expect(mapProducto(null)).toBeNull()
  })
})
