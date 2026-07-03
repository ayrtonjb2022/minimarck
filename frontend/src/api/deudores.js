import apiClient from "./client";

export const deudoresAPI = {
  listar: (params) => apiClient.get("/deudores", { params }),
  obtener: (id) => apiClient.get(`/deudores/${id}`),
  crear: (data) => apiClient.post("/deudores", data),
  actualizar: (id, data) => apiClient.put(`/deudores/${id}`, data),
  eliminar: (id) => apiClient.delete(`/deudores/${id}`),
  registrarPago: (id, data) => apiClient.post(`/deudores/${id}/pagos`, data),
  pagos: (id) => apiClient.get(`/deudores/${id}/pagos`),
};
