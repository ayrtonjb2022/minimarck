import { createCtx } from '../db/ctx.js'
import { IpcError } from '../bridge/errors.js'
import { requireTenant } from '../db/seed.js'

/**
 * The two `negocio.*` handlers — the shop this file belongs to, and the edit of its own details.
 *
 * `obtener` supplies the one line the shell needs above the operator's name. It reads through
 * `requireTenant` like every other handler in the app, so a file whose identity did not resolve
 * answers TENANT_REQUIRED here too rather than reaching into `negocios` and picking a row: a header
 * that says "Acme Lácteos" above a till that cannot sell anything would be a lie in the most
 * visible place in the window.
 *
 * `actualizar` is a settings screen, and a settings screen is the one place an owner can correct
 * the shop's own identity. It is scoped to `reqCtx.negocioId` and nothing else: there is no id in
 * the payload to redirect the write at another tenant, which is how a "profile" endpoint becomes a
 * cross-tenant hole in most apps.
 *
 * `tipoComercio` is validated HERE against the same list the `CHECK` in `negocios.tipo_comercio`
 * enforces. Letting the constraint fire instead would surface a `CHECK constraint failed` as a
 * 500; a bad value is a bad request. `configuracion` is merged over the stored JSON rather than
 * replaced, because the web merges too (`negocio.controller.js`) and a form that sends one changed
 * key must not erase the rest.
 */

/** The allowed `tipo_comercio` values, kept in step with `negocios.tipo_comercio`'s CHECK. */
const TIPOS_COMERCIO = [
  'despensa',
  'kiosco',
  'ferreteria',
  'tienda_ropa',
  'casa_electricidad',
  'electrodomesticos',
  'libreria',
  'veterinaria',
  'regaleria',
  'otro'
]

/** A nullable text field, trimmed; a blank is `null`. */
function textoOpcional(valor) {
  return valor === null || valor === undefined || String(valor).trim() === '' ? null : String(valor).trim()
}

/**
 * The wire shape of a shop. `configuracion` is parsed back to an object: the column is a TEXT
 * encoding of JSON (`json_valid` enforces that), and handing the renderer a raw string would make
 * every caller parse it and one of them get it wrong.
 */
function mapNegocio(fila) {
  let configuracion = {}
  try {
    configuracion = JSON.parse(fila.configuracion || '{}')
  } catch {
    // `json_valid` should make this unreachable; a corrupt file must not take the header down.
    configuracion = {}
  }
  return {
    id: fila.id,
    nombre: fila.nombre,
    ruc: fila.ruc,
    direccion: fila.direccion,
    telefono: fila.telefono,
    email: fila.email,
    website: fila.website,
    logo: fila.logo,
    tipoComercio: fila.tipo_comercio,
    configuracion,
    activo: Boolean(fila.activo)
  }
}

export function registerNegocioHandlers(registry, { conn }) {
  const leer = (negocioId) => {
    const fila = conn.db.prepare('SELECT * FROM negocios WHERE id = ? AND deleted_at IS NULL').get(negocioId)
    if (!fila) {
      throw new IpcError('NEGOCIO_NO_ENCONTRADO', 404, 'Negocio no encontrado')
    }
    return fila
  }

  registry.register('negocio', {
    obtener: (_payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return mapNegocio(leer(reqCtx.negocioId))
    },

    actualizar: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      if (!reqCtx?.actorId) {
        throw new IpcError('ACTOR_REQUERIDO', 401, 'La operación necesita un usuario en sesión')
      }
      const ctx = createCtx(conn, reqCtx)
      const actual = leer(reqCtx.negocioId)
      const b = payload ?? {}

      const nombre = b.nombre === undefined ? actual.nombre : textoOpcional(b.nombre)
      if (!nombre) {
        throw new IpcError('NEGOCIO_NOMBRE_REQUERIDO', 400, 'El negocio necesita un nombre')
      }
      const tipoComercio = b.tipoComercio === undefined ? actual.tipo_comercio : textoOpcional(b.tipoComercio)
      if (!TIPOS_COMERCIO.includes(tipoComercio)) {
        throw new IpcError(
          'NEGOCIO_TIPO_INVALIDO',
          400,
          `Tipo de comercio inválido: ${b.tipoComercio}. Permitidos: ${TIPOS_COMERCIO.join(', ')}`
        )
      }
      let configuracion = actual.configuracion
      if (b.configuracion !== undefined) {
        if (b.configuracion === null || typeof b.configuracion !== 'object' || Array.isArray(b.configuracion)) {
          throw new IpcError('NEGOCIO_CONFIG_INVALIDA', 400, 'La configuración debe ser un objeto')
        }
        let guardada = {}
        try {
          guardada = JSON.parse(actual.configuracion || '{}')
        } catch {
          guardada = {}
        }
        configuracion = JSON.stringify({ ...guardada, ...b.configuracion })
      }
      const activo = b.activo === undefined ? actual.activo : b.activo ? 1 : 0
      const ts = new Date().toISOString()

      return ctx.tx(() => {
        ctx.db
          .prepare(
            `UPDATE negocios
                SET nombre = ?, ruc = ?, direccion = ?, telefono = ?, email = ?, website = ?, logo = ?,
                    tipo_comercio = ?, configuracion = ?, activo = ?, updated_at = ?
              WHERE id = ? AND deleted_at IS NULL`
          )
          .run(
            nombre,
            b.ruc === undefined ? actual.ruc : textoOpcional(b.ruc),
            b.direccion === undefined ? actual.direccion : textoOpcional(b.direccion),
            b.telefono === undefined ? actual.telefono : textoOpcional(b.telefono),
            b.email === undefined ? actual.email : textoOpcional(b.email),
            b.website === undefined ? actual.website : textoOpcional(b.website),
            b.logo === undefined ? actual.logo : textoOpcional(b.logo),
            tipoComercio,
            configuracion,
            activo,
            ts,
            reqCtx.negocioId
          )
        ctx.db
          .prepare(
            `INSERT INTO auditoria (tabla, registro_id, accion, valores_anteriores, valores_nuevos, user_id, negocio_id, created_at, updated_at)
             VALUES ('negocios', ?, 'UPDATE', ?, ?, ?, ?, ?, ?)`
          )
          .run(
            reqCtx.negocioId,
            JSON.stringify({ nombre: actual.nombre, tipoComercio: actual.tipo_comercio }),
            JSON.stringify({ nombre, tipoComercio }),
            reqCtx.actorId,
            reqCtx.negocioId,
            ts,
            ts
          )
        return mapNegocio(leer(reqCtx.negocioId))
      })
    }
  })

  return registry
}
