import { useState, useEffect, useRef } from "react";

const formatPeso = (g) => {
  if (g >= 1000) return `${(g / 1000).toFixed(2)} kg`;
  return `${g.toFixed(0)} g`;
};

const UNIDAD_KG = /^(kg|kilo|kilogramo|l|litro|lt)$/i;
const UNIDAD_G = /^(g|gramo|ml)$/i;

const factorKg = (unidad) => {
  const u = (unidad || "").trim();
  if (UNIDAD_G.test(u)) return 1000;  // precio está por gramo/ml → multiplicar para obtener kg/l
  return 1;                            // ya está por kg/litro
};

const etiquetaUnidad = (unidad) => {
  const u = (unidad || "").trim();
  if (UNIDAD_KG.test(u)) return "kg";
  if (UNIDAD_G.test(u)) return "g";
  return "kg";
};

export default function CalculadoraPeso({ producto, onConfirm, onClose }) {
  const unidad = producto.unidadMedida || "";
  const factor = factorKg(unidad);
  /**
   * THE FIX. The web read `producto.precio`, a float of pesos that the HTTP API sent. The
   * desktop sends `precioCentavos` — an INTEGER, because money is integer centavos everywhere
   * in this app — so `parseFloat(producto.precio)` was `parseFloat(undefined)`, i.e. `0`.
   *
   * A `precioKg` of zero does not throw. It does something much worse: `handlePesoChange` sees
   * `precioKg > 0` false, clears `monto`, and `valido` (`montoNum > 0 && pesoNum > 0`) can never
   * be true, so «Agregar al ticket» stayed disabled forever. The scale was a decoration. The
   * weighed path looked right in the grid, and 25/25 launch-probe checks passed, because the
   * probe proves IPC and the preload and never weighs anything.
   *
   * The two fields stay in the units the operator reads them in — PESOS in «El cliente paga»,
   * GRAMS in «El cliente lleva» — and only the stored price is converted, once, here.
   */
  const precioUnitPesos = (producto.precioCentavos ?? 0) / 100;
  const precioKg = precioUnitPesos * factor;
  const labelUnidad = etiquetaUnidad(unidad);
  const [modo, setModo] = useState("monto"); // "monto" | "peso"
  const [monto, setMonto] = useState("");
  const [peso, setPeso] = useState("");
  const montoRef = useRef(null);

  useEffect(() => {
    if (modo === "monto") montoRef.current?.focus();
  }, [modo]);

  const handleMontoChange = (val) => {
    setMonto(val);
    if (precioKg > 0 && val) {
      const num = parseFloat(val.replace(",", "."));
      if (!isNaN(num) && num > 0) {
        setPeso(((num / precioKg) * 1000).toFixed(0));
      } else {
        setPeso("");
      }
    } else {
      setPeso("");
    }
  };

  const handlePesoChange = (val) => {
    setPeso(val);
    if (precioKg > 0 && val) {
      const num = parseFloat(val.replace(",", "."));
      if (!isNaN(num) && num > 0) {
        setMonto(((num / 1000) * precioKg).toFixed(2));
      } else {
        setMonto("");
      }
    } else {
      setMonto("");
    }
  };

  const montoNum = parseFloat(monto) || 0;
  const pesoNum = parseFloat(peso) || 0;
  const valido = montoNum > 0 && pesoNum > 0;

  const handleConfirm = () => {
    if (!valido) return;
    onConfirm({
      productoId: producto.id,
      nombre: `${producto.nombre} (${formatPeso(pesoNum)})`,
      peso: pesoNum,
      // PESOS, as the two fields above. The parent does not trust this and recomputes the line
      // from `precioCentavos` with `lineTotalCentavos`; the value travels for the caller's
      // benefit, and a caller that prefers to read it must know which unit it is in.
      precio: montoNum,
      precioUnitario: montoNum,
    });
  };

  return (
    <div
      className="modal-overlay"
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
        backdropFilter: "blur(4px)", zIndex: 200,
        display: "flex", alignItems: "center", justifyContent: "center", padding: "16px",
      }}
      onClick={onClose}
    >
      <div className="card" style={{ width: "100%", maxWidth: "400px" }} onClick={(e) => e.stopPropagation()}>
        <div className="card-header">
          <div>
            <h3 style={{ margin: 0, fontSize: "18px" }}>⚖️ Calcular por peso</h3>
            <span className="tag" style={{ marginTop: "4px", display: "inline-block" }}>
              {producto.nombre}
            </span>
          </div>
          <button onClick={onClose} className="btn-secondary" style={{ padding: "6px 10px" }}>
            <i className="fa-solid fa-times"></i>
          </button>
        </div>

        <div style={{ padding: "20px 22px" }}>
          {/* Precio por kilo */}
          <div
            style={{
              background: "#eff6ff", borderRadius: "12px", padding: "14px",
              textAlign: "center", marginBottom: "20px", border: "1px solid #dbeafe",
            }}
          >
            <p style={{ fontSize: "13px", color: "#64748b", marginBottom: "4px" }}>
              Precio por {labelUnidad === "g" ? "gramo" : "kg"}
            </p>
            <p style={{ fontSize: "26px", fontWeight: 700, color: "#1d4ed8", margin: 0 }}>
              {precioUnitPesos.toFixed(2)}
            </p>
            {labelUnidad === "g" && (
              <p style={{ fontSize: "11px", color: "#94a3b8", margin: "4px 0 0" }}>
                = ${precioKg.toFixed(2)} / kg
              </p>
            )}
          </div>

          {/* Toggle modo */}
          <div style={{ display: "flex", gap: "6px", marginBottom: "16px" }}>
            <button
              onClick={() => setModo("monto")}
              className={modo === "monto" ? "btn-primary" : "btn-secondary"}
              style={{ flex: 1, fontSize: "12px", padding: "6px 10px" }}
            >
              💵 Sé cuánto paga
            </button>
            <button
              onClick={() => setModo("peso")}
              className={modo === "peso" ? "btn-primary" : "btn-secondary"}
              style={{ flex: 1, fontSize: "12px", padding: "6px 10px" }}
            >
              ⚖️ Sé cuánto lleva
            </button>
          </div>

          {/* Monto a pagar */}
          <div className="form-group" style={{ opacity: modo === "monto" ? 1 : 0.5 }}>
            <label>El cliente paga ($)</label>
            <input
              ref={modo === "monto" ? montoRef : null}
              type="text"
              inputMode="decimal"
              value={monto}
              onChange={(e) => handleMontoChange(e.target.value)}
              onFocus={() => setModo("monto")}
              placeholder="Ej: 3000"
              style={{ fontSize: "18px", fontWeight: 600 }}
            />
          </div>

          {/* Peso */}
          <div className="form-group" style={{ opacity: modo === "peso" ? 1 : 0.5 }}>
            <label>El cliente lleva (gramos)</label>
            <input
              ref={modo === "peso" ? montoRef : null}
              type="text"
              inputMode="decimal"
              value={peso}
              onChange={(e) => handlePesoChange(e.target.value)}
              onFocus={() => setModo("peso")}
              placeholder="Ej: 250"
              style={{ fontSize: "18px", fontWeight: 600 }}
            />
          </div>

          {/* Resultado */}
          {valido && (
            <div
              style={{
                background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "10px",
                padding: "14px", textAlign: "center", marginTop: "4px", marginBottom: "20px",
              }}
            >
              <p style={{ fontSize: "13px", color: "#64748b", margin: "0 0 6px", fontWeight: 500 }}>
                {modo === "monto"
                  ? `Con $${montoNum.toFixed(2)} le corresponden`
                  : `${formatPeso(pesoNum)} a $${precioUnitPesos.toFixed(2)}/${labelUnidad === "g" ? "g" : "kg"} son`}
              </p>
              <div style={{ display: "flex", justifyContent: "center", gap: "24px" }}>
                <div>
                  <p style={{ fontSize: "11px", color: "#94a3b8", margin: 0 }}>Peso</p>
                  <p style={{ fontSize: "22px", fontWeight: 700, color: "#16a34a", margin: 0 }}>
                    {formatPeso(pesoNum)}
                  </p>
                </div>
                <div style={{ width: "1px", background: "#bbf7d0" }} />
                <div>
                  <p style={{ fontSize: "11px", color: "#94a3b8", margin: 0 }}>Total</p>
                  <p style={{ fontSize: "22px", fontWeight: 700, color: "#16a34a", margin: 0 }}>
                    ${montoNum.toFixed(2)}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Botones */}
          <div style={{ display: "flex", gap: "12px", paddingTop: "4px" }}>
            <button onClick={onClose} className="btn-secondary" style={{ flex: 1 }}>
              Cancelar
            </button>
            <button
              onClick={handleConfirm}
              disabled={!valido}
              className="btn-success"
              style={{ flex: 1 }}
            >
              <i className="fa-solid fa-check"></i> Agregar al ticket
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
