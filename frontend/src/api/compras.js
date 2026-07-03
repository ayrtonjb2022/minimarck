import apiClient from "./client";

export const comprasAPI = {
  listar: (params) => apiClient.get("/compras", { params }),
  obtener: (id) => apiClient.get(`/compras/${id}`),
  crear: (data) => apiClient.post("/compras", data),
  actualizar: (id, data) => apiClient.put(`/compras/${id}`, data),
  cancelar: (id) => apiClient.put(`/compras/${id}/cancelar`),
};
