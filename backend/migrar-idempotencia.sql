-- Idempotencia de ventas: clave única por negocio para reintentos seguros.
-- MySQL permite múltiples NULLs en un índice único, así que las ventas
-- históricas (idempotency_key = NULL) no se ven afectadas.
ALTER TABLE ventas
  ADD COLUMN idempotency_key VARCHAR(100) NULL AFTER deudor_id,
  ADD UNIQUE KEY uq_ventas_negocio_idempotency (negocio_id, idempotency_key);