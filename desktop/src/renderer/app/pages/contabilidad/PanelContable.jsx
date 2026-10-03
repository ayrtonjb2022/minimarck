import React from "react";
import { formatCentavos } from "../../utils/formatters";

/**
 * El panel contable — the balance sheet in the four lines an owner reads first.
 *
 * ── EVERY FIGURE IS THE LEDGER'S, NOT THIS SCREEN'S ───────────────────────────────────────────
 *
 * All of them arrive from `contabilidad.dashboard`, which reads the same sums through the same
 * functions the balance screen and the income statement use. Nothing is added up here, and nothing
 * is recomputed with different arithmetic: a panel that disagreed with the report it summarises is
 * worse than no panel, because the reader has to decide which of the two to believe.
 *
 * ── WHY `activo = pasivo + patrimonio` IS SHOWN AND NOT JUST ASSERTED ─────────────────────────
 *
 * The accounting equation is the thing a balance sheet is FOR, and a screen that printed the three
 * numbers without saying they must agree would leave the reader to check it in their head. Printing
 * the check — and the difference when there is one — turns a claim into something auditable. When
 * it holds, that is information; when it does not, it is the most important number on the page.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────────────────────────
 *
 * Sales for a period, the top products, the cash flow. Those live in `Reportes`, which takes a date
 * range and answers them properly. This panel answers "where does the shop stand right now", which
 * is a different question with no range in it, and duplicating the reports here would give the shop
 * two places to read the same number and no way to tell which one was current.
 */

const Tarjeta = ({ etiqueta, valor, color, nota, testid }) => (
  <div className="card" style={{ flex: "1 1 200px", minWidth: 200 }} data-testid={testid}>
    <div style={{ fontSize: 12, color: "var(--kanagawa-fg-muted)", marginBottom: 4 }}>{etiqueta}</div>
    <div style={{ fontSize: 22, fontWeight: 700, color: color ?? "var(--kanagawa-fg)" }}>{valor}</div>
    {nota ? (
      <div style={{ fontSize: 12, color: "var(--kanagawa-fg-muted)", marginTop: 6 }}>{nota}</div>
    ) : null}
  </div>
);

const Dashboard = ({ datos, cargando }) => {
  if (cargando) return <p>Cargando el panel…</p>;
  if (!datos) return <div className="card"><p>No se pudo leer el panel contable.</p></div>;

  const ecuacionCuadra =
    datos.activoCentavos === datos.pasivoCentavos + datos.patrimonioCentavos;

  return (
    <div>
      <h3 className="mm-sub">Situación</h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 24 }}>
        <Tarjeta
          etiqueta="Activo (lo que tiene)"
          valor={formatCentavos(datos.activoCentavos)}
          testid="contab-activo"
        />
        <Tarjeta
          etiqueta="Pasivo (lo que debe)"
          valor={formatCentavos(datos.pasivoCentavos)}
          color={datos.pasivoCentavos > 0 ? "var(--kanagawa-orange)" : undefined}
          testid="contab-pasivo"
        />
        <Tarjeta
          etiqueta="Patrimonio"
          valor={formatCentavos(datos.patrimonioCentavos)}
          color={datos.patrimonioCentavos < 0 ? "var(--kanagawa-red)" : "var(--kanagawa-green)"}
          nota="Capital aportado + resultado"
          testid="contab-patrimonio"
        />
      </div>

      <h3 className="mm-sub">Resultado del período</h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 24 }}>
        <Tarjeta etiqueta="Ingresos" valor={formatCentavos(datos.ingresosCentavos)} testid="contab-ingresos" />
        <Tarjeta etiqueta="Gastos" valor={formatCentavos(datos.gastosCentavos)} testid="contab-gastos" />
        <Tarjeta
          etiqueta={datos.resultadoCentavos >= 0 ? "Ganancia" : "Pérdida"}
          valor={formatCentavos(datos.resultadoCentavos)}
          color={datos.resultadoCentavos >= 0 ? "var(--kanagawa-green)" : "var(--kanagawa-red)"}
          testid="contab-resultado"
        />
      </div>

      <h3 className="mm-sub">Deudas de la tienda</h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 24 }}>
        <Tarjeta
          etiqueta="Pendiente de pago"
          valor={formatCentavos(datos.deudasPendientesCentavos)}
          color={datos.deudasPendientesCentavos > 0 ? "var(--kanagawa-orange)" : undefined}
          nota={`${datos.deudasAbiertas} de ${datos.deudasTotal} sin saldar`}
          testid="contab-deudas"
        />
      </div>

      <h3 className="mm-sub">Estado del libro</h3>
      <div className="card">
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 24,
            alignItems: "center",
            justifyContent: "space-between"
          }}
        >
          <div>
            <div style={{ fontSize: 12, color: "var(--kanagawa-fg-muted)" }}>Ecuación contable</div>
            <div
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: ecuacionCuadra ? "var(--kanagawa-green)" : "var(--kanagawa-red)"
              }}
              data-testid="contab-ecuacion"
            >
              {ecuacionCuadra ? (
                <>
                  <i className="fa-solid fa-circle-check" aria-hidden="true"></i> Activo = Pasivo +
                  Patrimonio
                </>
              ) : (
                <>
                  <i className="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> No cierra
                  por{" "}
                  {formatCentavos(
                    Math.abs(
                      datos.activoCentavos - (datos.pasivoCentavos + datos.patrimonioCentavos)
                    )
                  )}
                </>
              )}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "var(--kanagawa-fg-muted)" }}>Asientos</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>
              {datos.asientosTotal}
              {datos.ultimoAsiento ? (
                <span style={{ fontWeight: 400, color: "var(--kanagawa-fg-muted)" }}>
                  {" "}
                  · último {String(datos.ultimoAsiento).slice(0, 10)}
                </span>
              ) : null}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "var(--kanagawa-fg-muted)" }}>Cuentas</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{datos.cuentasTotal}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "var(--kanagawa-fg-muted)" }}>Débitos = Créditos</div>
            <div
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: datos.cuadra ? "var(--kanagawa-green)" : "var(--kanagawa-red)"
              }}
            >
              {datos.cuadra ? "Sí" : "No"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
