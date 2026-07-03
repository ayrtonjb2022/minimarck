const sequelize = require("../config/database");
const setupCircularRelations = require("../models/relations");
const { User } = require("../models/index");

const syncDatabase = async () => {
  try {
    await sequelize.authenticate();
    console.log("✅ Conexión a MySQL establecida");

    // PASO 1: Sincronizar todas las tablas (sin relaciones circulares)
    await sequelize.sync({ force: process.env.DB_FORCE_SYNC === "true" });
    console.log("✅ Tablas sincronizadas (Paso 1)");

    // PASO 2: Agregar las relaciones circulares
    // Esto agrega las FK que faltan (no borra datos)
    setupCircularRelations();
    console.log("✅ Relaciones circulares configuradas (Paso 2)");

    // Verificar usuarios
    const count = await User.count();
    console.log(`📊 Total de usuarios: ${count}`);

    if (count === 0) {
      console.log(
        "💡 No hay usuarios. Ejecuta npm run db:seed para crear datos de prueba",
      );
    }

    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
};

syncDatabase();
