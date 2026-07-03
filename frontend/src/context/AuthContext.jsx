import React, { createContext, useState, useContext, useEffect } from "react";
import { authAPI } from "../api/auth";
import { toast } from "react-toastify";

const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState(
    localStorage.getItem("token"),
  );

  useEffect(() => {
    if (token) {
      loadUser();
    } else {
      setLoading(false);
    }
  }, [token]);

  const loadUser = async () => {
    try {
      const response = await authAPI.me();
      const userData = response.data?.data;
      setUser(userData);
      localStorage.setItem("user", JSON.stringify(userData));
    } catch (error) {
      console.error("Error loading user:", error);
      if (error.response?.status === 401) {
        logout();
      }
    } finally {
      setLoading(false);
    }
  };

  const login = async (email, password) => {
    try {
      const response = await authAPI.login(email, password);
      const { token: jwt, user: userData } = response.data.data;

      setToken(jwt);
      setUser(userData);

      localStorage.setItem("token", jwt);
      localStorage.setItem("user", JSON.stringify(userData));

      toast.success(`Bienvenido ${userData.nombre}`);
      return { success: true, user: userData };
    } catch (error) {
      const message =
        error.response?.data?.message || "Error al iniciar sesión";
      toast.error(message);
      return { success: false, error: message };
    }
  };

  const logout = () => {
    setUser(null);
    setToken(null);
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    toast.info("Sesión cerrada");
  };

  const value = {
    user,
    loading,
    token,
    login,
    logout,
    isAuthenticated: !!token,
    isAdmin: user?.rol === "admin",
    isSupervisor: user?.rol === "supervisor",
    isVendedor: user?.rol === "vendedor",
    hasRole: (role) => user?.rol === role,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
