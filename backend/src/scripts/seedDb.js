const { User, Negocio, Suscripcion } = require("../models/index");
const sequelize = require("../config/database");

const seedDatabase = async () => {
  try {
    await sequelize.authenticate();
    console.log("Conexión a MySQL establecida");

    const [negocio] = await Negocio.findOrCreate({
      where: { nombre: "Tienda Demo" },
      defaults: {
        ruc: "1234567890",
        direccion: "Av. Principal 123",
        telefono: "555-0000",
        tipoComercio: "despensa",
        activo: true,
      },
    });
    console.log(`Negocio: ${negocio.nombre}`);

    const [suscripcion] = await Suscripcion.findOrCreate({
      where: { negocioId: negocio.id },
      defaults: {
        plan: "premium",
        maxUsuarios: 10,
        maxProductos: 1000,
        activa: true,
        negocioId: negocio.id,
      },
    });
    console.log(`Suscripcion: ${suscripcion.plan}`);

    const users = [
      { nombre: "Administrador", email: "admin@empresa.com", password: "Admin123!" },
      { nombre: "Usuario Demo", email: "demo@tienda.com", password: "Demo123!" },
    ];

    for (const data of users) {
      await User.findOrCreate({
        where: { email: data.email },
        defaults: {
          nombre: data.nombre,
          password: data.password,
          rol: "admin",
          activo: true,
          negocioId: negocio.id,
        },
      });
      console.log(`Usuario: ${data.email}`);
    }

    console.log("Datos de prueba cargados exitosamente");
    process.exit(0);
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
};

seedDatabase();
