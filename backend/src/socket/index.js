const { Producto, Categoria } = require("../models");

const setupSocket = (io) => {
  io.on("connection", (socket) => {
    console.log(`Socket conectado: ${socket.id}`);

    socket.on("join-room", ({ role, negocioId }) => {
      if (!negocioId) return;
      socket.negocioId = negocioId;
      socket.role = role; // "pos" o "scanner"
      const room = `negocio:${negocioId}`;
      socket.join(room);
      console.log(`${role} ${socket.id} unido a ${room}`);
    });

    socket.on("scan-barcode", async ({ codigo, negocioId }) => {
      try {
        if (!codigo || !negocioId) return;
        const room = `negocio:${negocioId}`;

        const producto = await Producto.findOne({
          where: { codigo, negocioId, activo: true },
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
