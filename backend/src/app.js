require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");
const sequelize = require("./config/database");
const errorHandler = require("./middlewares/errorHandler");

const app = express();
const PORT = process.env.PORT || 3000;

// ========== MIDDLEWARES GLOBALES ==========

// Seguridad
app.use(helmet());

// CORS
const corsRaw = process.env.CORS_ORIGIN;

// Si CORS_ORIGIN=* o no está definido → permitir cualquier origen (dev)
// Si tiene una lista → permitir solo esos orígenes (producción)
const corsOrigin = corsRaw && corsRaw !== "*"
  ? corsRaw.split(",").map((s) => s.trim())
  : true; // true = refleja cualquier origin (compatible con credentials:true)

app.use(cors({
  origin: corsOrigin,
  credentials: true,
}));

// Crear servidor HTTP para socket.io
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOrigin, credentials: true },
});
const setupSocket = require("./socket");
setupSocket(io);

// Rate limiting (configurable via env, default 2000/15min)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX || "2000"),
  message: "Demasiadas peticiones desde esta IP, por favor intente más tarde",
});
app.use("/api", limiter);

// Logging
app.use(morgan("combined"));

// Parseo de JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ========== RUTAS ==========

// Ruta de prueba
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "API funcionando correctamente",
    timestamp: new Date().toISOString(),
  });
});

// Rutas de la API
app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/categorias", require("./routes/categoria.routes"));
app.use("/api/productos", require("./routes/producto.routes"));
app.use("/api/ventas", require("./routes/venta.routes"));
app.use("/api/cajas", require("./routes/caja.routes"));
app.use("/api/movimientos", require("./routes/movimiento.routes"));
app.use("/api/deudores", require("./routes/deudor.routes"));
app.use("/api/dashboard", require("./routes/dashboard.routes"));
app.use("/api/reportes", require("./routes/reporte.routes"));

app.use("/api/suscripciones", require("./routes/suscripcion.routes"));
app.use("/api/proveedores", require("./routes/proveedor.routes"));
app.use("/api/compras", require("./routes/compra.routes"));
app.use("/api/clientes", require("./routes/cliente.routes"));
app.use("/api/negocio", require("./routes/negocio.routes"));
app.use("/api/notificaciones", require("./routes/notificacion.routes"));

// ========== MANEJO DE ERRORES ==========

app.use(errorHandler);

// Middleware para rutas no encontradas (404)
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Ruta no encontrada",
  });
});

// Middleware de errores global (debe ir al final)
app.use((err, req, res, next) => {
  console.error("Error global:", err);
  res.status(500).json({
    success: false,
    message: "Error interno del servidor",
    error: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

// ========== INICIO DEL SERVIDOR ==========

const startServer = async () => {
  try {
    await sequelize.authenticate();
    console.log("✅ Conexión a MySQL establecida correctamente.");

    // Configurar relaciones circulares (siempre, para que las asociaciones estén disponibles)
    const setupCircularRelations = require("./models/relations");
    setupCircularRelations();
    console.log("✅ Relaciones circulares configuradas");

    // SOLO sincronizar si DB_FORCE_SYNC es true y estamos en desarrollo
    if (
      process.env.DB_FORCE_SYNC === "true" &&
      process.env.NODE_ENV === "development"
    ) {
      console.log("⚠️  ATENCIÓN: Se borrarán y recrearán todas las tablas");
      await sequelize.sync({ force: true });
      console.log("✅ Base de datos sincronizada (force: true)");

    } else {
      // Sin alter para evitar acumulación de índices (MySQL max 64 keys)
      console.log("🔄 Verificando modelos existentes...");
      await sequelize.sync();
      console.log("✅ Modelos sincronizados correctamente");
    }

    // Verificar si hay usuarios
    const { User } = require("./models/index");
    const userCount = await User.count();
    if (userCount === 0) {
      console.log("⚠️  No hay usuarios en la base de datos.");
      console.log("📝 Ejecuta: npm run db:seed para crear datos de prueba");
    } else {
      console.log(`📊 Total de usuarios: ${userCount}`);
    }

    server.listen(PORT, () => {
      console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
      console.log(`📝 Ambiente: ${process.env.NODE_ENV || "development"}`);
      console.log(`🔄 DB_FORCE_SYNC: ${process.env.DB_FORCE_SYNC || "false"}`);
    });
  } catch (error) {
    console.error("❌ Error al iniciar el servidor:", error.message);
    process.exit(1);
  }
};

startServer();
