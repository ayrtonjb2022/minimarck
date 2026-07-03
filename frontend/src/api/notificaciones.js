import apiClient from "./client";

export const notificacionesAPI = {
  listar: () => apiClient.get("/notificaciones"),
};
