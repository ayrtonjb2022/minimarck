import { IpcError } from '../bridge/errors.js'
import { assertCents, toCents } from '../../shared/money.js'
import { requireTenant } from '../db/seed.js'
import {
  abrir,
  cajaActiva,
  cerrar,
  desglose,
  obtener,
  movimientos,
  listar,
  registrarMovimiento,
  saldoGeneral
} from '../db/repositories/cajas.repo.js'
import { createCtx } from '../db/ctx.js'

/**
 * The `cajas.*` and `cajaMovimientos.*` handlers, backed by the real database.
 *
 * All seven `cajas` operations and all three `cajaMovimientos` operations named in the frozen
 * contract are implemented here. Nothing was added to `OPS` to make that possible.
 *
 * THE TENANT COMES FROM THE REQUEST, NEVER FROM A CLOSURE. `installIpc` hands every handler a
 * `{ negocioId, actorId }` that S4's local auth marker fills in, and this module passes it
 * straight to `createCtx`. A handler that captured a business id at registration time would be a
 * handler that sells from the wrong shop the moment a second business exists, and the code would
 * look correct. Until S4 fills it, every one of these calls fails with `TENANT_REQUIRED` — which
 * is the truthful answer for a call with no business, and the same refusal `seed.js` already
 * makes rather than defaulting a tenant to something.
 */
export function registerCajasHandlers(registry, { conn }) {
  const ctx = (reqCtx) => createCtx(conn, reqCtx ?? {})

  registry.register('cajas', {
    /** The open till, or `null` — never an error. A closed shop is not a broken shop. */
    active: (_payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return cajaActiva(conn.db, reqCtx.negocioId)
    },

    /** Every till, newest first. */
    list: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return listar(conn.db, reqCtx.negocioId, {
        limit: payload?.limit ?? 20,
        offset: payload?.offset ?? 0,
        estado: payload?.estado ?? null
      })
    },

    get: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return obtener(conn.db, reqCtx.negocioId, payload?.id)
    },

    /**
     * Open the till. `CAJA_ABIERTA` (400) when one is already open — the useful error, with the
     * web's own wording, and it is also what the losing writer of a genuine race receives.
     */
    open: (payload, reqCtx) => abrir(ctx(reqCtx), { saldoInicial: payload?.saldoInicial ?? 0, observaciones: payload?.observaciones ?? null }),

    close: (payload, reqCtx) => cerrar(ctx(reqCtx), payload?.id, { observaciones: payload?.observaciones ?? null }),

    /** Closed tills plus the live balance of the open one. */
    generalBalance: (_payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return saldoGeneral(conn.db, reqCtx.negocioId)
    },

    /** Sales by payment method for one till. */
    breakdown: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return desglose(conn.db, reqCtx.negocioId, payload?.id)
    }
  })

  registry.register('cajaMovimientos', {
    /**
     * A manual cash movement: money in or out that no sale or purchase explains.
     *
     * This operation is why `CAJA_SALDO_NEGATIVO` is not a dead end. That refusal tells the
     * operator to record the missing income before closing the till, and an instruction pointing
     * at an operation that answers 501 is worse than no instruction at all.
     *
     * `origen: 'manual'` is what marks it, and the schema's CHECK ties `origen = 'venta'` to
     * carrying a `venta_id`, so a manual movement with no sale is the only shape it can take.
     */
    create: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      const c = ctx(reqCtx)
      return c.tx(() => {
        const cajaId = Number(payload?.cajaId)
        if (!Number.isSafeInteger(cajaId) || cajaId < 1) {
          throw new IpcError('CAJA_ID_INVALIDO', 400, `Id de caja inválido: ${payload?.cajaId}`)
        }
        const caja = conn.db
          .prepare('SELECT * FROM cajas WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL')
          .get(cajaId, reqCtx.negocioId)
        if (!caja) {
          throw new IpcError('CAJA_NO_ENCONTRADA', 404, 'Caja no encontrada')
        }
        if (caja.estado !== 'abierta') {
          throw new IpcError('CAJA_CERRADA', 400, 'La caja está cerrada: no admite movimientos')
        }
        const tipo = payload?.tipo
        if (tipo !== 'ingreso' && tipo !== 'egreso') {
          throw new IpcError('MOVIMIENTO_TIPO_INVALIDO', 400, `Tipo de movimiento inválido: ${tipo}`)
        }
        const concepto = typeof payload?.concepto === 'string' ? payload.concepto.trim() : ''
        if (concepto === '') {
          throw new IpcError('MOVIMIENTO_SIN_CONCEPTO', 400, 'El movimiento necesita un concepto')
        }
        const montoCentavos = assertCents(toCents(payload?.monto, 'monto'), 'monto')
        if (montoCentavos < 1) {
          // `movimientos_caja.monto_centavos >= 1`, and a zero movement is not a small movement:
          // it is a row with no amount that still has to be explained at every future audit.
          throw new IpcError('MOVIMIENTO_MONTO_CERO', 400, 'El monto del movimiento debe ser mayor a cero')
        }
        const movimiento = registrarMovimiento(c, {
          caja,
          tipo,
          concepto,
          montoCentavos,
          origen: 'manual',
          referencia: payload?.referencia ?? null
        })
        return { ...movimiento, cajaId: caja.id, tipo, concepto }
      })
    },

    listByCaja: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      const cajaId = Number(payload?.cajaId)
      if (!Number.isSafeInteger(cajaId) || cajaId < 1) {
        throw new IpcError('CAJA_ID_INVALIDO', 400, `Id de caja inválido: ${payload?.cajaId}`)
      }
      return movimientos(conn.db, cajaId)
    },

    summary: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      const cajaId = Number(payload?.cajaId)
      if (!Number.isSafeInteger(cajaId) || cajaId < 1) {
        throw new IpcError('CAJA_ID_INVALIDO', 400, `Id de caja inválido: ${payload?.cajaId}`)
      }
      const caja = obtener(conn.db, reqCtx.negocioId, cajaId)
      return {
        cajaId: caja.id,
        saldoInicialCentavos: caja.saldo_inicial_centavos,
        totalIngresosCentavos: caja.total_ingresos_centavos,
        totalEgresosCentavos: caja.total_egresos_centavos,
        saldoActualCentavos: caja.saldoActualCentavos,
        saldoFinalCentavos: caja.saldo_final_centavos,
        movimientos: caja.movimientos.length
      }
    }
  })

  return registry
}
