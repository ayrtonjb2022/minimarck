import apiClient from "./client";

export const contabilidadAPI = {
  // Cuentas contables
  listarCuentas: () => apiClient.get("/contabilidad/cuentas"),
  crearCuenta: (data) => apiClient.post("/contabilidad/cuentas", data),
  actualizarCuenta: (id, data) => apiClient.put(`/contabilidad/cuentas/${id}`, data),
  eliminarCuenta: (id) => apiClient.delete(`/contabilidad/cuentas/${id}`),

  // Asientos contables
  listarAsientos: (params) => apiClient.get("/contabilidad/asientos", { params }),
  crearAsiento: (data) => apiClient.post("/contabilidad/asientos", data),
  obtenerAsiento: (id) => apiClient.get(`/contabilidad/asientos/${id}`),
  eliminarAsiento: (id) => apiClient.delete(`/contabilidad/asientos/${id}`),

  // Deudas
  listarDeudas: (params) => apiClient.get("/contabilidad/deudas", { params }),
  crearDeuda: (data) => apiClient.post("/contabilidad/deudas", data),
  actualizarDeuda: (id, data) => apiClient.put(`/contabilidad/deudas/${id}`, data),
  registrarPagoDeuda: (id, data) => apiClient.post(`/contabilidad/deudas/${id}/pagos`, data),
  listarPagosDeuda: (id) => apiClient.get(`/contabilidad/deudas/${id}/pagos`),

  // Balance y Dashboard
  balance: (params) => apiClient.get("/contabilidad/balance", { params }),
  dashboard: () => apiClient.get("/contabilidad/dashboard"),
};
