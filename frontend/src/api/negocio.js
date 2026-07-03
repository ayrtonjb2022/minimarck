import apiClient from "./client";

export const negocioAPI = {
  obtener: () => apiClient.get("/negocio"),
  actualizar: (data) => apiClient.put("/negocio", data),
};
