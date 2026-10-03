import React, { useRef } from "react";
import { formatDate } from "../../utils/formatters";
import { formatCents } from "../../../../shared/money.js";

/**
 * Boleta de Pago — a receipt for the money a debtor has handed over.
 *
 * WHAT WAS WRONG WITH THE FIRST VERSION OF THIS FILE, which is worth writing down because all
 * three defects pointed the same way: the receipt always said the debt was settled.
 *
 *   1. `Saldo Pendiente` was the literal string `$0.00`. Not a fallback, not a default — a
 *      hardcoded zero, on a document whose whole purpose is to state a balance.
 *   2. `✓ DEUDA PAGADA` was rendered unconditionally, inside a green bordered box built to be
 *      impossible to miss. A customer who owed the shop $40.000 was handed a receipt announcing
 *      that they had paid it in full.
 *   3. The total paid was `pagos.reduce((s, p) => s + parseFloat(p.monto || 0), 0)` — pesos, as
 *      floats, added in a loop. And it read `p.monto`, a field the desktop contract does not
 *      have (it is `montoCentavos`), so with real rows the sum was `0`.
 *
 * THE BALANCE IS NOT COMPUTED HERE. `deudor.deudaPendienteCentavos` comes from
 * `v_clientes_deudores`, which is the single copy of the debt invariant: total credit sales,
 * minus recorded payments, clamped at zero. This component has no arithmetic in the balance and
 * must not grow any — a receipt that derives its own figure from the rows above it can disagree
 * with the ledger, and then the two documents are both defensible and only one is true.
 *
 * `totalPagado` is kept, because the history is worth showing next to the figure, and it is
 * summed in integer centavos this time. It is a reading of the history, not the balance.
 */
const BoletaPago = ({ deudor, pagos = [], onClose }) => {
  const printRef = useRef(null);

  // The view's number, not a derivation. `deudaTotal`/`deudaTotalCentavos` are both read here
  // because the component was written against the web's field names; the desktop contract names
  // them in centavos, and a `deudaTotal` that does not exist silently formats as $0,00.
  const deudaTotalCentavos = deudor?.deudaTotalCentavos ?? deudor?.deudaTotal ?? 0;
  const saldoPendienteCentavos = deudor?.deudaPendienteCentavos ?? 0;
  const saldada = saldoPendienteCentavos === 0;

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

  // Integer centavos, added in a loop. `parseFloat` over pesos is what the first version did,
  // and it drifted: three payments of $33,33 do not sum to $99,99 in binary floating point, so
  // the printed total could be a cent away from the sum of the printed rows, on a receipt whose
  // entire purpose is to be checked against those rows.
  const totalPagadoCentavos = pagos.reduce((s, p) => s + (p.montoCentavos ?? 0), 0);

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

        {/* CONDITIONAL, and that is the whole fix. This box used to render for every debtor,
            including the ones who still owed money — the most confident-looking line on the
            receipt, stating the opposite of the truth. The two states are now visually distinct
            so the receipt cannot be skimmed into meaning the wrong thing. */}
        {saldada ? (
          <div data-testid="boleta-saldada" style={{ textAlign: "center", color: "#16a34a", fontWeight: 700, fontSize: 14, margin: "12px 0", padding: 8, border: "2px solid #16a34a", borderRadius: 4 }}>
            ✓ DEUDA PAGADA
          </div>
        ) : (
          <div data-testid="boleta-saldo-pendiente" style={{ textAlign: "center", color: "#b45309", fontWeight: 700, fontSize: 14, margin: "12px 0", padding: 8, border: "2px solid #b45309", borderRadius: 4 }}>
            ⚠ DEUDA PENDIENTE
          </div>
        )}

        <div className="info-row" style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
          <span style={{ color: "#64748b" }}>Deuda Total Histórica:</span>
          <span style={{ fontWeight: 600 }}>{formatCents(deudaTotalCentavos)}</span>
        </div>
        <div className="info-row" style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
          <span style={{ color: "#64748b" }}>Total Pagado:</span>
          <span style={{ fontWeight: 600, color: "#16a34a" }}>{formatCents(totalPagadoCentavos)}</span>
        </div>
        <div className="info-row" style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
          <span style={{ color: "#64748b" }}>Saldo Pendiente:</span>
          <span
            data-testid="boleta-saldo"
            style={{ fontWeight: 700, color: saldada ? "#16a34a" : "#b45309" }}
          >
            {formatCents(saldoPendienteCentavos)}
          </span>
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
                    <td style={{ padding: "4px", borderBottom: "1px solid #f1f5f9", textAlign: "right" }}>{formatCents(p.montoCentavos ?? 0)}</td>
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
                    {formatCents(totalPagadoCentavos)}
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
