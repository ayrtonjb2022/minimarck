import { IpcError } from '../bridge/errors.js'
import { requireTenant } from '../db/seed.js'

/**
 * `negocio.obtener` — the shop this file belongs to.
 *
 * The one line the shell needs above the operator's name. It reads through `requireTenant` like
 * every other handler in the app, so a file whose identity did not resolve answers TENANT_REQUIRED
 * here too rather than reaching into `negocios` and picking a row: a header that says
 * "Acme Lácteos" above a till that cannot sell anything would be a lie in the most visible place
 * in the window.
 *
 * `negocio.actualizar` is a settings screen, which is not mounted in this build, and answers 501.
 */
export function registerNegocioHandlers(registry, { conn }) {
  registry.register('negocio', {
    obtener: (_payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      const fila = conn.db
        .prepare('SELECT * FROM negocios WHERE id = ? AND deleted_at IS NULL')
        .get(reqCtx.negocioId)
      if (!fila) {
        throw new IpcError('NEGOCIO_NO_ENCONTRADO', 404, 'Negocio no encontrado')
      }
      return {
        id: fila.id,
        nombre: fila.nombre,
        ruc: fila.ruc,
        tipoComercio: fila.tipo_comercio,
        activo: Boolean(fila.activo)
      }
    }
  })

  return registry
}
