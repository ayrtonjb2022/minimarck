import apiClient from "./client";

export const movimientosAPI = {
  crear: (data) => apiClient.post("/movimientos", data),
  listarPorCaja: (cajaId, params) => apiClient.get(`/movimientos/caja/${cajaId}`, { params }),
  resumen: (cajaId) => apiClient.get(`/movimientos/resumen/${cajaId}`),
};
