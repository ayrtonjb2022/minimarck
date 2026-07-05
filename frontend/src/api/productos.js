import apiClient from "./client";

export const productosAPI = {
  listar: (params) => apiClient.get("/productos", { params }),
  obtener: (id) => apiClient.get(`/productos/${id}`),
  buscarPorCodigo: (codigo) => apiClient.get(`/productos/codigo/${codigo}`),
  crear: (data) => apiClient.post("/productos", data),
  actualizar: (id, data) => apiClient.put(`/productos/${id}`, data),
  eliminar: (id) => apiClient.delete(`/productos/${id}`),
};
