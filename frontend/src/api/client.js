import axios from "axios";
import { queueSale } from "../utils/offlineQueue";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000/api";

const apiClient = axios.create({
  baseURL: API_URL,
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
  },
});

apiClient.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem("token");
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  },
);

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      window.location.href = "/login";
    }

    // Offline queue: solo para POST /ventas con errores de red
    const isVentasPost =
      error.config?.method === "post" &&
      error.config?.url?.includes("/ventas");
    const isNetworkError =
      !error.response && (error.code === "ERR_NETWORK" || error.message?.includes("Network Error"));

    if (isVentasPost && isNetworkError) {
      try {
        const body = JSON.parse(error.config.data || "{}");
        queueSale(body);
        // Disparar evento custom para que el POS muestre toast
        window.dispatchEvent(
          new CustomEvent("offline-sale-queued", { detail: body })
        );
      } catch {
        // Si no se pudo parsear el body, no encolar
      }
    }

    return Promise.reject(error);
  },
);

export default apiClient;
