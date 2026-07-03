import apiClient from "./client";

export const dashboardAPI = {
  stats: (params) => apiClient.get("/dashboard/stats", { params }),
};
