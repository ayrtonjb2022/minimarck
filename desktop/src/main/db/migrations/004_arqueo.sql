-- 004 — ARQUEO: columnas para arqueo de caja y cancelación de ventas.
--
-- Cambio: cierre-de-caja-y-anulaciones (C1).
--
-- ARQUEO DE CAJA: el cierre registra lo que se contó físicamente y la diferencia.
--   - monto_contado_centavos: lo que el operador contó (>= 0), nullable (tills ya cerradas pueden seguir como están).
--   - diferencia_centavos: monto_contado - saldo del sistema (puede ser negativo para faltante), nullable.
--
-- ANULACIÓN DE VENTAS: se vuelve responsable.
--   - motivo_cancelacion: uno de cuatro valores, solo tiene sentido cuando estado='cancelada' (la transición se valida en 005).
--   - cancelada_por: referencia al usuario que anuló, ON DELETE SET NULL ON UPDATE CASCADE (auditoría, no se borra con usuario).
--   - cancelada_at: timestamp ISO-8601 de la anulación.
--
-- Todas nullable. Sin triggers (van en 005). Operación segura sobre base ya poblada.

ALTER TABLE cajas ADD COLUMN monto_contado_centavos INTEGER CHECK (monto_contado_centavos >= 0);
ALTER TABLE cajas ADD COLUMN diferencia_centavos INTEGER;

ALTER TABLE ventas ADD COLUMN motivo_cancelacion TEXT
  CHECK (motivo_cancelacion IS NULL OR motivo_cancelacion IN ('devolucion','producto_defectuoso','error_de_cobro','otro'));
ALTER TABLE ventas ADD COLUMN cancelada_por INTEGER
  REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE ventas ADD COLUMN cancelada_at TEXT;
