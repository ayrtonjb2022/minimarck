import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 min antes de considerar datos viejos
      gcTime: 30 * 60 * 1000,   // 30 min en caché
      retry: 2,                  // reintentar 2 veces si falla
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10000), // backoff exponencial
      refetchOnWindowFocus: true,
    },
    mutations: {
      retry: 2,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10000),
    },
  },
});
