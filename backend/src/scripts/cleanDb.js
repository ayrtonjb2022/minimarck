require("dotenv").config();
const sequelize = require("../config/database");

const tablas = [
  "auditoria",
  "compras_detalles",
  "compras",
  "proveedores",
  "suscripciones",
  "pagos_deuda",
  "ventas_detalles",
  "movimientos_caja",
  "clientes_deudores",
  "cajas",
  "ventas",
  "productos",
  "categorias",
  "users",
  "negocios",
];

async function clean() {
  try {
    await sequelize.authenticate();
    console.log("Conectado a la base de datos");

    await sequelize.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const tabla of tablas) {
      await sequelize.query(`DROP TABLE IF EXISTS \`${tabla}\``);
      console.log(`DROP ${tabla}`);
    }
    await sequelize.query("SET FOREIGN_KEY_CHECKS = 1");

    console.log("Base de datos limpia");
    process.exit(0);
  } catch (err) {
    await sequelize.query("SET FOREIGN_KEY_CHECKS = 1").catch(() => {});
    console.error("Error:", err.message);
    process.exit(1);
  }
}

clean();
