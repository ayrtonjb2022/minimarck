import apiClient from "./client";

export const authAPI = {
  register: (data) => apiClient.post("/auth/register", data),
  login: (email, password) =>
    apiClient.post("/auth/login", { email, password }),
  me: () => apiClient.get("/auth/me"),
  changePassword: (data) => apiClient.put("/auth/change-password", data),
};
