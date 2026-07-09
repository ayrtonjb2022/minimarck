-- ============================================================
-- TEST DE CONSISTENCIA: CAJA vs REPORTES vs VENTAS vs COMPRAS
-- ============================================================
-- Este script verifica que todos los números coincidan.
-- Copialo y ejecutalo en tu MySQL (phpMyAdmin / consola).
-- ============================================================

-- ============================================================
-- PARTE 1: GENERAR DATOS DE PRUEBA (JUNIO 2026)
-- Descomentar SOLO si querés insertar datos de prueba.
-- Si no, saltear a la PARTE 2.
-- ============================================================
-- INSERT INTO negocios (id, nombre) VALUES (999, 'Test Consistencia');
-- INSERT INTO users (id, nombre, email, password, rol, negocio_id)
--   VALUES (999, 'Test', 'test@test.com', 'x', 'admin', 999);
-- ... (datos de prueba más abajo)

-- ============================================================
-- PARTE 2: VERIFICACIONES DE CONSISTENCIA
-- ============================================================

-- 1. CAJA: ¿totalIngresos = suma de movimientos de ingreso?
SELECT
  c.id,
  c.estado,
  c.total_ingresos AS ingresos_segun_caja,
  COALESCE(SUM(CASE WHEN m.tipo = 'ingreso' THEN m.monto ELSE 0 END), 0) AS ingresos_segun_movimientos,
  CASE WHEN c.total_ingresos = COALESCE(SUM(CASE WHEN m.tipo = 'ingreso' THEN m.monto ELSE 0 END), 0)
       THEN '✅' ELSE '❌' END AS ok_ingresos,
  c.total_egresos AS egresos_segun_caja,
  COALESCE(SUM(CASE WHEN m.tipo = 'egreso' THEN m.monto ELSE 0 END), 0) AS egresos_segun_movimientos,
  CASE WHEN c.total_egresos = COALESCE(SUM(CASE WHEN m.tipo = 'egreso' THEN m.monto ELSE 0 END), 0)
       THEN '✅' ELSE '❌' END AS ok_egresos
FROM cajas c
LEFT JOIN movimientos_caja m ON m.caja_id = c.id
GROUP BY c.id
ORDER BY c.id;

-- 2. FECHAS: ¿ventas.fecha coincide con la fecha Argentina de created_at?
SELECT
  CASE WHEN COUNT(*) = SUM(CASE WHEN fecha = DATE(CONVERT_TZ(created_at, '+00:00', '-03:00')) THEN 1 ELSE 0 END)
       THEN '✅ TODAS BIEN' ELSE '❌ HAY DIFERENCIAS' END AS ventas_fechas,
  SUM(CASE WHEN fecha != DATE(CONVERT_TZ(created_at, '+00:00', '-03:00')) THEN 1 ELSE 0 END) AS cantidad_con_error
FROM ventas
WHERE deleted_at IS NULL;

-- 3. COMPRAS: mismas verificación de fechas
SELECT
  CASE WHEN COUNT(*) = SUM(CASE WHEN fecha = DATE(CONVERT_TZ(created_at, '+00:00', '-03:00')) THEN 1 ELSE 0 END)
       THEN '✅ TODAS BIEN' ELSE '❌ HAY DIFERENCIAS' END AS compras_fechas,
  SUM(CASE WHEN fecha != DATE(CONVERT_TZ(created_at, '+00:00', '-03:00')) THEN 1 ELSE 0 END) AS cantidad_con_error
FROM compras
WHERE deleted_at IS NULL;

-- 4. VERIFICAR ventas crédito vs caja
-- Las ventas a crédito NO generan movimiento de caja
SELECT
  metodo_pago,
  COUNT(*) AS cantidad,
  SUM(total) AS total
FROM ventas
WHERE deleted_at IS NULL AND estado = 'completada'
GROUP BY metodo_pago
ORDER BY cantidad DESC;

-- 5. CONCILIACIÓN: ventas totales vs movimientos_caja ingreso (NO crédito, con caja abierta)
SELECT
  COUNT(DISTINCT v.id) AS ventas_totales,
  COUNT(DISTINCT m.id) AS movimientos_caja_ingreso,
  SUM(v.total) AS suma_ventas,
  COALESCE(SUM(m.monto), 0) AS suma_movimientos
FROM ventas v
LEFT JOIN movimientos_caja m ON m.venta_id = v.id AND m.tipo = 'ingreso'
WHERE v.deleted_at IS NULL AND v.estado = 'completada';

-- 6. DIFERENCIA: Ventas totales - Ventas crédito = Ventas que DEBERÍAN estar en caja
SELECT
  SUM(CASE WHEN metodo_pago != 'credito' THEN total ELSE 0 END) AS ventas_no_credito,
  COALESCE(SUM(m.monto), 0) AS movimientos_ingreso,
  SUM(CASE WHEN metodo_pago != 'credito' THEN total ELSE 0 END) - COALESCE(SUM(m.monto), 0) AS diferencia
FROM ventas v
LEFT JOIN movimientos_caja m ON m.venta_id = v.id AND m.tipo = 'ingreso'
WHERE v.deleted_at IS NULL AND v.estado = 'completada';

-- 7. EGRESOS: compras totales vs movimientos_caja egreso (solo compra-*)
SELECT
  COUNT(*) AS compras_totales,
  SUM(total) AS suma_compras,
  SUM(CASE WHEN m.id IS NOT NULL THEN m.monto ELSE 0 END) AS egresos_caja_por_compras,
  SUM(total) - SUM(CASE WHEN m.id IS NOT NULL THEN m.monto ELSE 0 END) AS compras_sin_caja
FROM compras c
LEFT JOIN movimientos_caja m ON m.referencia = CONCAT('compra-', c.id) AND m.tipo = 'egreso'
WHERE c.deleted_at IS NULL AND c.estado = 'completada';

-- 8. MOVIMIENTOS CAJA que NO son de compras ni de ventas (manuales)
SELECT
  concepto,
  COUNT(*) AS cantidad,
  SUM(monto) AS total
FROM movimientos_caja
WHERE referencia NOT LIKE 'compra-%'
  AND venta_id IS NULL
GROUP BY concepto
ORDER BY cantidad DESC;

-- 9. RESUMEN GENERAL por día (compará con el reporteEstadoResultados)
SELECT
  v.fecha AS dia,
  COUNT(DISTINCT v.id) AS ventas,
  SUM(v.total) AS total_ventas,
  COUNT(DISTINCT c.id) AS compras,
  SUM(c.total) AS total_compras,
  SUM(v.total) - SUM(c.total) AS ganancia_bruta
FROM ventas v
LEFT JOIN compras c ON c.fecha = v.fecha AND c.deleted_at IS NULL AND c.estado = 'completada'
WHERE v.deleted_at IS NULL AND v.estado = 'completada'
GROUP BY v.fecha
ORDER BY v.fecha DESC
LIMIT 30;

-- 10. DETALLE de ventas que NO tienen movimiento de caja (crédito o caja cerrada)
SELECT v.id, v.folio, v.fecha, v.total, v.metodo_pago, v.created_at
FROM ventas v
LEFT JOIN movimientos_caja m ON m.venta_id = v.id AND m.tipo = 'ingreso'
WHERE m.id IS NULL
  AND v.deleted_at IS NULL
  AND v.estado = 'completada'
ORDER BY v.fecha DESC;
