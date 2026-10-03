import React, { useCallback, useEffect, useMemo, useState } from "react";
import { comprasAPI } from "../api/compras";
import { proveedoresAPI } from "../api/proveedores";
import { productosAPI } from "../api/productos";
import { mensajeDeError } from "../api/ipc";
import Modal from "../components/common/Modal";
import { toast } from "react-toastify";
import { formatCentavos, formatCantidad, formatDate } from "../utils/formatters";
import { toCents } from "../../../shared/money";

/**
 * Compras — recording goods arriving, what they cost, and how the shop paid for them.
 *
 * WHAT A PERSON CAN DO HERE:
 *
 *   - register a purchase against a supplier, with ONE line or many
 *   - buy a FRACTIONAL quantity of a weighed product — 2,5 kg of cheese — which the web's integer
 *     `cantidad` cannot record at all
 *   - say how it was paid: cash (money leaves the drawer), card (the bank), or credit (the shop now
 *     OWES the supplier, and the purchase is listed as pending)
 *   - see, for every purchase, the stock it added, the account it credited and the journal entry it
 *     posted, so the number on screen can be checked against the books
 *   - cancel a purchase, which puts the stock, the cost, the entry and the cash back
 *
 * THE TOTAL SHOWN HERE IS A PREVIEW, NEVER A SUBMISSION. It is computed with the same
 * `toCents`/`lineTotal` arithmetic a reader would do by hand, so the operator sees the number before
 * committing — and what is committed is the total the REPOSITORY computes from the same lines.
 * The repository's figure is what lands on screen afterwards, because that is the one that went
 * into the books. A total this screen sent would be a total a client could dictate.
 *
 * THE THREE METHODS, AND WHAT EACH ONE DOES TO THE MONEY. The distinction is the whole reason this
 * screen exists, so it is spelled out where the choice is made:
 *
 *   - Efectivo: credit `1.1.01 Caja`, one `egreso` in the drawer.
 *   - Tarjeta:  credit `1.1.02 Banco`, and the drawer does NOT move. Card sales work the same way,
 *               so the till total and the bank total cannot drift apart.
 *   - Crédito:  credit `2.1.01 Proveedores (Acreedores)`, and the drawer does NOT move. Nothing has
 *               been paid, so this is a `pendiente` purchase and the supplier's owed figure rises.
 *
 * There is no `transferencia` and no `mixto` here, and the repository refuses them by name. Adding
 * one to this list without a mapping in `CUENTA_POR_METODO` would be a button that posts to an
 * account nobody chose.
 */
const PAGE_SIZE = 20;

const METODOS = [
  { value: "efectivo", label: "Efectivo", ayuda: "Saca el dinero de la caja" },
  { value: "tarjeta", label: "Tarjeta", ayuda: "Va al banco, la caja no se mueve" },
  { value: "credito", label: "Crédito", ayuda: "Queda pendiente: el local le debe al proveedor" }
];

const METODO_LABEL = { efectivo: "Efectivo", tarjeta: "Tarjeta", credito: "Crédito" };

const ESTADO_LABEL = { pendiente: "Pendiente", completada: "Completada", cancelada: "Cancelada" };

const Compras = () => {
  const [compras, setCompras] = useState([]);
  const [total, setTotal] = useState(0);
  const [pagina, setPagina] = useState(0);
  const [search, setSearch] = useState("");
  const [estado, setEstado] = useState("");
  const [loading, setLoading] = useState(true);
  const [detalle, setDetalle] = useState(null);
  const [form, setForm] = useState(null);
  const [guardando, setGuardando] = useState(false);
  const [porCancelar, setPorCancelar] = useState(null);
  const [cancelando, setCancelando] = useState(false);

  const cargar = useCallback(async ({ suprimeCargando = false } = {}) => {
    if (!suprimeCargando) setLoading(true);
    try {
      const res = await comprasAPI.listar({
        search,
        estado: estado || undefined,
        limit: PAGE_SIZE,
        offset: pagina * PAGE_SIZE
      });
      setCompras(res.filas ?? []);
      setTotal(res.total ?? 0);
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudieron cargar las compras"));
    } finally {
      setLoading(false);
    }
  }, [search, estado, pagina]);

  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => { setPagina(0); }, [search, estado]);

  const abrir = async () => {
    try {
      // The supplier list arrives with the form. A purchase with no supplier is refused by the
      // repository, and the operator finds that out from the form's own picker instead of from a
      // 400 after filling in four lines.
      const [provs, prods] = await Promise.all([
        proveedoresAPI.listar({ activo: "true", limit: 200 }),
        productosAPI.listar({ limit: 500 })
      ]);
      setForm({
        proveedorId: "",
        metodoPago: "efectivo",
        folio: "",
        observaciones: "",
        items: [{ productoId: "", cantidad: "1", precioUnitario: "" }],
        proveedores: provs.filas ?? [],
        productos: prods.filas ?? []
      });
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudo abrir la carga de compra"));
    }
  };

  /**
   * The preview total, for the operator to check before committing.
   *
   * It is NOT what gets stored: `compras.repo.js` recomputes every line from the same two numbers
   * with `lineTotalCentavos` inside the transaction. This exists so the form can show a total, and
   * it is a `toCents` that returns 0 for a half-typed price rather than a NaN on the screen.
   *
   * And that last part is the whole reason this is a `try`. The comment above used to promise it
   * while the code called `toCents` directly, which THROWS a `MoneyError` on anything that is not a
   * finished amount. This runs during render, so a `MoneyError` here is not a red input: React has
   * no error boundary in this app, so it unmounts the entire tree. The operator types `1200`, hits
   * one stray key, and the whole window goes blank — the product list, the supplier form, the
   * in-progress purchase, everything — with only a restart to recover.
   *
   * A half-typed price is the NORMAL state of this field while someone is typing, so it must never
   * be able to take the application down. An unparseable price is worth 0 in the preview, the field
   * still shows exactly what was typed, and `guardar` is what refuses the line, with a message
   * about the price. The preview's job is to add up what is readable, not to enforce the form.
   */
  const totalPreview = useMemo(() => {
    if (!form) return 0;
    return form.items.reduce((suma, item) => {
      let precio = 0;
      try {
        precio = item.precioUnitario ? toCents(item.precioUnitario, "precio") : 0;
      } catch {
        precio = 0;
      }
      const cantidad = Number.parseFloat(String(item.cantidad).replace(',', '.')) || 0;
      return suma + Math.round(precio * cantidad);
    }, 0);
  }, [form]);

  const cambiarItem = (i, campo, valor) => {
    setForm((f) => ({
      ...f,
      items: f.items.map((item, j) => (j === i ? { ...item, [campo]: valor } : item))
    }));
  };

  /** Choosing a product fills the price with THAT product's current purchase cost, as a starting point. */
  const elegirProducto = (i, productoId) => {
    const producto = form.productos.find((p) => p.id === Number(productoId));
    setForm((f) => ({
      ...f,
      items: f.items.map((item, j) =>
        j === i
          ? {
              ...item,
              productoId,
              precioUnitario: producto ? (producto.precioCompraCentavos / 100).toFixed(2) : item.precioUnitario
            }
          : item
      )
    }));
  };

  const registrar = async (e) => {
    e.preventDefault();
    setGuardando(true);
    try {
      // `items` carries the three fields the repository reads. No total, no cost, no stock: those
      // are the repository's to decide.
      const creada = await comprasAPI.crear({
        proveedorId: form.proveedorId,
        metodoPago: form.metodoPago,
        folio: form.folio || undefined,
        observaciones: form.observaciones || undefined,
        items: form.items
          .filter((i) => i.productoId)
          .map((i) => ({ productoId: i.productoId, cantidad: i.cantidad, precioUnitario: i.precioUnitario }))
      });

      toast.success(`Compra ${creada.folio} registrada: ${formatCentavos(creada.totalCentavos)}`);
      // The purchase that comes back is the one in the books — its method was DERIVED from the
      // account it credited, and its lines are the stored ones. This screen shows that, not the
      // form it just submitted.
      setForm(null);
      setDetalle(creada);
      await cargar({ suprimeCargando: true });
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudo registrar la compra"));
    } finally {
      setGuardando(false);
    }
  };

  const ver = async (compra) => {
    try {
      setDetalle(await comprasAPI.obtener(compra.id));
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudo abrir la compra"));
    }
  };

  /**
   * Cancellation is asked for twice on purpose.
   *
   * A `window.confirm` was the first version of this, and it is wrong twice over: it blocks the
   * renderer on a native dialog the rest of this app never uses — `Deudores` confirms through a
   * `Modal` like every other screen — and it is untestable by the drive harness, which can click a
   * DOM button but cannot answer a native prompt. The confirmation below says what will be undone,
   * because "Cancelar" next to a purchase total is not enough of a warning on its own.
   */
  const confirmarCancelacion = async () => {
    if (!porCancelar) return;
    setCancelando(true);
    try {
      await comprasAPI.cancelar(porCancelar.id);
      toast.success(`Compra ${porCancelar.folio} cancelada`);
      setPorCancelar(null);
      if (detalle?.id === porCancelar.id) setDetalle(null);
      await cargar({ suprimeCargando: true });
    } catch (err) {
      // The 409s here are real accounting limits, not failures: a moving average cannot be inverted
      // once a later purchase has folded its lot in, a hand-corrected stock cannot be overwritten,
      // and a cash refund needs a till that exists. The repository's message says what to do, and it
      // is worth reading rather than hiding behind a generic one.
      toast.error(mensajeDeError(err, "No se pudo cancelar la compra"), { autoClose: 9000 });
      setPorCancelar(null);
    } finally {
      setCancelando(false);
    }
  };

  const paginas = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    // A bare `<div>`, for the same reason as in Proveedores.jsx: `styles/index.css:304` still
    // carries `.page { display: none }` / `.page.active { display: block }` from the web shell, and
    // nothing in a react-router app ever adds `.active`. With that class the whole screen rendered
    // invisible while every selector kept matching it. Deudores and Ventas start from a bare `<div>`.
    <div>
      <div className="bar">
        <h2>Compras</h2>
        <div className="bar">
          <input
            className="filter-input"
            type="search"
            placeholder="Buscar por folio o proveedor"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Buscar compra"
          />
          <select
            className="filter-input"
            value={estado}
            onChange={(e) => setEstado(e.target.value)}
            aria-label="Filtrar por estado"
          >
            <option value="">Todos los estados</option>
            <option value="pendiente">Pendiente (deuda con el proveedor)</option>
            <option value="completada">Completada</option>
            <option value="cancelada">Cancelada</option>
          </select>
          <button className="btn-primary" onClick={abrir}>
            <i className="fa-solid fa-cart-plus" aria-hidden="true"></i> Registrar compra
          </button>
        </div>
      </div>

      {loading ? (
        <p>Cargando compras…</p>
      ) : compras.length === 0 ? (
        <div className="card">
          <p>
            {estado === "pendiente"
              ? "No hay compras pendientes: el local no le debe nada a ningún proveedor."
              : "Todavía no hay compras registradas."}
          </p>
        </div>
      ) : (
        <div className="table-container">
          <table className="product-list">
            <thead>
              <tr>
                <th>Folio</th>
                <th>Fecha</th>
                <th>Proveedor</th>
                <th>Total</th>
                <th>Pago</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {compras.map((c) => (
                <tr key={c.id}>
                  <td>{c.folio}</td>
                  <td>{formatDate(c.fecha)}</td>
                  <td>{c.proveedorNombre ?? "—"}</td>
                  <td>{formatCentavos(c.totalCentavos)}</td>
                  {/* The method the repository derived from the account this purchase credited. */}
                  <td>{c.metodoPago ? METODO_LABEL[c.metodoPago] : "—"}</td>
                  <td>
                    <span className={`status status-${c.estado}`}>{ESTADO_LABEL[c.estado]}</span>
                  </td>
                  <td>
                    <button className="btn-secondary" onClick={() => ver(c)}>
                      Ver
                    </button>{" "}
                    {c.estado !== "cancelada" ? (
                      <button className="btn-danger" onClick={() => setPorCancelar(c)}>
                        Cancelar
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {paginas > 1 ? (
        <div className="mm-pager">
          <button className="btn-secondary" disabled={pagina === 0} onClick={() => setPagina((p) => p - 1)}>
            Anterior
          </button>
          <span>
            Página {pagina + 1} de {paginas} · {total} compras
          </span>
          <button className="btn-secondary" disabled={pagina + 1 >= paginas} onClick={() => setPagina((p) => p + 1)}>
            Siguiente
          </button>
        </div>
      ) : null}

      {form ? (
        <Modal isOpen onClose={() => setForm(null)} title="Registrar compra" size="lg">
          <form onSubmit={registrar}>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="compra-proveedor">Proveedor *</label>
                <select
                  id="compra-proveedor"
                  className="input-field"
                  value={form.proveedorId}
                  onChange={(e) => setForm({ ...form, proveedorId: e.target.value })}
                  required
                >
                  <option value="">Elegí un proveedor…</option>
                  {form.proveedores.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nombre}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="compra-metodo">Cómo se paga *</label>
                <select
                  id="compra-metodo"
                  className="input-field"
                  value={form.metodoPago}
                  onChange={(e) => setForm({ ...form, metodoPago: e.target.value })}
                >
                  {METODOS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label} — {m.ayuda}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="compra-folio">Folio del proveedor</label>
                <input
                  id="compra-folio"
                  className="input-field"
                  placeholder="Se genera solo si lo dejás vacío"
                  value={form.folio}
                  onChange={(e) => setForm({ ...form, folio: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label htmlFor="compra-observaciones">Observaciones</label>
                <input
                  id="compra-observaciones"
                  className="input-field"
                  value={form.observaciones}
                  onChange={(e) => setForm({ ...form, observaciones: e.target.value })}
                />
              </div>
            </div>

            <h3>Productos</h3>
            {form.items.map((item, i) => {
              const producto = form.productos.find((p) => p.id === Number(item.productoId));
              return (
                <div className="form-row" key={i}>
                  <div className="form-group">
                    <label htmlFor={`item-prod-${i}`}>Producto *</label>
                    <select
                      id={`item-prod-${i}`}
                      className="input-field"
                      value={item.productoId}
                      onChange={(e) => elegirProducto(i, e.target.value)}
                      required
                    >
                      <option value="">Elegí un producto…</option>
                      {form.productos.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.nombre} (stock: {formatCantidad(p.stockMilli, { unidad: p.unidadMedida })})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label htmlFor={`item-cant-${i}`}>
                      Cantidad{producto ? ` (${producto.unidadMedida})` : ""} *
                    </label>
                    <input
                      id={`item-cant-${i}`}
                      className="input-field"
                      // `inputMode="decimal"`, not `type="number"`: a number input on some layouts
                      // drops the comma decimal mark, and this quantity is allowed to be 2,5.
                      inputMode="decimal"
                      value={item.cantidad}
                      onChange={(e) => cambiarItem(i, "cantidad", e.target.value)}
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor={`item-precio-${i}`}>Costo unitario *</label>
                    <input
                      id={`item-precio-${i}`}
                      className="input-field"
                      inputMode="decimal"
                      value={item.precioUnitario}
                      onChange={(e) => cambiarItem(i, "precioUnitario", e.target.value)}
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label>&nbsp;</label>
                    <button
                      type="button"
                      className="btn-danger"
                      disabled={form.items.length === 1}
                      onClick={() =>
                        setForm((f) => ({ ...f, items: f.items.filter((_, j) => j !== i) }))
                      }
                    >
                      Quitar
                    </button>
                  </div>
                </div>
              );
            })}
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                setForm((f) => ({
                  ...f,
                  items: [...f.items, { productoId: "", cantidad: "1", precioUnitario: "" }]
                }))
              }
            >
              <i className="fa-solid fa-plus" aria-hidden="true"></i> Agregar producto
            </button>

            <div className="card" style={{ marginTop: "16px" }}>
              {/* A PREVIEW. What gets stored is the total the repository recomputes from these same
                  lines inside the transaction. */}
              <strong>Total estimado: {formatCentavos(totalPreview)}</strong>
              <p style={{ margin: "4px 0 0", fontSize: "0.85rem" }}>
                {form.metodoPago === "efectivo"
                  ? "Sale de la caja: hace falta una caja abierta."
                  : form.metodoPago === "tarjeta"
                    ? "Va al banco. La caja no se mueve."
                    : "Queda pendiente: se le suma a lo que el local le debe al proveedor."}
              </p>
            </div>

            <div className="form-row" style={{ marginTop: "16px" }}>
              <button type="submit" className="btn-primary" disabled={guardando}>
                {guardando ? "Registrando…" : "Registrar compra"}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setForm(null)}>
                Cancelar
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {detalle ? (
        <Modal
          isOpen
          onClose={() => setDetalle(null)}
          title={`Compra ${detalle.folio}`}
          size="lg"
        >
          <div className="mm-detail-grid">
            <div>
              <strong>Proveedor:</strong> {detalle.proveedorNombre ?? "—"}
            </div>
            <div>
              <strong>Fecha:</strong> {formatDate(detalle.fecha)}
            </div>
            <div>
              <strong>Total:</strong> {formatCentavos(detalle.totalCentavos)}
            </div>
            <div>
              <strong>Pago:</strong>{" "}
              {detalle.metodoPago ? METODO_LABEL[detalle.metodoPago] : "— (cancelada)"}
            </div>
            <div>
              <strong>Estado:</strong> {ESTADO_LABEL[detalle.estado]}
            </div>
          </div>

          <h3>Productos</h3>
          <table className="product-list">
            <thead>
              <tr>
                <th>Producto</th>
                <th>Cantidad</th>
                <th>Costo unitario</th>
                <th>Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {detalle.detalles.map((d) => (
                <tr key={d.id}>
                  <td>{d.productoNombre ?? `#${d.productoId}`}</td>
                  <td>{formatCantidad(d.cantidadMilli, { unidad: d.unidadMedida })}</td>
                  <td>{formatCentavos(d.precioUnitarioCentavos)}</td>
                  <td>{formatCentavos(d.subtotalCentavos)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {detalle.asiento ? (
            <>
              <h3>Asiento contable</h3>
              <table className="product-list">
                <thead>
                  <tr>
                    <th>Cuenta</th>
                    <th>Debe</th>
                    <th>Haber</th>
                  </tr>
                </thead>
                <tbody>
                  {detalle.asiento.partidas.map((p, i) => (
                    <tr key={i}>
                      <td>
                        {p.codigo} — {p.nombre}
                      </td>
                      <td>{p.debe > 0 ? formatCentavos(p.debe) : "—"}</td>
                      <td>{p.haber > 0 ? formatCentavos(p.haber) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}

          {detalle.movimientoCaja ? (
            <p>
              <strong>Caja:</strong> {detalle.movimientoCaja.concepto} —{" "}
              {formatCentavos(detalle.movimientoCaja.montoCentavos)}, saldo {formatCentavos(detalle.movimientoCaja.saldoAnteriorCentavos)}{" "}
              → {formatCentavos(detalle.movimientoCaja.saldoNuevoCentavos)}
            </p>
          ) : (
            <p>
              <strong>Caja:</strong> sin movimiento — este pago no sale de la caja.
            </p>
          )}

          <div className="form-row" style={{ marginTop: "16px" }}>
            {detalle.estado !== "cancelada" ? (
              <button className="btn-danger" onClick={() => setPorCancelar(detalle)}>
                Cancelar compra
              </button>
            ) : null}
            <button className="btn-secondary" onClick={() => setDetalle(null)}>
              Cerrar
            </button>
          </div>
        </Modal>
      ) : null}

      {porCancelar ? (
        <Modal
          isOpen
          onClose={() => setPorCancelar(null)}
          title={`Cancelar la compra ${porCancelar.folio}`}
        >
          <p>
            Se va a devolver {formatCentavos(porCancelar.totalCentavos)} de{" "}
            <strong>{porCancelar.proveedorNombre ?? "el proveedor"}</strong> y a deshacer lo que esta
            compra hizo:
          </p>
          <ul style={{ marginLeft: 18, lineHeight: 1.6 }}>
            <li>el stock de cada producto vuelve a como estaba</li>
            <li>el costo promedio de cada producto vuelve al anterior</li>
            <li>se posta el asiento contable inverso</li>
            <li>
              {porCancelar.metodoPago === "efectivo"
                ? "el efectivo vuelve a la caja — hace falta que haya una caja abierta"
                : "no se mueve el dinero: esta compra no salió de la caja"}
            </li>
          </ul>
          <p style={{ color: "var(--kanagawa-fg-muted)", fontSize: 13 }}>
            Si una compra posterior ya cambió el costo de alguno de estos productos, la anulación se
            va a negar y vas a tener que anular en orden inverso.
          </p>
          <div className="form-row">
            <button
              className="btn-danger"
              data-testid="confirmar-cancelar-compra"
              onClick={confirmarCancelacion}
              disabled={cancelando}
            >
              {cancelando ? "Anulando…" : "Sí, anular la compra"}
            </button>
            <button className="btn-secondary" onClick={() => setPorCancelar(null)}>
              Volver
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
};

export default Compras;
