/**
 * Migración OPCIONAL: convertir DATETIME a DATE en ventas, compras y pagos_deuda.
 *
 * ⚠️ LOS MODELOS AHORA USAN DATE (DATETIME) — no hace falta migrar para que funcione.
 * Solo ejecutar esta migración CUANDO QUIERAS eliminar el spillover de timezone
 * de datos históricos.
 *
 * Problema: las fechas se almacenaban en UTC. Para Argentina (UTC-3), una
 * venta de las 21h se guardaba como las 00h del día siguiente UTC.
 *
 * Solución definitiva: convertir la columna a DATE y ajustar los registros
 * con hora < 3AM (restar 1 día porque corresponden a la noche anterior en Argentina).
 *
 * CORRELO SOLO SI ESTÁS SEGURO, con BACKUP de la DB primero.
 *
 * Tablas:
 *  - ventas.fecha
 *  - compras.fecha
 *  - pagos_deuda.fecha
 *
 * movimientos_caja.created_at y cajas.fecha_apertura/cierre quedan DATETIME.
 */
const sequelize = require("../config/database");

async function migrateColumn(table, column, notNull = true) {
  console.log(`\n📋 ${table}.${column}:`);
  const [cols] = await sequelize.query(`DESCRIBE ${table}`);
  const colInfo = cols.find((c) => c.Field === column);
  console.log(`  Tipo actual: ${colInfo.Type}`);

  if (colInfo.Type === "date") {
    console.log("  ✅ Ya es DATE. Omitiendo.");
    return { skipped: true };
  }

  console.log(`  ⏳ Ajustando timezone UTC→Argentina...`);
  const [fixResult] = await sequelize.query(`
    UPDATE ${table} 
    SET ${column} = DATE(DATE_SUB(${column}, INTERVAL 1 DAY))
    WHERE TIME(${column}) BETWEEN '00:00:00' AND '02:59:59'
      AND ${column} IS NOT NULL
  `);
  console.log(`    Registros ajustados (-1 día): ${fixResult.affectedRows}`);

  console.log("  ⏳ Cambiando tipo a DATE...");
  const nullableClause = notNull ? "NOT NULL" : "";
  await sequelize.query(
    `ALTER TABLE ${table} MODIFY COLUMN ${column} DATE ${nullableClause}`
  );
  console.log("  ✅ Columna convertida a DATE");

  return { skipped: false };
}

async function migrate() {
  console.log("⚠️  MIGRACIÓN OPCIONAL — hacé BACKUP antes de ejecutar\n");

  await migrateColumn("ventas", "fecha", true);
  await migrateColumn("compras", "fecha", true);
  await migrateColumn("pagos_deuda", "fecha", false);

  console.log("\n✅ Migración completada.\n");
  console.log("📌 Los modelos usan DATE (DATETIME). Para activar DATEONLY,");
  console.log("   cambiá los modelos DESPUÉS de migrar la DB.");
  process.exit(0);
}

migrate().catch((err) => {
  console.error("❌ Error en migración:", err);
  process.exit(1);
});
