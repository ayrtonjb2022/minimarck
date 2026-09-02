const { Producto, Categoria } = require("../models");
const { verifyToken } = require("../utils/generateToken");

const setupSocket = (io) => {
  io.on("connection", (socket) => {
    // Autenticación: se valida JWT del handshake y se ignora el negocioId del cliente — siempre se usa el del token.
    const token = socket.handshake.auth.token || socket.handshake.query.token;
    if (!token) {
      console.log(`Socket rechazado: sin token`);
      return socket.disconnect();
    }

    const decoded = verifyToken(token);
    if (!decoded || !decoded.negocioId) {
      console.log(`Socket rechazado: token inválido`);
      return socket.disconnect();
    }

    const negocioIdFromToken = decoded.negocioId;
    console.log(`Socket conectado: ${socket.id} (negocio: ${negocioIdFromToken})`);

    socket.on("join-room", ({ role }) => {
      // Ignorar el negocioId del cliente — siempre usar el del token
      const room = `negocio:${negocioIdFromToken}`;
      socket.join(room);
      socket.negocioId = negocioIdFromToken;
      socket.role = role; // "pos" o "scanner"
      console.log(`${role} ${socket.id} unido a ${room}`);
    });

    socket.on("scan-barcode", async ({ codigo }) => {
      try {
        if (!codigo) return;
        const room = `negocio:${negocioIdFromToken}`;

        const producto = await Producto.findOne({
          where: { codigo, negocioId: negocioIdFromToken, activo: true },
          include: [
            {
              model: Categoria,
              as: "categoria",
              attributes: ["id", "nombre"],
            },
          ],
        });

        if (producto) {
          // Enviar al POS (todos los POS en la sala)
          io.to(room).emit("add-to-cart", {
            product: producto.toJSON(),
          });
          // Responder al scanner
          socket.emit("scan-result", {
            success: true,
            product: producto.toJSON(),
            message: "Producto agregado al carrito",
          });
        } else {
          socket.emit("scan-result", {
            success: false,
            message: "Producto no encontrado",
          });
        }
      } catch (err) {
        console.error("Error en scan-barcode:", err);
        socket.emit("scan-result", {
          success: false,
          message: "Error al buscar producto",
        });
      }
    });

    socket.on("disconnect", () => {
      console.log(`Socket desconectado: ${socket.id}`);
    });
  });
};

module.exports = setupSocket;
