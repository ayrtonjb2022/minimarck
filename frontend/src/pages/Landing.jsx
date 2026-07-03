import React from "react";
import { Link } from "react-router-dom";

const features = [
  {
    icon: "fa-solid fa-cash-register",
    title: "Punto de Venta",
    desc: "Vendé rápido con búsqueda inteligente, carrito en vivo y múltiples formas de pago.",
  },
  {
    icon: "fa-solid fa-boxes",
    title: "Inventario",
    desc: "Control de stock, categorías, proveedores y alertas de productos bajos.",
  },
  {
    icon: "fa-solid fa-shopping-cart",
    title: "Ventas y Compras",
    desc: "Historial completo de transacciones, compras a proveedores y gestión de deudores.",
  },
  {
    icon: "fa-solid fa-wallet",
    title: "Caja Diaria",
    desc: "Apertura y cierre de caja con movimientos controlados y saldo en tiempo real.",
  },
  {
    icon: "fa-solid fa-chart-line",
    title: "Reportes",
    desc: "Dashboard, productos más vendidos, estado de resultados y exportación a Excel/PDF.",
  },
  {
    icon: "fa-solid fa-users",
    title: "Multi-usuario",
    desc: "Roles admin, supervisor y vendedor con permisos granulares por negocio.",
  },
];

const Landing = () => {
  return (
    <div style={{ minHeight: "100vh", background: "#0f0d0c" }}>

      {/* ── NAV ── */}
      <nav style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "16px 32px", borderBottom: "1px solid #1d1c19",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <i className="fa-solid fa-store" style={{ fontSize: 22, color: "#7e9cd8" }}></i>
          <span style={{ fontWeight: 800, fontSize: 18, color: "#c5c9c5" }}>MiniMarck2</span>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <Link to="/login" className="btn-primary" style={{ padding: "8px 20px", fontSize: 13, textDecoration: "none" }}>
            <i className="fa-solid fa-right-to-bracket"></i> Ingresar
          </Link>
          <Link to="/register" className="btn-secondary" style={{ padding: "8px 20px", fontSize: 13, textDecoration: "none" }}>
            <i className="fa-solid fa-store"></i> Crear negocio
          </Link>
        </div>
      </nav>

      {/* ── HERO ── */}
      <section style={{
        display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center",
        padding: "80px 24px 64px", position: "relative", overflow: "hidden",
      }}>
        {/* Fondo degradado */}
        <div style={{
          position: "absolute", top: "-40%", left: "50%", transform: "translateX(-50%)",
          width: 600, height: 600, borderRadius: "50%",
          background: "radial-gradient(circle, rgba(126,156,216,0.08) 0%, transparent 70%)",
          pointerEvents: "none",
        }} />

        <div style={{ position: "relative", maxWidth: 640 }}>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            background: "rgba(126,156,216,0.1)", border: "1px solid rgba(126,156,216,0.2)",
            borderRadius: 30, padding: "6px 16px", fontSize: 12, color: "#7e9cd8",
            fontWeight: 600, marginBottom: 24,
          }}>
            <i className="fa-solid fa-circle" style={{ fontSize: 8, color: "#7e9cd8" }}></i>
            Sistema POS / CRM para tu negocio
          </div>

          <h1 style={{
            fontSize: 44, fontWeight: 900, color: "#c5c9c5", lineHeight: 1.1,
            marginBottom: 16, letterSpacing: "-0.5px",
          }}>
            Gestioná tu negocio<br />
            <span style={{ background: "linear-gradient(135deg, #7e9cd8, #b4befe)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              de forma simple
            </span>
          </h1>

          <p style={{ color: "#6a6a6b", fontSize: 16, lineHeight: 1.6, marginBottom: 36, maxWidth: 480, margin: "0 auto 36px" }}>
            Facturación, inventario, caja, reportes y control de deudores en un solo lugar.
            Sin vueltas, sin sistemas complicados.
          </p>

          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <Link to="/register" className="btn-primary" style={{
              padding: "14px 32px", fontSize: 15, textDecoration: "none",
              background: "#7e9cd8", color: "#111",
            }}>
              <i className="fa-solid fa-store"></i> Crear mi negocio gratis
            </Link>
            <Link to="/login" className="btn-secondary" style={{
              padding: "14px 28px", fontSize: 15, textDecoration: "none",
            }}>
              Ya tengo cuenta
            </Link>
          </div>

          <p style={{ color: "#4a4a4a", fontSize: 12, marginTop: 16 }}>
            Sin tarjeta de crédito · Configuración en 2 minutos
          </p>
        </div>
      </section>

      {/* ── FEATURES ── */}
      <section style={{
        padding: "48px 24px 64px", maxWidth: 960, margin: "0 auto",
      }}>
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <h2 style={{ fontSize: 28, fontWeight: 700, color: "#c5c9c5", marginBottom: 8 }}>
            Todo lo que necesitás para vender
          </h2>
          <p style={{ color: "#6a6a6b", fontSize: 14 }}>
            Una solución completa para pequeños y medianos comercios
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 }}>
          {features.map((f, i) => (
            <div key={i} style={{
              background: "#1d1c19", borderRadius: 16, padding: "24px 22px",
              border: "1px solid #2a2826", transition: "all 0.2s",
            }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#7e9cd8"; e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 8px 24px rgba(0,0,0,0.3)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#2a2826"; e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = "none"; }}
            >
              <i className={f.icon} style={{ fontSize: 28, color: "#7e9cd8", marginBottom: 14 }}></i>
              <h3 style={{ fontSize: 16, fontWeight: 600, color: "#c5c9c5", marginBottom: 6 }}>{f.title}</h3>
              <p style={{ color: "#6a6a6b", fontSize: 13, lineHeight: 1.5 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── CTA FINAL ── */}
      <section style={{
        textAlign: "center", padding: "48px 24px 56px",
        borderTop: "1px solid #1d1c19",
      }}>
        <h2 style={{ fontSize: 24, fontWeight: 700, color: "#c5c9c5", marginBottom: 12 }}>
          ¿Listo para empezar?
        </h2>
        <p style={{ color: "#6a6a6b", fontSize: 14, marginBottom: 24 }}>
          Creá tu cuenta en segundos y empezá a facturar hoy mismo.
        </p>
        <Link to="/register" className="btn-primary" style={{
          padding: "12px 32px", fontSize: 15, textDecoration: "none",
        }}>
          <i className="fa-solid fa-store"></i> Crear negocio gratis
        </Link>
      </section>

      {/* ── FOOTER ── */}
      <footer style={{
        textAlign: "center", padding: "20px 24px", fontSize: 12,
        color: "#4a4a4a", borderTop: "1px solid #1d1c19",
      }}>
        MiniMarck2 v1.0 · © {new Date().getFullYear()} Todos los derechos reservados
      </footer>
    </div>
  );
};

export default Landing;
