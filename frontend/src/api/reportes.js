import apiClient from "./client";

export const reportesAPI = {
  ventas: (params) => apiClient.get("/reportes/ventas", { params }),
  productosMasVendidos: (params) => apiClient.get("/reportes/productos-mas-vendidos", { params }),
  caja: (cajaId) => apiClient.get(`/reportes/caja/${cajaId}`),
  estadoResultados: (params) => apiClient.get("/reportes/estado-resultados", { params }),
};
