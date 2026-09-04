import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { dashboardAPI } from "../api/dashboard";
import { reportesAPI } from "../api/reportes";
import Loader from "../components/common/Loader";
import { formatCurrency, formatNumber } from "../utils/formatters";
import { toast } from "react-toastify";

const Dashboard = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [vencimientoData, setVencimientoData] = useState(null);

  // all users have access

  useEffect(() => {
    fetchDashboardData();
    fetchVencimientoData();
  }, []);

  const fetchVencimientoData = async () => {
    try {
      const res = await reportesAPI.vencimiento({ dias: 30 });
      setVencimientoData(res.data.data);
    } catch (error) {
      // Silent — dashboard shouldn't break if vencimiento endpoint fails
      console.error("Error fetching vencimiento data:", error);
    }
  };

  const fetchDashboardData = async () => {
    try {
      setLoading(true);
      const response = await dashboardAPI.stats({ periodo: "month" });
      setStats(response.data.data);
    } catch (error) {
      toast.error("Error al cargar el dashboard");
      console.error(error);
    } finally { setLoading(false); }
  };

  if (loading) return <Loader />;

  const totalVencidos = vencimientoData?.resumen?.totalVencidos ?? 0;
  const totalPorVencer = vencimientoData?.resumen?.totalPorVencer ?? 0;

  const chartData = stats?.ventas?.diarias || [
    { day: "Lun", value: 0 },
    { day: "Mar", value: 0 },
    { day: "Mié", value: 0 },
    { day: "Jue", value: 0 },
    { day: "Vie", value: 0 },
    { day: "Sáb", value: 0 },
    { day: "Dom", value: 0 },
  ];

  const maxVal = Math.max(...chartData.map(d => d.value), 1);

  const topProducts = stats?.productos?.topVendidos || [];

  const dotColors = ["#7e9cd8", "#6a9589", "#c4a57b", "#e46885", "#957fb8"];

  const recentSales = stats?.ventas?.recientes || [];

  return (
    <div>
      {/* Alerta de vencimiento */}
      {(totalVencidos > 0 || totalPorVencer > 0) && (
        <div
          style={{
            background: totalVencidos > 0 ? "#fef2f2" : "#fffbeb",
            border: `1px solid ${totalVencidos > 0 ? "#fca5a5" : "#fde68a"}`,
            borderRadius: 12,
            padding: "14px 18px",
            marginBottom: 20,
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: 14,
            color: totalVencidos > 0 ? "#991b1b" : "#92400e",
            cursor: "pointer",
          }}
          onClick={() => navigate("/reportes", { state: { tab: "vencimiento" } })}
        >
          <i className="fa-solid fa-triangle-exclamation" style={{ fontSize: 18 }}></i>
          <span>
            {totalVencidos > 0 && <><strong>{totalVencidos}</strong> producto(s) vencido(s)</>}
            {totalVencidos > 0 && totalPorVencer > 0 && " · "}
            {totalPorVencer > 0 && <><strong>{totalPorVencer}</strong> producto(s) próximo(s) a vencer</>}
          </span>
          <span style={{ marginLeft: "auto", fontSize: 12, opacity: 0.7 }}>Ver reporte →</span>
        </div>
      )}

      <div className="stats-grid">
        <div className="stat-card">
          <div className="label">
            Ventas del Período
            <i className="fa-solid fa-cash-register"></i>
          </div>
          <div className="value">{formatNumber(stats?.ventas?.total || 0)}</div>
          {/* porcentaje removido — se agregará cuando el backend lo soporte */}
        </div>
        <div className="stat-card">
          <div className="label">
            Ingresos
            <i className="fa-solid fa-hand-holding-dollar"></i>
          </div>
          <div className="value">{formatCurrency(stats?.ventas?.ingresos || 0)}</div>
          {/* porcentaje removido — se agregará cuando el backend lo soporte */}
        </div>
        <div className="stat-card">
          <div className="label">
            Productos
            <i className="fa-solid fa-boxes"></i>
          </div>
          <div className="value">{formatNumber(stats?.productos?.total || 0)}</div>
          {/* porcentaje removido — se agregará cuando el backend lo soporte */}
        </div>
        <div className="stat-card">
          <div className="label">
            Bajo Stock
            <i className="fa-solid fa-triangle-exclamation"></i>
          </div>
          <div className="value">{formatNumber(stats?.productos?.bajoStock || 0)}</div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <h3>Ventas (7 días)</h3>
            <span className="tag">Semanal</span>
          </div>
          <div className="bar-chart">
            {chartData.map((item, idx) => (
              <div className="bar-item" key={idx}>
                <span className="val">{formatCurrency(item.value)}</span>
                <div className="bar" style={{ height: `${Math.round((item.value / maxVal) * 100)}%` }}></div>
                <span className="day">{item.day}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-header">
            <h3>Top Productos</h3>
            <span className="link">Ver todos</span>
          </div>
          {topProducts.length === 0 ? (
            <div style={{ textAlign: "center", padding: 32, color: "#94a3b8", fontSize: 13 }}>Sin datos de productos</div>
          ) : (
            <ul className="product-list">
              {topProducts.map((p, idx) => (
                <li key={idx}>
                  <div className="product-info">
                    <span className="color-dot" style={{ background: dotColors[idx % 5] }}></span>
                    <span className="name">{p.nombre || p.producto?.nombre || `Producto #${p.productoId}`}</span>
                  </div>
                  <span className="qty">{p.totalVendido || p.cantidad || 0}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="table-container">
        <div className="table-header">
          <h3>Ventas Recientes</h3>
        </div>
        <table>
          <thead>
            <tr>
              <th>Folio</th>
              <th>Cliente</th>
              <th>Total</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {recentSales.length === 0 ? (
              <tr><td colSpan={4} style={{ textAlign: "center", padding: 32, color: "#94a3b8", fontSize: 13 }}>Sin ventas recientes</td></tr>
            ) : (
              recentSales.map((sale, idx) => (
                <tr key={idx}>
                  <td>#{sale.folio}</td>
                  <td>{sale.clienteNombre || "-"}</td>
                  <td>{formatCurrency(sale.total)}</td>
                  <td>
                    <span className={`status ${sale.estado === "completada" ? "paid" : "cancelled"}`}>
                      <span className="dot"></span>
                      {sale.estado === "completada" ? "Completada" : "Anulada"}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default Dashboard;
