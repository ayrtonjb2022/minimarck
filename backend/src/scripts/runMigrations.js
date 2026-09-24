/**
 * Aplica las migraciones SQL del proyecto (carpeta raíz del backend) sobre una
 * base existente. Es idempotente: re-ejecutarlo sobre una base ya migrada no
 * falla (los errores de "columna/índice ya existe" se ignoran).
 *
 * Orden de aplicación (respetar dependencias):
 *   1. migrar-costo-unitario.sql — costo_unitario en ventas_detalles
 *   2. migrar-idempotencia.sql   — idempotency_key + índice único por negocio
 *   3. migrar-folio.sql          — folio VARCHAR(40) (V-<uuid> = 38 chars)
 *
 * Uso: npm run db:migrate
 * Env: DB_HOST (default localhost), DB_PORT (default 3306), DB_NAME (default
 * minimarck), DB_USER (default root), DB_PASSWORD (default vacío).
 */
const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");

const CONFIG = {
  host: process.env.DB_HOST || "localhost",
  port: process.env.DB_PORT || 3306,
  database: process.env.DB_NAME || "minimarck",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  multipleStatements: true,
};

const MIGRATIONS = [
  { file: "migrar-costo-unitario.sql", descripcion: "costo_unitario en ventas_detalles" },
  { file: "migrar-idempotencia.sql", descripcion: "idempotency_key + índice único (negocio_id, idempotency_key)" },
  { file: "migrar-folio.sql", descripcion: "folio VARCHAR(40)" },
];

// Códigos de error de MySQL que indican "ya aplicada" en una base migrada:
// - ER_DUP_FIELDNAME (1060): la columna ya existe (ALTER ADD COLUMN)
// - ER_DUP_KEYNAME  (1061): el índice ya existe con ese nombre (ADD UNIQUE KEY)
// - ER_DUP_ENTRY    (1062): filas duplicadas al crear el índice único
// - ER_BAD_FIELD_ERROR (1054): columna inexistente (ALTER MODIFY)
const ERRORES_YA_APLICADA = new Set([
  "ER_DUP_FIELDNAME",
  "ER_DUP_KEYNAME",
  "ER_DUP_ENTRY",
  "ER_BAD_FIELD_ERROR",
]);

const run = async () => {
  const conn = await mysql.createConnection(CONFIG);
  try {
    for (const mig of MIGRATIONS) {
      const ruta = path.join(__dirname, "..", "..", mig.file);
      const sql = fs.readFileSync(ruta, "utf8");
      try {
        await conn.query(sql);
        console.log(`✅ ${mig.file} — ${mig.descripcion}`);
      } catch (err) {
        const code = err.code || (err.parent && err.parent.code);
        if (ERRORES_YA_APLICADA.has(code)) {
          console.log(`↪️  ${mig.file} ya aplicada (${code}) — se omite`);
        } else {
          throw err;
        }
      }
    }
    console.log("✅ Migraciones aplicadas (o ya estaban aplicadas)");
  } finally {
    await conn.end();
  }
};

run().catch((err) => {
  console.error("❌ Error aplicando migraciones:", err.message);
  process.exit(1);
});