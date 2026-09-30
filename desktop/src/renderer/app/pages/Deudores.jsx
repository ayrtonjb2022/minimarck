import React, { useCallback, useEffect, useMemo, useState } from "react";
import { deudoresAPI } from "../api/deudores";
import { mensajeDeError } from "../api/ipc";
import Modal from "../components/common/Modal";
import BoletaPago from "../components/common/BoletaPago";
import { toast } from "react-toastify";
import { formatCentavos, formatDate } from "../utils/formatters";
import { toCents } from "../../../shared/money";

/**
 * Deudores — who owes this shop money, and the place a payment gets recorded.
 *
 * WHAT A PERSON CAN DO HERE THAT THEY COULD NOT BEFORE THIS SCREEN:
 *
 *   - see every customer and, next to them, what they still owe, without opening a ticket
 *   - narrow that list to only the people who actually owe something ("solo con deuda")
 *   - find one by name or by document
 *   - add a customer, so a credit sale has somebody to bill
 *   - take a payment, in full or in part, in cash or by card
 *   - print a receipt that shows the REAL remaining balance
 *
 * EVERY MONEY FIGURE ON THIS SCREEN IS INTEGER CENTAVOS AS IT COMES OFF THE WIRE, and is
 * formatted only at the last moment. There is no peso arithmetic in this file: a balance that is
 * summed here could disagree with the one in the database, and the database is the one the
 * customer is charged.
 *
 * THE BALANCE IS NEVER COMPUTED ON THIS SCREEN. `deudor.deudaPendienteCentavos` comes from
 * `v_clientes_deudores` — the sum of the credit sales that are still live, minus the payments
 * recorded against them, clamped at zero. After a payment, the answer to "how much is left" is
 * read back from `registrarPago`'s response and written into the row; the screen does not
 * subtract the amount it just sent. Doing that here would mean two implementations of one
 * subtraction, and they would diverge the first time a credit sale was cancelled.
 *
 * WHAT IS NOT HERE, ON PURPOSE: editing a limit, editing a name, deleting a customer. Those are
 * `deudores.update` and `deudores.remove`, contract members with no handler in this build, and a
 * button that reliably fails when pressed is worse than no button.
 */

const PAGE_SIZE = 20;

/** The methods a PAYMENT can carry. `credito` is not one of them: paying a debt on credit is not a payment. */
const METODOS_PAGO_PAGO = [
  { value: "efectivo", label: "Efectivo" },
  { value: "tarjeta", label: "Tarjeta" },
  { value: "transferencia", label: "Transferencia" },
];

const METODO_LABEL = {
  efectivo: "Efectivo",
  tarjeta: "Tarjeta",
  transferencia: "Transferencia",
  mixto: "Mixto",
  credito: "Crédito",
};

const Deudores = () => {
  const [deudores, setDeudores] = useState([]);
  const [total, setTotal] = useState(0);
  const [pagina, setPagina] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [busquedaAplicada, setBusquedaAplicada] = useState("");
  const [soloConDeuda, setSoloConDeuda] = useState(false);
  const [seleccionado, setSeleccionado] = useState(null);
  const [nuevo, setNuevo] = useState(false);

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const res = await deudoresAPI.listar({
        limit: PAGE_SIZE,
        offset: pagina * PAGE_SIZE,
        search: busquedaAplicada || undefined,
        conDeuda: soloConDeuda || undefined,
      });
      setDeudores(Array.isArray(res?.filas) ? res.filas : []);
      setTotal(Number(res?.total) || 0);
    } catch (err) {
      // An empty list that says "nobody owes you anything" when the READ FAILED is a lie the
      // operator cannot detect, and this is the screen where that lie costs real money: they
      // would conclude every debt had been collected.
      setDeudores([]);
      setTotal(0);
      toast.error(`No se pudieron leer los deudores: ${mensajeDeError(err, "error desconocido")}`);
    } finally {
      setLoading(false);
    }
  }, [pagina, busquedaAplicada, soloConDeuda]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  /**
   * Any filter change goes back to page 0, for the reason `Ventas.jsx` records.
   *
   * TYPING AND SEARCHING ARE SEPARATE ON PURPOSE. The box only edits `search`; `busquedaAplicada`
   * — the string actually sent to the database — moves on Enter or on the button. A read per
   * keystroke would put a query in front of the operator on every character of a name, and the
   * results would flicker while they type.
   */
  const setFiltro = (patch) => {
    setPagina(0);
    if (patch.search !== undefined) setSearch(patch.search);
    if (patch.conDeuda !== undefined) setSoloConDeuda(patch.conDeuda);
    if (patch.aplicar) setBusquedaAplicada(patch.search ?? "");
  };

  const totalPaginas = Math.ceil(total / PAGE_SIZE);

  // What the shop is owed, over the page on screen. Labelled as a page total on purpose: it is
  // not the total the database holds, and a cashier comparing it against the receipt total would
  // be comparing two different numbers.
  const pendienteEnPantalla = useMemo(
    () => deudores.reduce((s, d) => s + (d.deudaPendienteCentavos ?? 0), 0),
    [deudores]
  );

  return (
    <div>
      <div className="table-container">
        <div className="table-header">
          <h3>Deudores {total > 0 ? <span className="tag">{total}</span> : null}</h3>
          <div className="actions">
            <input
              type="search"
              value={search}
              onChange={(e) => setFiltro({ search: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && setFiltro({ search, aplicar: true })}
              placeholder="Buscar por nombre o documento"
              aria-label="Buscar deudor"
            />
            <button
              type="button"
              onClick={() => setFiltro({ search, aplicar: true })}
              className="btn-secondary"
              disabled={loading}
            >
              <i className="fa-solid fa-magnifying-glass" aria-hidden="true"></i> Buscar
            </button>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={soloConDeuda}
                onChange={(e) => setFiltro({ conDeuda: e.target.checked })}
                data-testid="filtro-solo-con-deuda"
              />
              Solo con deuda
            </label>
            <button type="button" onClick={() => setNuevo(true)} className="btn-primary">
              <i className="fa-solid fa-user-plus" aria-hidden="true"></i> Nuevo cliente
            </button>
            <button type="button" onClick={cargar} className="btn-secondary" disabled={loading}>
              <i className="fa-solid fa-rotate" aria-hidden="true"></i> Actualizar
            </button>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Documento</th>
              <th style={{ textAlign: "right" }}>Deuda total</th>
              <th style={{ textAlign: "right" }}>Debe</th>
              <th style={{ textAlign: "right" }}>Limite</th>
              <th aria-label="Acciones"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", padding: 32, color: "var(--kanagawa-comment)" }}>
                  <i className="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Cargando...
                </td>
              </tr>
            ) : deudores.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", padding: 32, color: "var(--kanagawa-comment)" }}>
                  {busquedaAplicada || soloConDeuda
                    ? "Ningun cliente coincide con esa busqueda"
                    : "Todavia no hay clientes cargados"}
                </td>
              </tr>
            ) : (
              deudores.map((d) => {
                const debe = d.deudaPendienteCentavos ?? 0;
                const sinLimite = d.limiteCreditoCentavos == null;
                const excedido = !sinLimite && debe > d.limiteCreditoCentavos;
                return (
                  <tr key={d.id} data-testid={`fila-${d.id}`}>
                    <td>
                      <span style={{ fontWeight: 600 }}>{d.nombre}</span>
                    </td>
                    <td>{d.documento || "-"}</td>
                    <td style={{ textAlign: "right" }}>{formatCentavos(d.deudaTotalCentavos)}</td>
                    <td
                      style={{ textAlign: "right", fontWeight: 700, color: debe > 0 ? "var(--kanagawa-red)" : "var(--kanagawa-green)" }}
                      data-testid={`debe-${d.id}`}
                    >
                      {formatCentavos(debe)}
                    </td>
                    <td style={{ textAlign: "right", color: excedido ? "var(--kanagawa-red)" : undefined }}>
                      {sinLimite ? "sin limite" : formatCentavos(d.limiteCreditoCentavos)}
                    </td>
                    <td>
                      <button
                        type="button"
                        onClick={() => setSeleccionado(d)}
                        className={debe > 0 ? "btn-primary" : "btn-secondary"}
                        style={{ padding: "4px 10px" }}
                        data-testid={`cobrar-${d.id}`}
                        title={debe > 0 ? `Cobrar a ${d.nombre}` : `Ver la cuenta de ${d.nombre}`}
                        aria-label={debe > 0 ? `Cobrar a ${d.nombre}` : `Ver la cuenta de ${d.nombre}`}
                      >
                        <i className={`fa-solid ${debe > 0 ? "fa-hand-holding-dollar" : "fa-eye"}`} aria-hidden="true"></i>
                        {debe > 0 ? " Cobrar" : " Ver"}
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          {deudores.length > 0 ? (
            <tfoot>
              <tr>
                <td colSpan={3} style={{ textAlign: "right", fontWeight: 500, color: "var(--kanagawa-comment)" }}>
                  En esta pagina deben:
                </td>
                <td style={{ textAlign: "right", fontWeight: 700 }} data-testid="pendiente-pagina">
                  {formatCentavos(pendienteEnPantalla)}
                </td>
                <td colSpan={2}></td>
              </tr>
            </tfoot>
          ) : null}
        </table>

        {totalPaginas > 1 ? (
          <div className="mm-pager">
            <button
              type="button"
              onClick={() => setPagina((p) => Math.max(0, p - 1))}
              disabled={pagina === 0}
              className="btn-secondary"
              style={{ padding: "4px 12px", fontSize: 12 }}
            >
              <i className="fa-solid fa-chevron-left" aria-hidden="true"></i> Anterior
            </button>
            <span>Pagina {pagina + 1} de {totalPaginas}</span>
            <button
              type="button"
              onClick={() => setPagina((p) => Math.min(totalPaginas - 1, p + 1))}
              disabled={pagina >= totalPaginas - 1}
              className="btn-secondary"
              style={{ padding: "4px 12px", fontSize: 12 }}
            >
              Siguiente <i className="fa-solid fa-chevron-right" aria-hidden="true"></i>
            </button>
          </div>
        ) : null}
      </div>

      <Modal
        isOpen={!!seleccionado}
        onClose={() => setSeleccionado(null)}
        title={seleccionado ? `Cuenta corriente — ${seleccionado.nombre}` : ""}
        size="lg"
      >
        {seleccionado ? (
          <Cobro
            deudor={seleccionado}
            onCerrar={() => setSeleccionado(null)}
            onRegistrado={(actualizado) => {
              // The answer's `deudor` is the row read back through the view, inside the payment's
              // own transaction. It replaces the row here for the same reason the receipt uses it:
              // the screen and the database must show the same number.
              setSeleccionado(actualizado);
              cargar();
            }}
          />
        ) : null}
      </Modal>

      <Modal isOpen={nuevo} onClose={() => setNuevo(false)} title="Nuevo cliente">
        <FormularioCliente
          onCancelar={() => setNuevo(false)}
          onCreado={(creado) => {
            setNuevo(false);
            toast.success(`Cliente ${creado.nombre} agregado`);
            cargar();
          }}
        />
      </Modal>
    </div>
  );
};

/**
 * The account of one customer: what they owe, what they have paid, and the form that records the
 * next payment.
 *
 * The amount box is pre-filled with EXACTLY the pending balance, because "pay the whole thing" is
 * the common case and a cashier should not have to read the balance off one line and type it into
 * another. Editing it down is the partial payment, and the "Cancelar deuda" button next to it
 * shortens it to one keystroke. The figure is a string, converted once with the same `toCents`
 * the repository uses, so what is typed and what is stored cannot differ.
 */
const Cobro = ({ deudor, onCerrar, onRegistrado }) => {
  const [monto, setMonto] = useState(String((deudor.deudaPendienteCentavos ?? 0) / 100));
  const [metodoPago, setMetodoPago] = useState("efectivo");
  const [referencia, setReferencia] = useState("");
  const [observaciones, setObservaciones] = useState("");
  const [registrando, setRegistrando] = useState(false);
  const [error, setError] = useState("");
  const [pagos, setPagos] = useState(null);
  const [boleta, setBoleta] = useState(false);

  const pendiente = deudor.deudaPendienteCentavos ?? 0;

  // The history behind the number. A failure here is NOT fatal: the balance is what the operator
  // came for, and it is already on screen.
  useEffect(() => {
    let vigente = true;
    setPagos(null);
    deudoresAPI
      .pagos(deudor.id)
      .then((r) => {
        if (vigente) setPagos(Array.isArray(r?.pagos) ? r.pagos : []);
      })
      .catch(() => {
        if (vigente) setPagos([]);
      });
    return () => {
      vigente = false;
    };
  }, [deudor.id, pendiente]);

  // What the typed amount IS, in centavos, for the preview. `toCents` throws on a half-typed
  // "50." and a cashier mid-keystroke must not see a red error, so an unparseable string is
  // simply zero here and `puedeCobrar` is what refuses to send it.
  const centavos = useMemo(() => {
    try {
      return toCents(monto || "0", "monto");
    } catch {
      return 0;
    }
  }, [monto]);

  const puedeCobrar = pendiente > 0 && centavos >= 1 && centavos <= pendiente && !registrando;

  const registrar = async () => {
    if (!puedeCobrar) return;
    setRegistrando(true);
    setError("");
    try {
      const r = await deudoresAPI.registrarPago(deudor.id, {
        monto,
        metodoPago,
        referencia: referencia.trim() || undefined,
        observaciones: observaciones.trim() || undefined,
      });
      // The row that comes back is the one to keep. Refreshing the history from the same answer
      // would be nice, but the modal is redrawn by the parent with the new balances and the
      // effect above re-reads the payments — so the receipt the operator can open next has the
      // payment they just made at the top of the list.
      // `centavos` is the amount the operator typed, converted ONCE. The alternative —
      // `formatCentavos(cents)` — is a ReferenceError on a name that does not exist, thrown at the
      // exact moment the payment has already been committed: the money is in the drawer, the
      // drawer is reconciled, and the cashier is looking at a blank screen with no confirmation
      // and a dialog that will not tell them whether it went through. They will press the button
      // again. The first press is money collected once; the second is a second payment, and the
      // second one is refused only by the over-payment guard, which is the last place to catch it.
      onRegistrado(r.deudor);
      toast.success(
        r.pagadoCompleto
          ? `Deuda de ${r.deudor.nombre} saldada`
          : `Pago de ${formatCentavos(centavos)} registrado. Quedan ${formatCentavos(r.deudor.deudaPendienteCentavos)}`
      );
      // The box is refilled with whatever is now owed, so a second instalment is one click away
      // instead of a re-read of the balance.
      setMonto(String((r.deudor.deudaPendienteCentavos ?? 0) / 100));
      setReferencia("");
      setObservaciones("");
    } catch (err) {
      setError(mensajeDeError(err, "No se pudo registrar el pago"));
    } finally {
      setRegistrando(false);
    }
  };

  const totalPagado = useMemo(
    () => (pagos ?? []).reduce((s, p) => s + (p.montoCentavos ?? 0), 0),
    [pagos]
  );

  return (
    <div>
      <div className="mm-detail-grid" style={{ marginBottom: 14 }}>
        <div>
          <span>Deuda total</span>
          <div>{formatCentavos(deudor.deudaTotalCentavos)}</div>
        </div>
        <div>
          <span>Total pagado</span>
          <div data-testid="cobro-total-pagado">{formatCentavos(totalPagado)}</div>
        </div>
        <div>
          <span>Debe</span>
          <div
            style={{
              fontWeight: 700,
              color: pendiente > 0 ? "var(--kanagawa-red)" : "var(--kanagawa-green)",
            }}
            data-testid="cobro-pendiente"
          >
            {formatCentavos(pendiente)}
          </div>
        </div>
        <div>
          <span>Limite</span>
          <div>
            {deudor.limiteCreditoCentavos != null
              ? formatCentavos(deudor.limiteCreditoCentavos)
              : "sin limite"}
          </div>
        </div>
      </div>

      {pendiente > 0 ? (
        <>
          <div className="form-group">
            <label htmlFor="monto-pago">Monto a cobrar ($)</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                id="monto-pago"
                type="text"
                inputMode="decimal"
                value={monto}
                onChange={(e) => setMonto(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && registrar()}
                data-testid="monto-pago"
                aria-label="Monto a cobrar"
              />
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setMonto(String(pendiente / 100))}
                data-testid="cobrar-todo"
                title="Cobrar exactamente lo que debe"
              >
                Todo
              </button>
            </div>
            {centavos > 0 && centavos > pendiente ? (
              <p style={{ color: "var(--kanagawa-red)", fontSize: 12, margin: "6px 0 0" }} data-testid="pago-excede">
                Supera la deuda pendiente ({formatCentavos(pendiente)}). Una entrega mayor no se
                registra.
              </p>
            ) : null}
          </div>

          <div className="form-group">
            <label>Con que paga</label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {METODOS_PAGO_PAGO.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setMetodoPago(m.value)}
                  className={metodoPago === m.value ? "btn-primary" : "btn-secondary"}
                  style={{ fontSize: 12, padding: "6px 10px" }}
                  data-testid={`metodo-${m.value}`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {/* Says what each one does to the drawer, because the difference is invisible on a
                receipt and a cashier who assumes a card payment went into the till will count
                money that is not there. */}
            <p style={{ fontSize: 12, color: "var(--kanagawa-comment)", margin: "6px 0 0" }} data-testid="nota-metodo">
              {metodoPago === "efectivo"
                ? "Entra a la caja abierta y suma al total de ingresos del dia."
                : metodoPago === "tarjeta"
                  ? "Se registra contra Banco. La caja no se mueve: no hay efectivo fisico."
                  : "Se registra contra Banco. La caja no se mueve: no hay efectivo fisico."}
            </p>
          </div>

          <div className="form-group">
            <label htmlFor="ref-pago">Referencia (opcional)</label>
            <input
              id="ref-pago"
              type="text"
              value={referencia}
              onChange={(e) => setReferencia(e.target.value)}
              data-testid="referencia-pago"
              placeholder="Numero de recibo o nota"
            />
          </div>

          <div className="form-group">
            <label htmlFor="obs-pago">Observaciones (opcional)</label>
            <input
              id="obs-pago"
              type="text"
              value={observaciones}
              onChange={(e) => setObservaciones(e.target.value)}
              data-testid="observaciones-pago"
            />
          </div>

          {error ? (
            <p style={{ color: "var(--kanagawa-red)", fontSize: 13, margin: "0 0 10px" }} data-testid="error-pago">
              {error}
            </p>
          ) : null}

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn-success"
              onClick={registrar}
              disabled={!puedeCobrar}
              data-testid="confirmar-pago"
            >
              <i className="fa-solid fa-check" aria-hidden="true"></i>{" "}
              {registrando ? "Registrando..." : `Registrar pago de ${formatCentavos(Math.max(0, Math.min(centavos, pendiente)))}`}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setBoleta(true)}>
              <i className="fa-solid fa-receipt" aria-hidden="true"></i> Ver boleta
            </button>
          </div>
        </>
      ) : (
        <div
          style={{
            background: "var(--kanagawa-surface0)",
            borderRadius: 10,
            padding: 14,
            marginBottom: 12,
            fontWeight: 600,
            color: "var(--kanagawa-green)",
          }}
          data-testid="deuda-saldada"
        >
          <i className="fa-solid fa-circle-check" aria-hidden="true"></i> Esta cuenta corriente no
          debe nada.
        </div>
      )}

      <div style={{ borderTop: "1px solid var(--kanagawa-border)", paddingTop: 12, marginTop: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Pagos registrados</div>
          <button type="button" className="btn-secondary" onClick={() => setBoleta(true)}>
            <i className="fa-solid fa-print" aria-hidden="true"></i> Boleta
          </button>
        </div>
        {pagos === null ? (
          <p style={{ color: "var(--kanagawa-comment)" }}>
            <i className="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Cargando pagos...
          </p>
        ) : pagos.length === 0 ? (
          <p style={{ color: "var(--kanagawa-comment)" }} data-testid="sin-pagos">
            Todavia no registro pagos.
          </p>
        ) : (
          <table data-testid="tabla-pagos">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Metodo</th>
                <th>Referencia</th>
                <th style={{ textAlign: "right" }}>Monto</th>
              </tr>
            </thead>
            <tbody>
              {pagos.map((p) => (
                <tr key={p.id}>
                  <td>{formatDate(p.fecha)}</td>
                  <td>{METODO_LABEL[p.metodoPago] || p.metodoPago || "-"}</td>
                  <td>{p.referencia || "-"}</td>
                  <td style={{ textAlign: "right", fontWeight: 600 }}>{formatCentavos(p.montoCentavos)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
        <button type="button" className="btn-secondary" onClick={onCerrar}>
          Cerrar
        </button>
      </div>

      {boleta ? (
        <Modal isOpen onClose={() => setBoleta(false)} title="Boleta de pago" size="md">
          <BoletaPago deudor={deudor} pagos={pagos ?? []} onClose={() => setBoleta(false)} />
        </Modal>
      ) : null}
    </div>
  );
};

/**
 * Add a customer. A credit sale needs somebody to bill and the first launch seeds no demo
 * customers on purpose, so without this a brand-new shop can only sell for cash.
 *
 * The document is optional and the limit is optional, and the two are validated here rather than
 * by a schema CHECK, because both are things a person typed: a duplicate document is a 400 with
 * a sentence the operator can act on (`deudores.crear` catches the unique index), and a negative
 * limit is a 400 with the number in it rather than a SQLite constraint name.
 */
const FormularioCliente = ({ onCancelar, onCreado }) => {
  const [form, setForm] = useState({
    nombre: "",
    documento: "",
    telefono: "",
    limiteCredito: "",
  });
  const [error, setError] = useState("");
  const [guardando, setGuardando] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const guardar = async () => {
    if (form.nombre.trim() === "" || guardando) return;
    setGuardando(true);
    setError("");
    try {
      const creado = await deudoresAPI.crear({
        nombre: form.nombre.trim(),
        documento: form.documento.trim() || undefined,
        telefono: form.telefono.trim() || undefined,
        limiteCredito: form.limiteCredito.trim() || undefined,
      });
      onCreado(creado);
    } catch (err) {
      setError(mensajeDeError(err, "No se pudo guardar el cliente"));
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div>
      <div className="form-group">
        <label htmlFor="cli-nombre">Nombre y apellido *</label>
        <input
          id="cli-nombre"
          type="text"
          value={form.nombre}
          onChange={set("nombre")}
          onKeyDown={(e) => e.key === "Enter" && guardar()}
          data-testid="cli-nombre"
          autoFocus
        />
      </div>
      <div className="form-group">
        <label htmlFor="cli-doc">Documento</label>
        <input id="cli-doc" type="text" value={form.documento} onChange={set("documento")} data-testid="cli-documento" />
        <p style={{ fontSize: 12, color: "var(--kanagawa-comment)", margin: "4px 0 0" }}>
          Si lo cargás, no se puede repetir en esta tienda.
        </p>
      </div>
      <div className="form-group">
        <label htmlFor="cli-tel">Telefono</label>
        <input id="cli-tel" type="text" value={form.telefono} onChange={set("telefono")} data-testid="cli-telefono" />
      </div>
      <div className="form-group">
        <label htmlFor="cli-limite">Limite de credito ($)</label>
        <input
          id="cli-limite"
          type="text"
          inputMode="decimal"
          value={form.limiteCredito}
          onChange={set("limiteCredito")}
          placeholder="Sin limite"
          data-testid="cli-limite"
        />
        <p style={{ fontSize: 12, color: "var(--kanagawa-comment)", margin: "4px 0 0" }}>
          Vacio = sin tope. El POS avisa cuando una venta a credito deja al cliente por encima.
        </p>
      </div>
      {error ? (
        <p style={{ color: "var(--kanagawa-red)", fontSize: 13 }} data-testid="error-cliente">
          {error}
        </p>
      ) : null}
      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        <button type="button" className="btn-secondary" onClick={onCancelar} disabled={guardando}>
          Cancelar
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={guardar}
          disabled={form.nombre.trim() === "" || guardando}
          data-testid="guardar-cliente"
        >
          {guardando ? "Guardando..." : "Guardar cliente"}
        </button>
      </div>
    </div>
  );
};

export default Deudores;
