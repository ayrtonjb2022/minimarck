import { describe, it, expect, afterEach } from 'vitest'
import {
  actualizar,
  actualizarCategoria,
  buscarPorCodigo,
  crear,
  crearCategoria,
  eliminar,
  eliminarCategoria,
  listar,
  listarCategorias,
  mapProducto,
  obtener,
  obtenerCategoria
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

/**
 * A sale line for a product, inserted directly.
 *
 * `productos.eliminar` decides between deactivation and deletion by counting `ventas_detalles`
 * rows for the product — that COUNT is the whole input of the decision, so a test that wants a
 * "product with sales" only needs a line that references it. Going through `ventas.repo.js#crear`
 * would drag stock arithmetic, a cash session and a journal entry into a test about a delete.
 */
function venderProducto(t, { productoId, negocioId, usuarioId, folio = 'V-TEST-1' }) {
  const ts = '2026-01-01T00:00:00.000Z'
  const ventaId = Number(
    t.conn.db
      .prepare(
        `INSERT INTO ventas (folio, metodo_pago, subtotal_centavos, total_centavos, estado, user_id, negocio_id, created_at, updated_at)
         VALUES (?, 'efectivo', 20000, 20000, 'completada', ?, ?, ?, ?)`
      )
      .run(folio, usuarioId, negocioId, ts, ts).lastInsertRowid
  )
  t.conn.db
    .prepare(
      `INSERT INTO ventas_detalles
         (cantidad_milli, precio_unitario_centavos, subtotal_centavos, nombre_producto, venta_id, producto_id, created_at, updated_at)
       VALUES (1000, 20000, 20000, 'Queso artesanal', ?, ?, ?, ?)`
    )
    .run(ventaId, productoId, ts, ts)
  return ventaId
}

describe('productos.actualizar — the edit screen', () => {
  it('is PATCH, not PUT: a field the form did not send keeps its old value', () => {
    const { ctx } = tiendaCon()
    const lacteo = crearCategoria(ctx, { nombre: 'Lácteos' })
    const p = crear(ctx, cuerpoProducto({ categoriaId: lacteo.id }))

    const r = actualizar(ctx, p.id, { precio: '2000' })

    // The one changed field...
    expect(r.precioCentavos).toBe(200000)
    // ...and everything the payload omitted, untouched. A PUT that nulled the rest would wipe a
    // barcode and a stock level behind the operator's back.
    expect(r.nombre).toBe('Queso artesanal')
    expect(r.codigo).toBe('7791234567890')
    expect(r.precioCompraCentavos).toBe(p.precioCompraCentavos)
    expect(r.stockMilli).toBe(3500)
    expect(r.stockMinimoMilli).toBe(1000)
    expect(r.categoriaId).toBe(lacteo.id)
    expect(r.unidadMedida).toBe('kg')
  })

  it('converts the renderer units on the fields it does receive', () => {
    const { ctx } = tiendaCon()
    const p = crear(ctx, cuerpoProducto())

    const r = actualizar(ctx, p.id, { precio: '99,99', stock: '4,25', stockMinimo: '0,5' })

    expect(r.precioCentavos).toBe(9999)
    expect(r.stockMilli).toBe(4250)
    expect(r.stockMinimoMilli).toBe(500)
  })

  it('honours `activo: false` and `stock: 0` as VALUES, not as absences', () => {
    const { ctx } = tiendaCon()
    const p = crear(ctx, cuerpoProducto())

    // The bug this guards: `if (body.activo)` and `body.stock || actual.stock`. Both are falsey
    // for the two values an operator most plausibly means, so a truthiness merge silently ignores
    // a deliberate deactivation and a deliberate empty shelf.
    const r = actualizar(ctx, p.id, { activo: false, stock: 0 })

    expect(r.activo).toBe(false)
    expect(r.stockMilli).toBe(0)
    expect(listar(ctx).filas.map((x) => x.nombre)).not.toContain('Queso artesanal')
    expect(listar(ctx, { soloActivos: false }).filas.map((x) => x.nombre)).toContain('Queso artesanal')
  })

  it('lets the generated es_pesable column follow a changed unit', () => {
    const { ctx } = tiendaCon()
    const p = crear(ctx, cuerpoProducto({ unidadMedida: 'kg' }))
    expect(p.esPesable).toBe(true)

    const r = actualizar(ctx, p.id, { unidadMedida: 'unidad' })
    // `es_pesable` is GENERATED; the write only changes `unidad_medida`. If the mapper had cached
    // the old value the scale button would still be offered for a product sold by the piece.
    expect(r.unidadMedida).toBe('unidad')
    expect(r.esPesable).toBe(false)
  })

  it('refuses a duplicate barcode, including a different case, but allows its own unchanged code', () => {
    const { ctx } = tiendaCon()
    const a = crear(ctx, cuerpoProducto())
    const b = crear(ctx, cuerpoProducto({ nombre: 'Otro queso', codigo: 'OTRO-1' }))

    expect(() => actualizar(ctx, b.id, { codigo: '7791234567890' })).toThrow(
      expect.objectContaining({ code: 'PRODUCTO_CODIGO_DUPLICADO', status: 400 })
    )
    // BINARY index, so the comparison has to be COLLATE NOCASE to match the web's collation.
    expect(() => actualizar(ctx, b.id, { codigo: '7791234567890'.toUpperCase() })).toThrow(
      expect.objectContaining({ code: 'PRODUCTO_CODIGO_DUPLICADO' })
    )
    // Saving the form without touching the barcode is not a duplicate of itself.
    expect(actualizar(ctx, a.id, { nombre: 'Queso criollo' }).codigo).toBe('7791234567890')
  })

  it('refuses a blank name, a negative price and an illegal unit as 400s with codes', () => {
    const { ctx } = tiendaCon()
    const p = crear(ctx, cuerpoProducto())

    expect(() => actualizar(ctx, p.id, { nombre: '   ' })).toThrow(
      expect.objectContaining({ code: 'PRODUCTO_NOMBRE_REQUERIDO', status: 400 })
    )
    expect(() => actualizar(ctx, p.id, { precio: -1 })).toThrow(
      expect.objectContaining({ code: 'PRODUCTO_PRECIO_NEGATIVO', status: 400 })
    )
    expect(() => actualizar(ctx, p.id, { unidadMedida: 'galón' })).toThrow(
      expect.objectContaining({ code: 'PRODUCTO_UNIDAD_INVALIDA', status: 400 })
    )
  })

  it('refuses a category that belongs to another business', () => {
    const { t, ctx } = tiendaCon()
    const ajena = crearCategoria({ ...ctx, negocioId: otroNegocio(t) }, { nombre: 'Ajena' })
    const p = crear(ctx, cuerpoProducto())

    expect(() => actualizar(ctx, p.id, { categoriaId: ajena.id })).toThrow(
      expect.objectContaining({ code: 'CATEGORIA_NO_ENCONTRADA' })
    )
  })

  it('writes an audit row pairing the old and the new figures', () => {
    const { t, ctx } = tiendaCon()
    const p = crear(ctx, cuerpoProducto())
    actualizar(ctx, p.id, { precio: '2000' })

    const fila = t.conn.db
      .prepare("SELECT * FROM auditoria WHERE tabla = 'productos' AND registro_id = ? AND accion = 'UPDATE'")
      .get(p.id)
    expect(fila).toBeTruthy()
    expect(JSON.parse(fila.valores_anteriores).precioCentavos).toBe(105050)
    expect(JSON.parse(fila.valores_nuevos).precioCentavos).toBe(200000)
    expect(fila.user_id).toBe(ctx.actorId)
  })

  it('never edits another business a product, and refuses without an operator', () => {
    const { t, ctx } = tiendaCon()
    const p = crear(ctx, cuerpoProducto())

    expect(() => actualizar({ ...ctx, negocioId: otroNegocio(t) }, p.id, { precio: '1' })).toThrow(
      expect.objectContaining({ code: 'PRODUCTO_NO_ENCONTRADO', status: 404 })
    )
    expect(() => actualizar({ ...ctx, actorId: null }, p.id, { precio: '1' })).toThrow(
      expect.objectContaining({ code: 'ACTOR_REQUERIDO', status: 401 })
    )
    // The refusals wrote nothing: the price is still the one it was created with.
    expect(obtener(ctx, p.id).precioCentavos).toBe(105050)
  })
})

describe('productos.eliminar — deactivate what sold, delete what never did', () => {
  it('soft-deletes a product with no sales, and it disappears from the catalogue', () => {
    const { t, ctx } = tiendaCon()
    const p = crear(ctx, cuerpoProducto())

    const r = eliminar(ctx, p.id)

    expect(r).toEqual({ id: p.id, desactivado: false })
    // The row survives — soft delete, not DELETE — so history that referenced it keeps resolving.
    const fila = t.conn.db.prepare('SELECT * FROM productos WHERE id = ?').get(p.id)
    expect(fila.deleted_at).toBeTruthy()
    expect(listar(ctx).filas.map((x) => x.id)).not.toContain(p.id)
    expect(() => obtener(ctx, p.id)).toThrow(expect.objectContaining({ code: 'PRODUCTO_NO_ENCONTRADO' }))
  })

  it('DEACTIVATES a product that has sales and leaves its sale line resolving', () => {
    const { t, ctx } = tiendaCon()
    const p = crear(ctx, cuerpoProducto())
    const ventaId = venderProducto(t, { productoId: p.id, negocioId: ctx.negocioId, usuarioId: ctx.actorId })

    const r = eliminar(ctx, p.id)

    expect(r).toEqual({ id: p.id, desactivado: true })
    const fila = t.conn.db.prepare('SELECT * FROM productos WHERE id = ?').get(p.id)
    // NOT deleted: the join from the historical sale still lands on a real product.
    expect(fila.deleted_at).toBeNull()
    expect(fila.activo).toBe(0)
    const detalle = t.conn.db.prepare('SELECT * FROM ventas_detalles WHERE venta_id = ?').get(ventaId)
    expect(detalle.producto_id).toBe(p.id)
    // Gone from the selling grid, still visible to an admin list.
    expect(listar(ctx).filas.map((x) => x.id)).not.toContain(p.id)
    expect(listar(ctx, { soloActivos: false }).filas.map((x) => x.id)).toContain(p.id)
  })

  it('writes an audit row for both paths, naming the reason for deactivation', () => {
    const { t, ctx } = tiendaCon()
    const limpio = crear(ctx, cuerpoProducto({ codigo: 'SIN-VENTAS' }))
    const vendido = crear(ctx, cuerpoProducto({ codigo: 'CON-VENTAS' }))
    venderProducto(t, { productoId: vendido.id, negocioId: ctx.negocioId, usuarioId: ctx.actorId })

    eliminar(ctx, limpio.id)
    eliminar(ctx, vendido.id)

    const borrado = t.conn.db
      .prepare("SELECT * FROM auditoria WHERE tabla = 'productos' AND registro_id = ? AND accion = 'DELETE'")
      .get(limpio.id)
    const desactivado = t.conn.db
      .prepare("SELECT * FROM auditoria WHERE tabla = 'productos' AND registro_id = ? AND accion = 'UPDATE'")
      .get(vendido.id)
    expect(borrado).toBeTruthy()
    expect(desactivado).toBeTruthy()
    expect(JSON.parse(desactivado.valores_nuevos).motivo).toBe('ventas_asociadas')
  })

  it('is tenant-scoped and refuses without an operator', () => {
    const { t, ctx } = tiendaCon()
    const p = crear(ctx, cuerpoProducto())

    expect(() => eliminar({ ...ctx, negocioId: otroNegocio(t) }, p.id)).toThrow(
      expect.objectContaining({ code: 'PRODUCTO_NO_ENCONTRADO', status: 404 })
    )
    expect(() => eliminar({ ...ctx, actorId: null }, p.id)).toThrow(
      expect.objectContaining({ code: 'ACTOR_REQUERIDO', status: 401 })
    )
    expect(t.conn.db.prepare('SELECT deleted_at, activo FROM productos WHERE id = ?').get(p.id)).toMatchObject({
      deleted_at: null,
      activo: 1
    })
  })
})

describe('categorias — get, update and remove', () => {
  it('gets one category scoped by business', () => {
    const { t, ctx } = tiendaCon()
    const c = crearCategoria(ctx, { nombre: 'Lácteos', descripcion: 'Quesos y leche' })

    expect(obtenerCategoria(ctx, c.id)).toMatchObject({ nombre: 'Lácteos', descripcion: 'Quesos y leche' })
    expect(() => obtenerCategoria(ctx, 999999)).toThrow(
      expect.objectContaining({ code: 'CATEGORIA_NO_ENCONTRADA', status: 404 })
    )
    expect(() => obtenerCategoria({ ...ctx, negocioId: otroNegocio(t) }, c.id)).toThrow(
      expect.objectContaining({ code: 'CATEGORIA_NO_ENCONTRADA' })
    )
  })

  it('updates a category with PATCH semantics and refuses a duplicate name', () => {
    const { ctx } = tiendaCon()
    const a = crearCategoria(ctx, { nombre: 'Bebidas' })
    const b = crearCategoria(ctx, { nombre: 'Almacén', descripcion: 'Secos' })

    const r = actualizarCategoria(ctx, b.id, { descripcion: 'Aceite y harina' })
    expect(r.nombre).toBe('Almacén')
    expect(r.descripcion).toBe('Aceite y harina')

    expect(() => actualizarCategoria(ctx, b.id, { nombre: 'bebidas' })).toThrow(
      expect.objectContaining({ code: 'CATEGORIA_NOMBRE_DUPLICADO', status: 400 })
    )
    // Saving without changing the name is not a duplicate of itself.
    expect(actualizarCategoria(ctx, a.id, { descripcion: 'Gaseosas' }).nombre).toBe('Bebidas')
  })

  it('deactivating a category hides it from the list', () => {
    const { ctx } = tiendaCon()
    const c = crearCategoria(ctx, { nombre: 'Temporal' })

    actualizarCategoria(ctx, c.id, { activo: false })
    expect(listarCategorias(ctx).map((x) => x.id)).not.toContain(c.id)
  })

  it('REFUSES to remove a category that still groups an active product', () => {
    const { t, ctx } = tiendaCon()
    const c = crearCategoria(ctx, { nombre: 'Lácteos' })
    crear(ctx, cuerpoProducto({ categoriaId: c.id }))

    // A dangling category would leave the filter row showing a category no product can reach.
    expect(() => eliminarCategoria(ctx, c.id)).toThrow(
      expect.objectContaining({ code: 'CATEGORIA_CON_PRODUCTOS', status: 400 })
    )
    expect(listarCategorias(ctx).map((x) => x.id)).toContain(c.id)
  })

  it('removes an empty category, and then one whose product was removed first', () => {
    const { t, ctx } = tiendaCon()
    const vacia = crearCategoria(ctx, { nombre: 'Vacía' })

    expect(eliminarCategoria(ctx, vacia.id)).toEqual({ id: vacia.id })
    expect(listarCategorias(ctx).map((x) => x.id)).not.toContain(vacia.id)

    const conProducto = crearCategoria(ctx, { nombre: 'Con producto' })
    const p = crear(ctx, cuerpoProducto({ categoriaId: conProducto.id }))
    eliminar(ctx, p.id) // soft delete: it is no longer an ACTIVE product
    expect(eliminarCategoria(ctx, conProducto.id)).toEqual({ id: conProducto.id })
  })

  it('never removes another business a category', () => {
    const { t, ctx } = tiendaCon()
    const c = crearCategoria(ctx, { nombre: 'Lácteos' })

    expect(() => eliminarCategoria({ ...ctx, negocioId: otroNegocio(t) }, c.id)).toThrow(
      expect.objectContaining({ code: 'CATEGORIA_NO_ENCONTRADA' })
    )
    expect(obtenerCategoria(ctx, c.id).nombre).toBe('Lácteos')
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
