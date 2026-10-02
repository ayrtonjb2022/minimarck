import { createCtx } from '../db/ctx.js'
import { requireTenant } from '../db/seed.js'
import { offsetMinutos, hoyLocal } from '../db/reportes/fechas.js'
import { dashboardStats } from '../db/repositories/dashboard.repo.js'
import {
  reporteAnalisisNegocio,
  reporteCaja,
  reporteCompras,
  reporteDeudores,
  reporteEstadoResultados,
  reporteGastos,
  reporteGerencial,
  reporteProductosMasVendidos,
  reporteStock,
  reporteVentas
} from '../db/repositories/reportes.repo.js'

/**
 * The ten `reportes.*` handlers, over the real database.
 *
 * ALL TEN MEMBERS OF THE GROUP ARE LIVE. The contract's `reportes` group is not a wish list with
 * three done entries: it names ten operations, ten screens sit behind them, and a group where
 * every member answers 501 is a group the owner cannot use. `dashboard.notificaciones.list` is
 * a DIFFERENT group and is untouched by this file.
 *
 * THE CLOCK IS RESOLVED HERE, IN MAIN, AND PASSED DOWN. `reloj()` reads the host's offset and the
 * local date once per call and hands both to the repository, so no report has to ask what time it
 * is and no renderer can answer that question. The renderer is on another process with its own
 * idea of "now"; a window that came from there would be a window the renderer chose.
 */
export function registerReportesHandlers(registry, { conn }) {
  const ctx = (reqCtx) => createCtx(conn, reqCtx ?? {})

  /** The one place the reports learn what time it is. */
  const reloj = (ahora = new Date()) => {
    const offsetMin = offsetMinutos(ahora)
    return { ahora, offsetMin, hoyLocal: hoyLocal(ahora, offsetMin) }
  }

  registry.register('reportes', {
    sales: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return reporteVentas(ctx(reqCtx), payload, reloj())
    },

    topProducts: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return reporteProductosMasVendidos(ctx(reqCtx), payload, reloj())
    },

    /**
     * The till. Takes no dates, because a till is not a period — it is a session, and the report
     * names which one it read in `alcance`. An optional `cajaId` reads a specific till; omitted,
     * it reads the open one, and with no till open it reports the whole business's cash.
     */
    cash: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return reporteCaja(ctx(reqCtx), payload)
    },

    incomeStatement: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return reporteEstadoResultados(ctx(reqCtx), payload, reloj())
    },

    managerial: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return reporteGerencial(ctx(reqCtx), payload, reloj())
    },

    businessAnalysis: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return reporteAnalisisNegocio(ctx(reqCtx), payload, reloj())
    },

    /** The shelf, as it is right now. No dates, on purpose. */
    stock: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return reporteStock(ctx(reqCtx))
    },

    expenses: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return reporteGastos(ctx(reqCtx), payload, reloj())
    },

    purchases: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return reporteCompras(ctx(reqCtx), payload, reloj())
    },

    debtors: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      return reporteDeudores(ctx(reqCtx), payload, reloj())
    }
  })

  return registry
}

/**
 * The `dashboard.stats` handler.
 *
 * It is registered from this file rather than from `ipc/dashboard.js` because there is no second
 * thing for that module to do: `dashboard` is a one-member group. A file named for a group with
 * one operation is a file whose name will be wrong the day the second operation exists, and the
 * report handlers and the dashboard read the same clock through the same `reloj()`.
 */
export function registerDashboardHandlers(registry, { conn }) {
  const ctx = (reqCtx) => createCtx(conn, reqCtx ?? {})

  registry.register('dashboard', {
    stats: (payload, reqCtx) => {
      requireTenant(reqCtx?.negocioId)
      const ahora = new Date()
      return dashboardStats(ctx(reqCtx), payload, { ahora, offsetMin: offsetMinutos(ahora) })
    }
  })

  return registry
}
