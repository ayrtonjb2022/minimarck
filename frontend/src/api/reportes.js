import apiClient from "./client";

export const reportesAPI = {
  ventas: (params) => apiClient.get("/reportes/ventas", { params }),
  productosMasVendidos: (params) => apiClient.get("/reportes/productos-mas-vendidos", { params }),
  caja: (cajaId) => apiClient.get(`/reportes/caja/${cajaId}`),
  estadoResultados: (params) => apiClient.get("/reportes/estado-resultados", { params }),
  gerencial: (params) => apiClient.get("/reportes/gerencial", { params }),
  analisisNegocio: (params) => apiClient.get("/reportes/analisis-negocio", { params }),
  stock: (params) => apiClient.get("/reportes/stock", { params }),
  gastos: (params) => apiClient.get("/reportes/gastos", { params }),
  compras: (params) => apiClient.get("/reportes/compras", { params }),
  deudores: (params) => apiClient.get("/reportes/deudores", { params }),
};
