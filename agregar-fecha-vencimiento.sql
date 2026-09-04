-- ============================================================
-- AGREGAR CAMPO DE FECHA DE VENCIMIENTO A PRODUCTOS
-- ============================================================
-- Agrega la columna fecha_vencimiento para rastrear la fecha
-- de vencimiento de los productos. NULL = sin seguimiento.
-- ============================================================

-- 1. Agregar columna fecha_vencimiento
ALTER TABLE productos
  ADD COLUMN fecha_vencimiento DATE NULL AFTER stock_minimo;

-- 2. Índice para consultas eficientes de vencimiento
CREATE INDEX idx_productos_vencimiento ON productos(fecha_vencimiento);

-- ============================================================
-- VERIFICACIÓN
-- ============================================================
-- SELECT id, nombre, stock_minimo, fecha_vencimiento FROM productos LIMIT 5;
-- SHOW INDEX FROM productos WHERE Key_name = 'idx_productos_vencimiento';
