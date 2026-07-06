import { io } from "socket.io-client";

const SOCKET_URL = import.meta.env.VITE_API_URL
  ? import.meta.env.VITE_API_URL.replace("/api", "")
  : "http://localhost:3000";

let socket = null;

export const connectSocket = (negocioId, role = "pos") => {
  if (socket?.connected) {
    // Ya conectado al mismo negocio?
    if (socket.negocioId === negocioId) return socket;
    socket.disconnect();
    socket = null;
  }

  socket = io(SOCKET_URL, { transports: ["websocket", "polling"] });
  socket.negocioId = negocioId;

  socket.on("connect", () => {
    console.log(`Socket conectado como ${role}`);
    socket.emit("join-room", { role, negocioId });
  });

  return socket;
};

export const getSocket = () => socket;

export const disconnectSocket = () => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
};
