import apiClient from "./client";

export const proveedoresAPI = {
  listar: (params) => apiClient.get("/proveedores", { params }),
  obtener: (id) => apiClient.get(`/proveedores/${id}`),
  crear: (data) => apiClient.post("/proveedores", data),
  actualizar: (id, data) => apiClient.put(`/proveedores/${id}`, data),
  eliminar: (id) => apiClient.delete(`/proveedores/${id}`),
};
