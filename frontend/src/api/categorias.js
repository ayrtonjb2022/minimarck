import apiClient from "./client";

export const categoriasAPI = {
  listar: (params) => apiClient.get("/categorias", { params }),
  obtener: (id) => apiClient.get(`/categorias/${id}`),
  crear: (data) => apiClient.post("/categorias", data),
  actualizar: (id, data) => apiClient.put(`/categorias/${id}`, data),
  eliminar: (id) => apiClient.delete(`/categorias/${id}`),
};
