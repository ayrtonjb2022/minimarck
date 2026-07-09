/**
 * Migración: convertir Venta.fecha de DATETIME a DATE
 * 
 * Las ventas se creaban con `fecha: new Date()` que almacenaba
 * la hora en UTC. Para Argentina (UTC-3), una venta de las 21h
 * se guardaba como las 00h del día siguiente UTC, apareciendo
 * en filtros del día equivocado.
 * 
 * Esta migración:
 * 1. Convierte la columna a DATE (pierde la hora)
 * 2. Ajusta la fecha para timezone UTC-3: si la hora era < 3 AM,
 *    resta 1 día porque correspondía a la noche anterior en Argentina
 */
const { Sequelize } = require("sequelize");
const sequelize = require("../config/database");

async function migrate() {
  console.log("🔍 Verificando estructura actual...");
  const [cols] = await sequelize.query("DESCRIBE ventas");
  const fechaCol = cols.find((c) => c.Field === "fecha");
  console.log(`  Columna actual: ${fechaCol.Type}`);

  if (fechaCol.Type === "date") {
    console.log("✅ La columna ya es DATE. No hace falta migrar.");
    process.exit(0);
  }

  console.log("⏳ Convirtiendo fechas existentes a zona horaria Argentina...");
  
  // Paso 1: actualizar registros donde la hora UTC está entre 00:00 y 02:59
  // (esos corresponden al día anterior en Argentina UTC-3)
  const [fixResult] = await sequelize.query(`
    UPDATE ventas 
    SET fecha = DATE(DATE_SUB(fecha, INTERVAL 1 DAY))
    WHERE TIME(fecha) BETWEEN '00:00:00' AND '02:59:59'
  `);
  console.log(`  Registros ajustados (-1 día): ${fixResult.affectedRows}`);

  // Paso 2: cambiar el tipo de columna a DATE
  console.log("⏳ Cambiando tipo de columna a DATE...");
  await sequelize.query("ALTER TABLE ventas MODIFY COLUMN fecha DATE NOT NULL");
  console.log("✅ Columna convertida a DATE");

  // Paso 3: verificar
  const [check] = await sequelize.query("DESCRIBE ventas");
  const newCol = check.find((c) => c.Field === "fecha");
  console.log(`  Columna ahora: ${newCol.Type}`);

  console.log("✅ Migración completada.");
  process.exit(0);
}

migrate().catch((err) => {
  console.error("❌ Error en migración:", err);
  process.exit(1);
});
