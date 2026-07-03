import apiClient from "./client";

export const ventasAPI = {
  listar: (params) => apiClient.get("/ventas", { params }),
  obtener: (id) => apiClient.get(`/ventas/${id}`),
  crear: (data) => apiClient.post("/ventas", data),
};
