import React, { useState } from "react";
import { productosAPI } from "../../api/productos";
import { mensajeDeError } from "../../api/ipc";
import { toast } from "react-toastify";
import { formatCantidad, milliAEntrada } from "../../utils/formatters";
import Modal from "./Modal";

/**
 * StockInPanel — restore stock to a product the product list already knows.
 *
 * ── WHY A SCAN, AND WHY THIS PANEL EXISTS ─────────────────────────────────────────────────────
 *
 * The products screen can edit any field of any row, but the operator restocking a shelf is not
 * looking at a table: they have the box in one hand and a barcode reader in the other. Scanning a
 * code and getting the product back is the fast path, and `productos.findByCode` already answers it
 * — this is the screen that consumes that read. It sits in `pages/Productos.jsx`'s toolbar, and this
 * panel is what opens once a code resolves.
 *
 * ── ABSOLUTE STOCK, NOT A DELTA ───────────────────────────────────────────────────────────────
 *
 * The box asks for the NEW TOTAL, and it is pre-filled with what the shelf holds now. The submit
 * sends that value to `productos.update`, which is a PATCH: the payload carries `{ stock }` and
 * nothing else, so nothing else about the product moves. "Absolute" is the honest word — the
 * operator counted the shelf, and the number they type IS the stock, not an amount to add to a
 * number they would have to read first.
 *
 * The field is a DECIMAL STRING, exactly like the stock box of the product form: `toMilli` in
 * `productos.repo.js` is the only thing that turns "5" or "1.5" into thousandths, and a component
 * that pre-multiplied would be a second, disagreeing parser.
 *
 * ── AN INACTIVE PRODUCT IS TOLD, NOT TURNED BACK ON ───────────────────────────────────────────
 *
 * If the found product is inactive, the panel says so and REFUSES to submit. The tempting shortcut
 * — reactivate on write — would put a product the shop deliberately pulled back on the shelf as a
 * side effect of counting it, silently. Reactivation is a decision the operator makes on the row,
 * with "Activar"; this panel is not that button.
 */
const StockInPanel = ({ producto, onClose, onDone }) => {
  const inactivo = producto.activo === false;
  // Pre-filled with the current stock, in the same decimal shape the product form uses, so the
  // operator sees what they are replacing. `milliAEntrada` is the integer->input inverse; a plain
  // `stockMilli / 1000` would route the integer through a float.
  const [stock, setStock] = useState(() => milliAEntrada(producto.stockMilli ?? 0));
  const [guardando, setGuardando] = useState(false);

  const guardar = async (evento) => {
    evento.preventDefault();
    if (inactivo) return;
    setGuardando(true);
    try {
      // Only `stock` travels: PATCH semantics leave every other column where it was. The value is
      // the decimal string the operator typed; the repository parses it to thousandths.
      await productosAPI.actualizar(producto.id, { stock });
      toast.success(`Stock de "${producto.nombre}" actualizado`);
      onDone();
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudo actualizar el stock"), { autoClose: 9000 });
      setGuardando(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Agregar stock — ${producto.nombre}`}>
      <div data-testid="stock-in-panel">
        <div
          style={{
            background: "var(--kanagawa-bg-alt, rgba(0,0,0,0.06))",
            border: "1px solid var(--kanagawa-border)",
            borderRadius: 10,
            padding: "12px 14px",
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 14 }}>{producto.nombre}</div>
          <div>Código: {producto.codigo ?? "—"}</div>
          <div>
            Stock actual:{" "}
            {formatCantidad(producto.stockMilli ?? 0, {
              unidad: producto.unidadMedida,
              baseDecimals: true,
            })}
          </div>
          <div>
            Stock mínimo:{" "}
            {formatCantidad(producto.stockMinimoMilli ?? 0, {
              unidad: producto.unidadMedida,
              baseDecimals: true,
            })}
          </div>
        </div>

        {/* Stated before the field, not after a failed submit: an operator who scans an inactive
            product needs to know WHY the button will not fire. No auto-reactivation. */}
        {inactivo ? (
          <div
            data-testid="stock-in-warning"
            role="alert"
            style={{
              background: "rgba(243, 139, 168, 0.15)",
              border: "1px solid var(--kanagawa-red)",
              color: "var(--kanagawa-red)",
              borderRadius: 10,
              padding: "10px 12px",
              marginBottom: 16,
              fontSize: 13,
            }}
          >
            Este producto está inactivo. Reactivalo para agregar stock.
          </div>
        ) : null}

        <form onSubmit={guardar}>
          <div className="form-group">
            <label htmlFor="stock-in-input">Nuevo stock</label>
            <input
              id="stock-in-input"
              data-testid="stock-in-input"
              className="input-field"
              inputMode="decimal"
              value={stock}
              onChange={(e) => setStock(e.target.value)}
              placeholder="0"
              disabled={inactivo}
              autoFocus
            />
          </div>

          <div className="form-row">
            <button
              type="submit"
              className="btn-primary"
              data-testid="stock-in-submit"
              disabled={inactivo || guardando}
            >
              {guardando ? "Guardando…" : "Agregar stock"}
            </button>
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancelar
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
};

export default StockInPanel;
