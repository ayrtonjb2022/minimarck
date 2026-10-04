import { describe, it, expect, afterEach } from 'vitest'
import { tienda, ctxDe } from './fixtures/tienda.js'

const stores = []
afterEach(() => {
  while (stores.length > 0) stores.pop().cerrar()
})

describe('004_arqueo — columnas aditivas', () => {
  it('sobre base poblada, las nuevas columnas leen NULL y las filas existentes siguen válidas y actualizables', () => {
    const t = tienda()
    stores.push(t)

    const negocioId = t.negocioId
    const usuarioId = t.usuarioId

    // Insertamos una venta ya cancelada con motivo NULL (caso histórico)
    const ventaId = t.conn.db
      .prepare(
        `INSERT INTO ventas (folio, fecha, subtotal_centavos, iva_centavos, descuento_centavos, total_centavos,
                             metodo_pago, estado, cliente_nombre, user_id, negocio_id, created_at, updated_at,
                             motivo_cancelacion, cancelada_por, cancelada_at)
         VALUES ('V-TEST', ?, 1000, 0, 0, 1000, 'efectivo', 'cancelada', 'Cliente', ?, ?, ?, ?,
                 NULL, NULL, NULL)`
      )
      .run(new Date().toISOString(), usuarioId, negocioId, new Date().toISOString(), new Date().toISOString())

    // Insertamos una caja cerrada (sin conteo aún)
    const cajaId = t.conn.db
      .prepare(
        `INSERT INTO cajas (fecha_apertura, fecha_cierre, saldo_inicial_centavos, total_ingresos_centavos,
                             total_egresos_centavos, saldo_final_centavos, estado, user_id, usuario_apertura, usuario_cierre, negocio_id,
                             created_at, updated_at, monto_contado_centavos, diferencia_centavos)
         VALUES (?, ?, 5000, 1000, 0, 6000, 'cerrada', ?, ?, ?, ?,
                 ?, ?,
                 NULL, NULL)`
      )
      .run(new Date().toISOString(), new Date().toISOString(), usuarioId, usuarioId, usuarioId, negocioId, new Date().toISOString(), new Date().toISOString())

    // Leer: las nuevas columnas son NULL
    const venta = t.conn.db.prepare('SELECT motivo_cancelacion, cancelada_por, cancelada_at FROM ventas WHERE id = ?').get(ventaId.lastInsertRowid)
    expect(venta.motivo_cancelacion).toBeNull()
    expect(venta.cancelada_por).toBeNull()
    expect(venta.cancelada_at).toBeNull()

    const caja = t.conn.db.prepare('SELECT monto_contado_centavos, diferencia_centavos FROM cajas WHERE id = ?').get(cajaId.lastInsertRowid)
    expect(caja.monto_contado_centavos).toBeNull()
    expect(caja.diferencia_centavos).toBeNull()

    // Actualizables: venta cancelada con motivo NULL puede seguir actualizándose
    const resVenta = t.conn.db.prepare('UPDATE ventas SET observaciones = ? WHERE id = ?').run('nota', ventaId.lastInsertRowid)
    expect(resVenta.changes).toBe(1)

    // Caja cerrada con NULLs puede actualizarse
    const resCaja = t.conn.db.prepare('UPDATE cajas SET observaciones = ? WHERE id = ?').run('obs', cajaId.lastInsertRowid)
    expect(resCaja.changes).toBe(1)
  })
})
