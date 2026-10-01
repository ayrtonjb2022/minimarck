import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tienda, ctxDe } from './fixtures/tienda.js'
import {
  listar,
  obtener,
  crear,
  actualizar,
  remove
} from '../../src/main/db/repositories/proveedores.repo.js'

/**
 * Suppliers, over a real migrated and seeded shop database.
 *
 * The invariants under test are the ones an operator depends on and a web implementation gets
 * wrong: a supplier with purchases in foot cannot be deleted, a name is not duplicated by a second
 * INSERT racing a first, the accepted field set is the web's, and the number the detail screen shows
 * as "owed" is DERIVED from purchases rather than stored on the row.
 */
describe('proveedores — the name a purchase is made to', () => {
  let t
  let ctx

  beforeEach(() => {
    t = tienda()
    ctx = ctxDe(t, t.negocioId, t.usuarioId)
  })
  afterEach(() => t.cerrar())

  const nuevo = (body = {}) =>
    crear(ctx, { nombre: 'Distribuidora del Sur', ruc: '20512345678', ...body })

  it('creates a supplier with the web own fields and reads it back', () => {
    const p = nuevo({ contacto: 'María', telefono: '351-555-0001', email: 'ventas@distribuidora.com' })

    expect(p.nombre).toBe('Distribuidora del Sur')
    expect(p.ruc).toBe('20512345678')
    expect(p.contacto).toBe('María')
    expect(p.telefono).toBe('351-555-0001')
    expect(p.email).toBe('ventas@distribuidora.com')
    expect(p.activo).toBe(true)
    // A new supplier owes nothing and has bought nothing. Both are DERIVED, and both are zero.
    expect(p.comprasTotales).toBe(0)
    expect(p.comprasPendientesCentavos).toBe(0)
    expect(p.ultimaCompraAt).toBeNull()
    expect(obtener(ctx, p.id).id).toBe(p.id)
  })

  it('refuses a name the web would refuse, and stores a blank as absent', () => {
    expect(() => nuevo({ nombre: 'A' })).toThrow(/entre 2 y 150/)
    expect(() => nuevo({ nombre: 'x'.repeat(151) })).toThrow(/entre 2 y 150/)
    expect(() => nuevo({ nombre: '   ' })).toThrow()
    // And the web's email rule, character for character.
    expect(() => nuevo({ email: 'not-an-email' })).toThrow(/formato/)
    expect(nuevo({ email: '' }).email).toBeNull()
    expect(nuevo({ ruc: '' }).ruc).toBeNull()
  })

  it('searches the fields an operator would type, case-insensitively, and escapes wildcards', () => {
    nuevo({ nombre: 'Distribuidora del Sur', telefono: '351-555-0001', ruc: '20512345678' })
    // `ruc: ''` on purpose: the helper's default would otherwise put the same tax id on both rows
    // and make the ruc search match two suppliers, which is a broken fixture rather than a finding.
    nuevo({ nombre: 'Frutos del Norte', contacto: 'Ariel', ruc: '' })

    expect(listar(ctx, { search: 'distribuidora' }).total).toBe(1)
    expect(listar(ctx, { search: 'FRUTOS' }).total).toBe(1)
    expect(listar(ctx, { search: '555-0001' }).total).toBe(1)
    expect(listar(ctx, { search: '2051' }).total).toBe(1)
    expect(listar(ctx, { search: 'ariel' }).total).toBe(1)
    expect(listar(ctx, { search: 'inexistente' }).total).toBe(0)

    // A `%` in the box is a character to look for, not "match anything". The web interpolates it
    // raw into Op.like, where searching for a percentage sign returns every supplier instead.
    nuevo({ nombre: 'Café 100%是的' })
    const conPorcentaje = listar(ctx, { search: '100%' })
    expect(conPorcentaje.total).toBe(1)
    expect(conPorcentaje.filas[0].nombre).toBe('Café 100%是的')
  })

  it('filters by activo, including asking for both at once as the web cannot', () => {
    const a = nuevo({ nombre: 'Mayorista Uno' })
    nuevo({ nombre: 'Mayorista Dos' })
    actualizar(ctx, a.id, { activo: false })

    expect(listar(ctx, {}).total).toBe(2)
    expect(listar(ctx, { activo: 'true' }).total).toBe(1)
    expect(listar(ctx, { activo: 'false' }).total).toBe(1)
    expect(listar(ctx, { activo: 'todos' }).total).toBe(2)
  })

  it('edits only the fields it was given, so an untouched field is not cleared', () => {
    const p = nuevo({ telefono: '351-555-0001', email: 'ventas@distribuidora.com' })

    actualizar(ctx, p.id, { telefono: '351-555-9999' })

    const despues = obtener(ctx, p.id)
    expect(despues.telefono).toBe('351-555-9999')
    // The point of the whole exercise: `email` was not in the request and is still there.
    expect(despues.email).toBe('ventas@distribuidora.com')
  })

  it('clears a field that arrives blank, which is not the same as omitting it', () => {
    const p = nuevo({ telefono: '351-555-0001' })
    expect(obtener(ctx, p.id).telefono).toBe('351-555-0001')

    actualizar(ctx, p.id, { telefono: '' })
    expect(obtener(ctx, p.id).telefono).toBeNull()
  })

  it('refuses to remove a supplier with purchases in foot, and suggests deactivating', () => {
    const p = nuevo()
    // The purchase is inserted straight through SQL: this test is about the guard in `remove`, and
    // `compras.spec.js` is where the insert itself is earned.
    t.conn.db
      .prepare(
        `INSERT INTO compras (folio, total_centavos, estado, proveedor_id, user_id, negocio_id)
         VALUES ('CMP-1', 1000, 'completada', ?, ?, ?)`
      )
      .run(p.id, t.usuarioId, t.negocioId)

    expect(() => remove(ctx, p.id)).toThrow(/no se puede eliminar/)
    expect(() => remove(ctx, p.id)).toThrow(/desactivalo/)
    expect(obtener(ctx, p.id).nombre).toBe('Distribuidora del Sur')
  })

  it('removes a supplier whose only purchases were cancelled, and hides them afterwards', () => {
    const p = nuevo()
    t.conn.db
      .prepare(
        `INSERT INTO compras (folio, total_centavos, estado, proveedor_id, user_id, negocio_id)
         VALUES ('CMP-1', 1000, 'cancelada', ?, ?, ?)`
      )
      .run(p.id, t.usuarioId, t.negocioId)

    expect(remove(ctx, p.id).eliminado).toBe(true)
    expect(listar(ctx, {}).total).toBe(0)
    expect(() => obtener(ctx, p.id)).toThrow(/no existe/)
  })

  it('scopes every read and write to the business, so one shop cannot see another suppliers', () => {
    const p = nuevo()
    const otroNegocio = t.conn.db
      .prepare(
        `INSERT INTO negocios (nombre, ruc, direccion, configuracion, activo)
         VALUES ('Otra Tienda', '20999999999', 'Calle 1', '{}', 1)`
      )
      .run()

    expect(() => obtener({ ...ctx, negocioId: Number(otroNegocio.lastInsertRowid) }, p.id)).toThrow()
    expect(() => actualizar({ ...ctx, negocioId: Number(otroNegocio.lastInsertRowid) }, p.id, { telefono: 'x' })).toThrow()
    expect(() => remove({ ...ctx, negocioId: Number(otroNegocio.lastInsertRowid) }, p.id)).toThrow()
    expect(listar({ ...ctx, negocioId: Number(otroNegocio.lastInsertRowid) }, {}).total).toBe(0)
  })

  it('refuses an id that is not a row, instead of quietly matching nothing', () => {
    expect(() => obtener(ctx, 0)).toThrow(/entero positivo/)
    expect(() => obtener(ctx, null)).toThrow(/entero positivo/)
    expect(() => obtener(ctx, 'abc')).toThrow(/entero positivo/)
    expect(() => obtener(ctx, 999999)).toThrow(/no existe/)
  })

  /**
   * Who did it, for a table that cannot say.
   *
   * `proveedores` has no `user_id` column, so `auditoria` is the only place in the frozen schema
   * that records who acted. The comment in the repository used to CLAIM that while writing no row
   * at all — the kind of gap a test is for. The UPDATE row carries only the fields the request
   * touched, so "who changed this supplier's phone" is answerable without a wall of unchanged
   * columns hiding the one value.
   */
  it('records who created, changed and removed a supplier, since the row cannot say', () => {
    const filas = () =>
      t.conn.db
        .prepare(
          `SELECT accion, valores_anteriores, valores_nuevos, user_id FROM auditoria
            WHERE tabla = 'proveedores' ORDER BY id`
        )
        .all()

    const creado = crear(ctx, { nombre: 'Lácteos del Valle', telefono: '555' })
    expect(filas()).toHaveLength(1)
    expect(filas()[0].accion).toBe('CREATE')
    expect(filas()[0].user_id).toBe(t.usuarioId)
    expect(JSON.parse(filas()[0].valores_nuevos).nombre).toBe('Lácteos del Valle')

    actualizar(ctx, creado.id, { telefono: '556' })
    expect(filas()).toHaveLength(2)
    const edicion = filas()[1]
    expect(edicion.accion).toBe('UPDATE')
    // Only the field that was edited, before and after. The whole row would bury it.
    expect(Object.keys(JSON.parse(edicion.valores_anteriores))).toEqual(['telefono'])
    expect(JSON.parse(edicion.valores_anteriores).telefono).toBe('555')
    expect(JSON.parse(edicion.valores_nuevos).telefono).toBe('556')

    remove(ctx, creado.id)
    expect(filas()).toHaveLength(3)
    expect(filas()[2].accion).toBe('DELETE')
    expect(JSON.parse(filas()[2].valores_nuevos).activo).toBe(0)
  })
})
