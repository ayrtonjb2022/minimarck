import apiClient from "./client";

export const usuariosAPI = {
  listar: (params) => apiClient.get("/users", { params }),
};
