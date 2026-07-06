import React, { useState, useEffect } from "react";
import { Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import { NotificacionProvider } from "./context/NotificacionContext";
import ProtectedRoute from "./components/common/ProtectedRoute";
import CajaGuard from "./components/common/CajaGuard";
import Sidebar from "./components/common/Sidebar";
import Navbar from "./components/common/Navbar";
import Loader from "./components/common/Loader";

import Landing from "./pages/Landing";
import Login from "./pages/Login";
import Register from "./pages/Register";
import Dashboard from "./pages/Dashboard";

import Productos from "./pages/Productos";
import Categorias from "./pages/Categorias";
import Ventas from "./pages/Ventas";
import Caja from "./pages/Caja";
import PuntoDeVenta from "./pages/puntoDeVenta";
import Deudores from "./pages/Deudores";
import Proveedores from "./pages/Proveedores";
import Compras from "./pages/Compras";
import Reportes from "./pages/Reportes";
import Configuracion from "./pages/Configuracion";
import NotFound from "./pages/NotFound";
import ScannerSync from "./pages/ScannerSync";

const PAGE_ROUTES = {
  dashboard: "/dashboard", pos: "/pos", productos: "/productos",
  categorias: "/categorias", ventas: "/ventas", caja: "/caja",
  clientes: "/clientes", proveedores: "/proveedores",
  compras: "/compras", reportes: "/reportes",
  configuracion: "/configuracion",
};

const App = () => {
  const { loading, isAuthenticated } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const currentPage = Object.keys(PAGE_ROUTES).find((k) => PAGE_ROUTES[k] === location.pathname) || "dashboard";

  const handleNavigate = (page, state) => {
    const path = PAGE_ROUTES[page] || "/dashboard";
    navigate(path, { state });
    setSidebarOpen(false);
  };

  useEffect(() => {
    const handleResize = () => setSidebarOpen(window.innerWidth >= 992);
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    const pages = Object.keys(PAGE_ROUTES);
    const handler = (e) => {
      if (e.ctrlKey && e.key >= "1" && e.key <= "9") {
        const idx = parseInt(e.key, 10) - 1;
        if (idx < pages.length) handleNavigate(pages[idx]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (loading) return <Loader fullScreen />;

  const isAuthPage = location.pathname === "/login";
  if (isAuthPage) return <Login />;

  const AppLayout = ({ children }) => (
    <div className="app-layout">
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} currentPage={currentPage} onNavigate={handleNavigate} />
      <main className="main">
        <button className="sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)}>
          <i className="fa-solid fa-bars"></i>
        </button>
        <Navbar currentPage={currentPage} onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} onNavigate={handleNavigate} />
        {children}
        <div style={{ textAlign: "center", fontSize: 13, color: "#6a6a6b", paddingTop: 20, marginTop: 20, borderTop: "1px solid #363432" }}>
          MiniMarck2 v1.0 · © 2026 Todos los derechos reservados
        </div>
      </main>
    </div>
  );

  const FullLayout = ({ children }) => (
    <div className="app-layout">
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} currentPage={currentPage} onNavigate={handleNavigate} />
      <main className="main main--pos">
        <button className="sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)}>
          <i className="fa-solid fa-bars"></i>
        </button>
        {children}
      </main>
    </div>
  );

  return (
    <NotificacionProvider>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/" element={isAuthenticated ? <Navigate to="/dashboard" replace /> : <Landing />} />
      <Route element={<ProtectedRoute />}>
        <Route path="/dashboard" element={<AppLayout><Dashboard /></AppLayout>} />

        <Route path="/categorias" element={<AppLayout><Categorias /></AppLayout>} />
        <Route path="/productos" element={<AppLayout><Productos /></AppLayout>} />
        <Route path="/proveedores" element={<AppLayout><Proveedores /></AppLayout>} />
        <Route path="/compras" element={<AppLayout><Compras /></AppLayout>} />
        <Route path="/ventas" element={<AppLayout><Ventas /></AppLayout>} />
        <Route path="/caja" element={<AppLayout><Caja /></AppLayout>} />
        <Route path="/clientes" element={<AppLayout><Deudores /></AppLayout>} />
        <Route path="/reportes" element={<AppLayout><Reportes /></AppLayout>} />
        <Route path="/configuracion" element={<AppLayout><Configuracion /></AppLayout>} />
        <Route path="/pos" element={<FullLayout><CajaGuard><PuntoDeVenta /></CajaGuard></FullLayout>} />
      </Route>
      <Route path="/scanner/:roomId" element={<ScannerSync />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
    </NotificacionProvider>
  );
};

export default App;
