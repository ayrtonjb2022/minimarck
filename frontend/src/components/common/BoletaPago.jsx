import React, { useRef } from "react";
import { formatCurrency, formatDate } from "../../utils/formatters";

const BoletaPago = ({ deudor, pagos, onClose }) => {
  const printRef = useRef(null);

  const handlePrint = () => {
    const contenido = printRef.current;
    if (!contenido) return;

    const ventana = window.open("", "_blank");
    if (!ventana) return;

    ventana.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Boleta de Pago - ${deudor.nombre}</title>
        <style>
          @page { margin: 15mm; size: auto; }
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: 'Courier New', Courier, monospace;
            font-size: 12px;
            color: #1e293b;
            padding: 20px;
            max-width: 320px;
            margin: 0 auto;
          }
          h1 { font-size: 16px; text-align: center; margin-bottom: 4px; text-transform: uppercase; }
          .subtitle { text-align: center; font-size: 11px; color: #64748b; margin-bottom: 16px; }
          .divider { border-top: 1px dashed #94a3b8; margin: 12px 0; }
          .info-row { display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 4px; }
          .info-row .label { color: #64748b; }
          .info-row .value { font-weight: 600; text-align: right; }
          table { width: 100%; border-collapse: collapse; font-size: 11px; }
          th { text-align: left; padding: 6px 4px; border-bottom: 1px solid #e2e8f0; font-size: 10px; text-transform: uppercase; color: #64748b; }
          td { padding: 6px 4px; border-bottom: 1px solid #f1f5f9; }
          .total-row td { font-weight: 700; padding-top: 8px; border-top: 2px solid #1e293b; border-bottom: none; }
          .estado-pagado { text-align: center; color: #16a34a; font-weight: 700; font-size: 14px; margin: 12px 0; padding: 8px; border: 2px solid #16a34a; border-radius: 4px; }
          .footer { text-align: center; font-size: 10px; color: #94a3b8; margin-top: 16px; }
          .notas { font-size: 10px; color: #475569; white-space: pre-wrap; line-height: 1.5; margin-top: 8px; padding: 8px; background: #f8fafc; border-radius: 4px; }
          .notas-title { font-size: 10px; font-weight: 600; color: #64748b; margin-top: 8px; }
        </style>
      </head>
      <body>
        ${contenido.innerHTML}
      </body>
      </html>
    `);

    ventana.document.close();
    ventana.focus();
    setTimeout(() => { ventana.print(); }, 300);
  };

  const totalPagado = pagos.reduce((s, p) => s + parseFloat(p.monto || 0), 0);

  return (
    <div>
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginBottom: 16 }}>
        <button onClick={handlePrint} className="btn-primary">
          <i className="fa-solid fa-print"></i> Imprimir Boleta
        </button>
        <button onClick={onClose} className="btn-secondary">
          Cerrar
        </button>
      </div>

      <div
        ref={printRef}
        style={{
          background: "#fff",
          color: "#1e293b",
          fontFamily: "'Courier New', Courier, monospace",
          fontSize: 12,
          padding: 24,
          borderRadius: 8,
          maxWidth: 360,
          margin: "0 auto",
        }}
      >
        <h1 style={{ fontSize: 16, textAlign: "center", marginBottom: 2, textTransform: "uppercase" }}>
          MiniMarck2
        </h1>
        <p style={{ textAlign: "center", fontSize: 11, color: "#64748b", marginBottom: 4 }}>
          Boleta de Pago
        </p>
        <p style={{ textAlign: "center", fontSize: 10, color: "#94a3b8", marginBottom: 16 }}>
          {new Date().toLocaleDateString()} · {new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </p>

        <div style={{ borderTop: "1px dashed #94a3b8", marginBottom: 12 }} />

        <div className="info-row" style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
          <span style={{ color: "#64748b" }}>Cliente:</span>
          <span style={{ fontWeight: 600 }}>{deudor.nombre}</span>
        </div>
        {deudor.documento && (
          <div className="info-row" style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
            <span style={{ color: "#64748b" }}>Documento:</span>
            <span style={{ fontWeight: 600 }}>{deudor.documento}</span>
          </div>
        )}
        {deudor.direccion && (
          <div className="info-row" style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
            <span style={{ color: "#64748b" }}>Dirección:</span>
            <span style={{ fontWeight: 600 }}>{deudor.direccion}</span>
          </div>
        )}

        <div style={{ borderTop: "1px dashed #94a3b8", margin: "12px 0" }} />

        <div style={{ textAlign: "center", color: "#16a34a", fontWeight: 700, fontSize: 14, margin: "12px 0", padding: 8, border: "2px solid #16a34a", borderRadius: 4 }}>
          ✓ DEUDA PAGADA
        </div>

        <div className="info-row" style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
          <span style={{ color: "#64748b" }}>Deuda Total Histórica:</span>
          <span style={{ fontWeight: 600 }}>{formatCurrency(deudor.deudaTotal || 0)}</span>
        </div>
        <div className="info-row" style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
          <span style={{ color: "#64748b" }}>Total Pagado:</span>
          <span style={{ fontWeight: 600, color: "#16a34a" }}>{formatCurrency(totalPagado)}</span>
        </div>
        <div className="info-row" style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
          <span style={{ color: "#64748b" }}>Saldo Pendiente:</span>
          <span style={{ fontWeight: 700, color: "#16a34a" }}>$0.00</span>
        </div>

        {pagos.length > 0 && (
          <>
            <div style={{ borderTop: "1px dashed #94a3b8", margin: "12px 0" }} />
            <p style={{ fontSize: 10, fontWeight: 600, color: "#64748b", marginBottom: 4 }}>HISTORIAL DE PAGOS</p>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "4px", borderBottom: "1px solid #e2e8f0", fontSize: 10, color: "#64748b" }}>Fecha</th>
                  <th style={{ textAlign: "right", padding: "4px", borderBottom: "1px solid #e2e8f0", fontSize: 10, color: "#64748b" }}>Monto</th>
                  <th style={{ textAlign: "left", padding: "4px", borderBottom: "1px solid #e2e8f0", fontSize: 10, color: "#64748b" }}>Método</th>
                </tr>
              </thead>
              <tbody>
                {pagos.map((p, i) => (
                  <tr key={i}>
                    <td style={{ padding: "4px", borderBottom: "1px solid #f1f5f9" }}>{formatDate(p.fecha || p.createdAt)}</td>
                    <td style={{ padding: "4px", borderBottom: "1px solid #f1f5f9", textAlign: "right" }}>{formatCurrency(p.monto)}</td>
                    <td style={{ padding: "4px", borderBottom: "1px solid #f1f5f9" }}>{p.metodoPago || "-"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td style={{ padding: "6px 4px", borderTop: "2px solid #1e293b", fontWeight: 700 }}>
                    Total Pagado
                  </td>
                  <td style={{ padding: "6px 4px", borderTop: "2px solid #1e293b", fontWeight: 700, textAlign: "right", color: "#16a34a" }}>
                    {formatCurrency(totalPagado)}
                  </td>
                  <td style={{ padding: "6px 4px", borderTop: "2px solid #1e293b" }}></td>
                </tr>
              </tfoot>
            </table>
          </>
        )}

        {deudor.notas && (
          <>
            <div style={{ borderTop: "1px dashed #94a3b8", margin: "12px 0" }} />
            <p style={{ fontSize: 10, fontWeight: 600, color: "#64748b", marginBottom: 4 }}>DETALLE DE COMPRAS</p>
            <div style={{ fontSize: 10, color: "#475569", whiteSpace: "pre-wrap", lineHeight: 1.5, background: "#f8fafc", padding: 8, borderRadius: 4 }}>
              {deudor.notas}
            </div>
          </>
        )}

        <div style={{ borderTop: "1px dashed #94a3b8", margin: "12px 0" }} />
        <p style={{ textAlign: "center", fontSize: 10, color: "#94a3b8" }}>
          MiniMarck2 · Documento de Pago · No válido como factura
        </p>
      </div>
    </div>
  );
};

export default BoletaPago;
