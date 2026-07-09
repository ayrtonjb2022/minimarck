-- ============================================================
-- REPARACIÓN DE FECHAS CORRUPTAS POR LA MIGRACIÓN
-- ============================================================
-- La migración restó 1 día a TODOS los registros porque
-- TODOS tenían TIME(fecha) = '00:00:00'. Algunos recibieron
-- -2 por ejecutarse doble.
-- ============================================================

-- 1. VENTAS
-- Restaurar 1 día a los que perdieron 1
UPDATE ventas
SET fecha = DATE_ADD(fecha, INTERVAL 1 DAY)
WHERE id BETWEEN 16 AND 36;

UPDATE ventas
SET fecha = DATE_ADD(fecha, INTERVAL 1 DAY)
WHERE id BETWEEN 40 AND 57;

UPDATE ventas
SET fecha = DATE_ADD(fecha, INTERVAL 1 DAY)
WHERE id BETWEEN 69 AND 90;

-- Restaurar 2 días a los que perdieron 2
UPDATE ventas
SET fecha = DATE_ADD(fecha, INTERVAL 2 DAY)
WHERE id IN (37, 38, 39);

UPDATE ventas
SET fecha = DATE_ADD(fecha, INTERVAL 2 DAY)
WHERE id BETWEEN 58 AND 68;

UPDATE ventas
SET fecha = DATE_ADD(fecha, INTERVAL 2 DAY)
WHERE id = 91;

-- Venta 92 fue creada con DATEONLY entre el backup y la migración
-- created_at = '2026-07-09 20:31:19' UTC = 17:31 ARG → fecha correcta: 2026-07-09
UPDATE ventas
SET fecha = '2026-07-09'
WHERE id = 92;

-- Ventas 93 y 94 están correctas (2026-07-09) ✅

-- ============================================================
-- 2. COMPRAS
-- Todas perdieron exactamente 1 día
UPDATE compras
SET fecha = DATE_ADD(fecha, INTERVAL 1 DAY)
WHERE id BETWEEN 8 AND 36;

-- ============================================================
-- 3. PAGOS DEUDA
-- Todas perdieron exactamente 1 día
UPDATE pagos_deuda
SET fecha = DATE_ADD(fecha, INTERVAL 1 DAY)
WHERE id BETWEEN 1 AND 10;

-- ============================================================
-- VERIFICACIÓN POST-FIX
-- ============================================================
-- SELECT 'ventas' as tabla, id, fecha FROM ventas WHERE id BETWEEN 16 AND 39 ORDER BY id;
-- SELECT 'compras' as tabla, id, fecha FROM compras WHERE id BETWEEN 8 AND 36 ORDER BY id;
-- SELECT 'pagos_deuda' as tabla, id, fecha FROM pagos_deuda WHERE id BETWEEN 1 AND 10 ORDER BY id;
