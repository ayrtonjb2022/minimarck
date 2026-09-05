-- Agregar columna idempotency_key a la tabla ventas
-- Permite prevenir ventas duplicadas cuando la respuesta del servidor se pierde

ALTER TABLE ventas
  ADD COLUMN idempotency_key VARCHAR(36) NULL UNIQUE AFTER observaciones;

-- Índice para búsquedas rápidas por idempotency_key
CREATE INDEX idx_ventas_idempotency_key ON ventas (idempotency_key);
