/**
 * THE `negocio.*` IPC HANDLERS — the shop's own identity, read and edited.
 *
 * The repository layer has no separate test file for this: `negocio.obtener` and
 * `negocio.actualizar` live entirely in the handler, so the handler IS the unit under test. What
 * these tests pin down:
 *
 *   1. `requireTenant` guards both, so a file whose identity did not resolve cannot read or write
 *      a shop row.
 *   2. `actualizar` is scoped to `reqCtx.negocioId` and takes no id from the payload. There is no
 *      way to point the write at another tenant, which is the usual way a "profile" endpoint
 *      becomes a cross-tenant hole.
 *   3. `tipoComercio` is validated as a 400 BEFORE the schema CHECK fires as a 500, and
 *      `configuracion` is MERGED rather than replaced.
 *   4. The write needs an operator, and writes an audit row.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRegistry } from '../../src/main/bridge/registry.js'
import { registerNegocioHandlers } from '../../src/main/ipc/negocio.js'
import { tienda, ctxDe } from '../db/fixtures/tienda.js'

let t
let registry
let ctx

beforeEach(() => {
  t = tienda()
  registry = createRegistry()
  registerNegocioHandlers(registry, { conn: t.conn })
  ctx = ctxDe(t, t.negocioId, t.usuarioId)
})

afterEach(() => {
  t.cerrar()
})

const negocio = (op) => registry.resolve('negocio', op)

/** A second business, inserted directly, so tenant isolation is real. */
function otroNegocio() {
  const ts = '2026-01-01T00:00:00.000Z'
  const info = t.conn.db
    .prepare(
      `INSERT INTO negocios (nombre, ruc, tipo_comercio, configuracion, activo, created_at, updated_at)
       VALUES ('Otra Tienda', NULL, 'otro', '{"tema":"claro"}', 1, ?, ?)`
    )
    .run(ts, ts)
  return Number(info.lastInsertRowid)
}

describe('negocio.obtener', () => {
  it('returns the shop this file resolved to, with its parsed configuration', () => {
    const r = negocio('obtener')({}, ctx)
    expect(r.id).toBe(t.negocioId)
    expect(r.nombre).toBeTruthy()
    // The column is TEXT holding JSON; the renderer gets an object, not a string it must parse.
    expect(typeof r.configuracion).toBe('object')
  })

  it('refuses without a tenant, and 404s for a tenant that does not exist', () => {
    expect(() => negocio('obtener')({}, {})).toThrowError(expect.objectContaining({ code: 'TENANT_REQUIRED' }))
    expect(() => negocio('obtener')({}, { negocioId: 999999 })).toThrowError(
      expect.objectContaining({ code: 'NEGOCIO_NO_ENCONTRADO', status: 404 })
    )
  })
})

describe('negocio.actualizar', () => {
  it('is PATCH: the fields not sent keep their value, and it returns the new shape', () => {
    const antes = negocio('obtener')({}, ctx)

    const r = negocio('actualizar')({ telefono: '11-4444-0000' }, ctx)

    expect(r.telefono).toBe('11-4444-0000')
    expect(r.nombre).toBe(antes.nombre)
    expect(r.tipoComercio).toBe(antes.tipoComercio)
    // Read back through `obtener`: the write and the header cannot disagree.
    expect(negocio('obtener')({}, ctx).telefono).toBe('11-4444-0000')
  })

  it('merges `configuracion` over the stored object instead of replacing it', () => {
    negocio('actualizar')({ configuracion: { tema: 'oscuro', imprimir: true } }, ctx)
    const r = negocio('actualizar')({ configuracion: { imprimir: false } }, ctx)

    // The web merges too; a form that sends one changed key must not erase the rest.
    expect(r.configuracion).toEqual({ tema: 'oscuro', imprimir: false })
  })

  it('refuses an unknown tipoComercio as a 400, not the schema CHECK as a 500', () => {
    let err = null
    try {
      negocio('actualizar')({ tipoComercio: 'castillo' }, ctx)
    } catch (e) {
      err = e
    }
    expect(err).toMatchObject({ code: 'NEGOCIO_TIPO_INVALIDO', status: 400 })
    expect(err.message).toContain('otro')
  })

  it('refuses a non-object configuration and a blank name', () => {
    expect(() => negocio('actualizar')({ configuracion: 'nope' }, ctx)).toThrow(
      expect.objectContaining({ code: 'NEGOCIO_CONFIG_INVALIDA', status: 400 })
    )
    expect(() => negocio('actualizar')({ nombre: '   ' }, ctx)).toThrow(
      expect.objectContaining({ code: 'NEGOCIO_NOMBRE_REQUERIDO', status: 400 })
    )
  })

  it('requires an operator and writes an audit row', () => {
    expect(() => negocio('actualizar')({ nombre: 'Nuevo' }, { ...ctx, actorId: null })).toThrow(
      expect.objectContaining({ code: 'ACTOR_REQUERIDO', status: 401 })
    )

    negocio('actualizar')({ nombre: 'Almacén Don José' }, ctx)
    const fila = t.conn.db
      .prepare("SELECT * FROM auditoria WHERE tabla = 'negocios' AND registro_id = ? AND accion = 'UPDATE'")
      .get(t.negocioId)
    expect(fila).toBeTruthy()
    expect(JSON.parse(fila.valores_nuevos).nombre).toBe('Almacén Don José')
  })

  it('writes only the tenant the context resolved to', () => {
    const otroId = otroNegocio()

    negocio('actualizar')({ nombre: 'Tienda Propia' }, ctx)
    negocio('actualizar')({ nombre: 'Tienda Ajena' }, { ...ctx, negocioId: otroId })

    // Each context edited its OWN shop and nothing else.
    expect(t.conn.db.prepare('SELECT nombre FROM negocios WHERE id = ?').get(t.negocioId).nombre).toBe('Tienda Propia')
    expect(t.conn.db.prepare('SELECT nombre FROM negocios WHERE id = ?').get(otroId).nombre).toBe('Tienda Ajena')
  })
})
