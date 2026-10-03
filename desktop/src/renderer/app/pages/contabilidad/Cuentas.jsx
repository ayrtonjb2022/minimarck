import React from "react";
import { formatCentavos } from "../../utils/formatters";

/**
 * El plan de cuentas — every account, what moved through it, and whether the ledger balances.
 *
 * ── WHY THE SIGN IS NOT COMPUTED HERE ─────────────────────────────────────────────────────────
 *
 * `saldoCentavos` arrives already signed for the account's TYPE. An asset grows on the debit side
 * and a liability grows on the credit side, so the same `SUM(debe) - SUM(haber)` is the wrong answer
 * for half the chart — a loan of $100.000 shown as minus $100.000 is a balance sheet wrong by twice
 * the amount. The rule lives once, in `metricas.js#saldoDeTipo`, and main reads through it. This
 * screen formats and groups; it does not decide what a balance means.
 *
 * ── WHY `cuadra` IS SHOWN AND NOT ASSUMED ────────────────────────────────────────────────────
 *
 * Every entry that reaches the database was refused if its debits did not equal its credits, so
 * total debits should always equal total credits. Saying so out loud — and saying it in red when it
 * is not true — is what makes the claim auditable. A green tick nobody can check is decoration.
 */

const TIPO_LABEL = {
  activo: "Activo",
  pasivo: "Pasivo",
  capital: "Capital",
  ingreso: "Ingreso",
  gasto: "Gasto"
};

/** The order a balance sheet is read in: what it has, what it owes, what was put in, results. */
const ORDEN_TIPOS = ["activo", "pasivo", "capital", "ingreso", "gasto"];

const Cuentas = ({ balance, cargando }) => {
  if (cargando) return <p>Cargando el plan de cuentas…</p>;
  if (!balance) return <div className="card"><p>No se pudo leer el plan de cuentas.</p></div>;

  const porTipo = ORDEN_TIPOS.map((tipo) => ({
    tipo,
    cuentas: balance.cuentas.filter((c) => c.tipo === tipo)
  })).filter((g) => g.cuentas.length > 0);

  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 24,
            justifyContent: "space-between",
            alignItems: "center"
          }}
        >
          {/* The two totals are the whole point of this screen, so they carry the same hooks the
              rest of the section does. Without a `data-testid` there is nothing for a drive to read
              the trial balance off, and a trial balance nobody can read back is a claim rather than a
              check — which is why `cuadre` below has one and these two did not. */}
          <div>
            <div style={{ fontSize: 12, color: "var(--kanagawa-fg-muted)" }}>Total al debe</div>
            <div style={{ fontSize: 20, fontWeight: 700 }} data-testid="total-debe">
              {formatCentavos(balance.totalDebeCentavos)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "var(--kanagawa-fg-muted)" }}>Total al haber</div>
            <div style={{ fontSize: 20, fontWeight: 700 }} data-testid="total-haber">
              {formatCentavos(balance.totalHaberCentavos)}
            </div>
          </div>
          <div data-testid="cuadre">
            <div style={{ fontSize: 12, color: "var(--kanagawa-fg-muted)" }}>Cuadre</div>
            <div
              style={{
                fontSize: 20,
                fontWeight: 700,
                color: balance.cuadra ? "var(--kanagawa-green)" : "var(--kanagawa-red)"
              }}
            >
              {balance.cuadra ? (
                <>
                  <i className="fa-solid fa-circle-check" aria-hidden="true"></i> Cuadra
                </>
              ) : (
                <>
                  <i className="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>{" "}
                  Descuadrado por {formatCentavos(Math.abs(balance.diferenciaCentavos))}
                </>
              )}
            </div>
          </div>
        </div>
        {!balance.cuadra ? (
          <p style={{ fontSize: 13, color: "var(--kanagawa-red)", marginTop: 12, marginBottom: 0 }}>
            Los débitos y los créditos del libro no coinciden. Cada asiento se rechaza si no balancea,
            así que esto significa que algo escribió en el libro sin pasar por el repositorio.
          </p>
        ) : null}
      </div>

      {porTipo.map(({ tipo, cuentas }) => (
        <div key={tipo} style={{ marginBottom: 24 }}>
          <h3 className="mm-sub">
            {TIPO_LABEL[tipo]}
            <span style={{ fontWeight: 400, color: "var(--kanagawa-fg-muted)", marginLeft: 8 }}>
              {formatCentavos(balance.porTipoCentavos[tipo] ?? 0)}
            </span>
          </h3>
          <div className="table-container">
            <table className="product-list">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>Código</th>
                  <th>Cuenta</th>
                  <th style={{ textAlign: "right" }}>Debe</th>
                  <th style={{ textAlign: "right" }}>Haber</th>
                  <th style={{ textAlign: "right" }}>Saldo</th>
                  <th style={{ textAlign: "right" }}>Mov.</th>
                </tr>
              </thead>
              <tbody>
                {cuentas.map((c) => (
                  <tr key={c.id} style={c.activo ? undefined : { opacity: 0.55 }}>
                    <td style={{ fontFamily: "monospace" }}>{c.codigo}</td>
                    <td>
                      {c.nombre}
                      {c.activo ? null : (
                        <span
                          style={{ marginLeft: 8, fontSize: 11, color: "var(--kanagawa-fg-muted)" }}
                        >
                          (inactiva)
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {c.debeCentavos ? formatCentavos(c.debeCentavos) : "—"}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {c.haberCentavos ? formatCentavos(c.haberCentavos) : "—"}
                    </td>
                    <td
                      style={{
                        textAlign: "right",
                        fontWeight: 600,
                        // A credit balance in an asset account is worth a second look — it is either
                        // an overpayment or a mistake. Colouring it is not a claim that it is wrong;
                        // it is a marker that a human should read the row.
                        color:
                          c.saldoCentavos < 0 ? "var(--kanagawa-red)" : undefined
                      }}
                    >
                      {formatCentavos(c.saldoCentavos)}
                    </td>
                    <td style={{ textAlign: "right" }}>{c.movimientos || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
};

export default Cuentas;
