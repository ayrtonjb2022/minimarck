require("dotenv").config();
const { Sequelize } = require("sequelize");
const seq = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, { host: process.env.DB_HOST, dialect: "mysql", logging: false });

(async () => {
  await seq.authenticate();
  const [tables] = await seq.query(
    "SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
    { replacements: [process.env.DB_NAME] }
  );
  let total = 0;
  const toTruncate = [];
  for (const t of tables) {
    const rows = parseInt(t.TABLE_ROWS || 0, 10);
    if (rows > 0) { total += rows; toTruncate.push(t.TABLE_NAME); }
    process.stdout.write("  " + (rows > 0 ? "\u26A0" : "\u2714") + " " + t.TABLE_NAME + ": " + rows + " filas\n");
  }
  if (total > 0) {
    console.log("\n\u26A0 Quedan " + total + " filas. Vaciando de nuevo...");
    await seq.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const t of toTruncate) {
      await seq.query("TRUNCATE TABLE `" + t + "`");
    }
    await seq.query("SET FOREIGN_KEY_CHECKS = 1");
    console.log("\u2705 Vaciado completo");
  } else {
    console.log("\n\u2705 Todo limpio, 0 filas en total");
  }
  await seq.close();
})();
