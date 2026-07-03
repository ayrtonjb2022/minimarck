require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const { Sequelize } = require("sequelize");
const bcrypt = require("bcryptjs");

// ── CONFIG ──────────────────────────────────────────────
const NEGOCIO_NOMBRE = "Mi Despensa";
const ADMIN_EMAIL = "admin@midespensa.com";
const ADMIN_PASS = "Admin123!";

const CSV_PATH = path.join(process.env.USERPROFILE || "C:\\Users\\benit", "Downloads", "deepseek_csv_20260703_23d6c7.txt");

// ── DB ──────────────────────────────────────────────────
const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    dialect: "mysql",
    logging: false,
  }
);

function parseCSV(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(l => l);
  const header = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));

  const result = [];
  for (let i = 1; i < lines.length; i++) {
    // Manual CSV parsing (handles quoted fields with commas)
    const row = {};
    let field = "", inQuotes = false, colIdx = 0;

    for (let c = 0; c < lines[i].length; c++) {
      const ch = lines[i][c];
      if (ch === '"') {
        if (inQuotes && c + 1 < lines[i].length && lines[i][c + 1] === '"') {
          field += '"';
          c++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        if (colIdx < header.length) {
          row[header[colIdx]] = field.trim();
        }
        field = "";
        colIdx++;
      } else {
        field += ch;
      }
    }
    if (colIdx < header.length) {
      row[header[colIdx]] = field.trim();
    }

    const nombre = row["Nombre"];
    const categoria = row["Categoría"] || "";
    const stock = parseInt(row["Stock"] || "0", 10);
    const precio = parseFloat(row["Precio"]?.replace(",", ".") || "0");
    const costo = parseFloat(row["Costo"]?.replace(",", ".") || "0");

    if (nombre) {
      result.push({
        nombre: nombre.trim().replace(/^"|"$/g, ""),
        categoriaRaw: categoria.trim().replace(/^"|"$/g, ""),
        stock: isNaN(stock) ? 0 : Math.max(0, stock),
        precio: isNaN(precio) ? 0 : precio,
        costo: isNaN(costo) ? 0 : costo,
        activo: true,
      });
    }
  }
  return result;
}

function normalizeCategory(name) {
  if (!name) return "General";
  let n = name.toUpperCase().trim();

  // Group similar categories
  const groups = {
    "GASEOSA": ["GASEOSA", "GASEOSA, GASEOSA"],
    "GOLOSINAS": ["GOLOCINAS", "GOLOCINA", "GOLOSINA", "CARAMELO/MASTICABLE", "CARAMELO DE ANIS", "HALL/CHERY/LIMA LIMON"],
    "BEBIDA": ["BEBIDA", "BEBIDAS", "BEBIDA ALCOHOL", "CERVEZA", "CERVEZA ANDES 1L", "JUGO", "VINO", "AGUA"],
    "GALLETITAS": ["GALLETITAS", "FAUNA/GALLETITA", "GALLETITA", "GALLETITA MEDIA TARDE /SULTA", "GALLETITAS PEPAS TRIO"],
    "SNACK": ["SNACK", "PAPA FRITA SUELTA", "PAPA JULICROS/ 70GS"],
    "LIMPIEZA": ["RESUELTO", "JABON LIQUIDO/ ARIEL (100CC)", "JABON TOCADOR /PLUSBELL", "SUAVIZANTE", "TRAPO DE PISO", "COCINA LIMPIEZA"],
    "MEDICAMENTO": ["MEDICAMENTO", "1 TABLETA DE 10"],
    "CHOCOLATE": ["CHOCOLATE"],
    "ALIMENTO": ["ALIMENTO", "FIDEO", "FIDEO TALLARIN/SANTA ISABEL", "FIDEOS CICA/ CODITO ETC"],
    "LÁCTEOS": ["POSTRE /SERENISIMA", "QUESO CREMOSO NARDIELLO/X100GS", "QUESO UNTABLE", "QUESO CREMOSO"],
  };

  for (const [normalized, aliases] of Object.entries(groups)) {
    for (const alias of aliases) {
      if (n.includes(alias) || alias.includes(n)) return normalized;
    }
  }

  // Capitalize first letter
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

(async () => {
  try {
    console.log("Conectando a MySQL...");
    await sequelize.authenticate();

    // ── 1. CREAR NEGOCIO ──
    console.log("\n── Creando negocio ──");
    const [negocioResult] = await sequelize.query(
      "INSERT INTO negocios (nombre, tipo_comercio, activo, created_at, updated_at) VALUES (?, 'despensa', true, NOW(), NOW())",
      { replacements: [NEGOCIO_NOMBRE] }
    );
    const negocioId = negocioResult.insertId || negocioResult;
    console.log("  Negocio #" + negocioId + ": " + NEGOCIO_NOMBRE);

    // ── 2. CREAR USUARIO ──
    console.log("\n── Creando usuario admin ──");
    const salt = await bcrypt.genSalt(10);
    const hashedPass = await bcrypt.hash(ADMIN_PASS, salt);
    const [userResult] = await sequelize.query(
      "INSERT INTO users (nombre, email, password, rol, activo, negocio_id, created_at, updated_at) VALUES (?, ?, ?, 'admin', true, ?, NOW(), NOW())",
      { replacements: ["Admin", ADMIN_EMAIL, hashedPass, negocioId] }
    );
    const userId = userResult.insertId || userResult;
    console.log("  User #" + userId + ": " + ADMIN_EMAIL);

    // ── 3. CREAR SUSCRIPCIÓN ──
    console.log("\n── Creando suscripción ──");
    await sequelize.query(
      "INSERT INTO suscripciones (plan, max_usuarios, max_productos, activa, negocio_id, fecha_inicio, created_at, updated_at) VALUES ('basico', 5, 9999, true, ?, NOW(), NOW(), NOW())",
      { replacements: [negocioId] }
    );
    console.log("  Suscripción: plan básico, 9999 productos max");

    // ── 4. LEER Y PARSEAR CSV ──
    console.log("\n── Leyendo productos ──");
    const csvRaw = fs.readFileSync(CSV_PATH, "utf-8");
    const allProducts = parseCSV(csvRaw);
    console.log("  Total filas leídas: " + allProducts.length);

    // ── 5. EXTRAER Y CREAR CATEGORÍAS ──
    console.log("\n── Creando categorías ──");
    const rawCategories = [...new Set(allProducts.map(p => normalizeCategory(p.categoriaRaw)))].sort();
    const catMap = {}; // normalizedName -> id

    for (const catName of rawCategories) {
      const [catResult] = await sequelize.query(
        "INSERT INTO categorias (nombre, user_id, negocio_id, activo, created_at, updated_at) VALUES (?, ?, ?, true, NOW(), NOW())",
        { replacements: [catName, userId, negocioId] }
      );
      const catId = catResult.insertId || catResult;
      catMap[catName] = catId;
      console.log("  ✔ " + catName + " → id " + catId);
    }

    // ── 6. INSERTAR PRODUCTOS ──
    console.log("\n── Insertando productos ──");
    let inserted = 0, skipped = 0;
    const seen = new Set();

    for (const p of allProducts) {
      const catName = normalizeCategory(p.categoriaRaw);
      const categoriaId = catMap[catName] || null;

      // Skip duplicates (same name + same price)
      const dedupKey = (p.nombre + "|" + p.precio).toLowerCase();
      if (seen.has(dedupKey)) {
        skipped++;
        continue;
      }
      seen.add(dedupKey);

      try {
        await sequelize.query(
          `INSERT INTO productos (nombre, precio, precio_compra, stock, stock_minimo, categoria_id, user_id, negocio_id, activo, created_at, updated_at, unidad_medida)
           VALUES (?, ?, ?, ?, 3, ?, ?, ?, true, NOW(), NOW(), 'unidad')`,
          {
            replacements: [
              p.nombre.substring(0, 200),
              p.precio,
              p.costo,
              p.stock,
              categoriaId,
              userId,
              negocioId,
            ],
          }
        );
        inserted++;
      } catch (err) {
        // Skip if unique constraint fails
        skipped++;
      }

      if (inserted % 50 === 0 && inserted > 0) {
        process.stdout.write("  Progreso: " + inserted + " productos...\n");
      }
    }

    console.log("\n── Resumen ──");
    console.log("  Productos insertados: " + inserted);
    console.log("  Productos omitidos (duplicados): " + skipped);
    console.log("  Categorías creadas: " + rawCategories.length);

    console.log("\n═══ CREDENCIALES ═══");
    console.log("  Email:    " + ADMIN_EMAIL);
    console.log("  Password: " + ADMIN_PASS);
    console.log("  Negocio:  " + NEGOCIO_NOMBRE);
    console.log("════════════════════\n");

    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error("ERROR:", err.message);
    if (err.parent) console.error("DB:", err.parent.message);
    process.exit(1);
  }
})();
