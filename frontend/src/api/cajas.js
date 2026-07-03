import apiClient from "./client";

export const cajasAPI = {
  listar: (params) => apiClient.get("/cajas", { params }),
  apertura: (data) => apiClient.post("/cajas/apertura", data),
  cierre: (id) => apiClient.put(`/cajas/cierre/${id}`),
  activa: () => apiClient.get("/cajas/activa"),
  obtener: (id) => apiClient.get(`/cajas/${id}`),
  saldoGeneral: () => apiClient.get("/cajas/saldo-general"),
};
