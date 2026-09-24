-- Agrega la columna costo_unitario a ventas_detalles (si no existe)
ALTER TABLE ventas_detalles ADD COLUMN costo_unitario DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER precio_unitario;
