import React, { useCallback, useEffect, useState } from "react";
import { contabilidadAPI } from "../../api/contabilidad";
import { mensajeDeError } from "../../api/ipc";
import { toast } from "react-toastify";
import { formatCentavos, formatDate } from "../../utils/formatters";
import Modal from "../../components/common/Modal";

/**
 * Deudas del negocio — lo que la tienda DEBE, que no es lo que le deben.
 *
 * ── THE CONFUSION THIS SCREEN EXISTS TO PREVENT ───────────────────────────────────────────────
 *
 * `Deudores` (the other screen) is what customers owe the SHOP: money coming in, an asset. This is
 * what the shop owes a bank, MercadoPago or a supplier: money going out, a liability. They are
 * opposites, and "deuda" alone is ambiguous in the vocabulary a shopkeeper uses — so the heading
 * says which direction the money moves instead of leaving the reader to work it out from a sign.
 *
 * ── WHY THE PAYMENT FORM SHOWS THE REMAINING BALANCE FIRST ────────────────────────────────────
 *
 * Because overpaying is REFUSED by the repository, and the amount a person may not exceed is the
 * one number they need before typing. It is also the number the form cannot compute for itself
 * after a payment lands: `registrarPagoDeuda` answers with the debt AS IT NOW STANDS, read from the
 * same transaction, and the screen shows that rather than subtracting on its own. A screen that did
 * its own subtraction would be wrong the first time two payments raced.
 *
 * ── WHY `pagado` IS NOT OFFERED AS A STATUS TO PICK ───────────────────────────────────────────
 *
 * A debt with nothing left to pay BECOMES `pagado`: `registrarPagoDeuda` sets it when the balance
 * reaches zero. The status field exists for the two states the app cannot infer — `activo` and
 * `vencido` — because nothing here knows the agreed schedule. Letting a person mark a debt paid by
 * hand would let a shop declare a debt settled without recording that any money moved.
 */

const PAGE_SIZE = 20;

const TIPOS = [
  { value: "prestamo_bancario", label: "Préstamo bancario" },
  { value: "prestamo_mp", label: "Préstamo MercadoPago" },
  { value: "prestamo_personal", label: "Préstamo personal" },
  { value: "proveedor", label: "Proveedor" },
  { value: "otro", label: "Otro" }
];

const ETIQUETA_TIPO = Object.fromEntries(TIPOS.map((t) => [t.value, t.label]));

const METODOS = [
  { value: "efectivo", label: "Efectivo" },
  { value: "transferencia", label: "Transferencia" },
  { value: "tarjeta", label: "Tarjeta" }
];

const VACIO = {
  nombre: "",
  tipo: "prestamo_bancario",
  montoOriginal: "",
  tasaInteres: "",
  cuotasTotales: "",
  montoCuota: "",
  fechaInicio: new Date().toISOString().slice(0, 10),
  fechaVencimiento: "",
  estado: "activo",
  contactoNombre: "",
  contactoTelefono: "",
  notas: ""
};

const Deudas = () => {
  const [filas, setFilas] = useState([]);
  const [total, setTotal] = useState(0);
  const [pagina, setPagina] = useState(0);
  const [search, setSearch] = useState("");
  const [estadoFiltro, setEstadoFiltro] = useState("");
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [guardando, setGuardando] = useState(false);
  const [cobrando, setCobrando] = useState(null);
  const [montoPago, setMontoPago] = useState("");
  const [metodoPago, setMetodoPago] = useState("efectivo");
  const [pagando, setPagando] = useState(false);
  const [historial, setHistorial] = useState(null);

  const cargar = useCallback(
    async ({ suprimeCargando = false } = {}) => {
      if (!suprimeCargando) setLoading(true);
      try {
        const res = await contabilidadAPI.listarDeudas({
          search,
          estado: estadoFiltro,
          limit: PAGE_SIZE,
          offset: pagina * PAGE_SIZE
        });
        setFilas(res.filas ?? []);
        setTotal(res.total ?? 0);
      } catch (err) {
        toast.error(mensajeDeError(err, "No se pudieron cargar las deudas"));
      } finally {
        setLoading(false);
      }
    },
    [search, estadoFiltro, pagina]
  );

  useEffect(() => {
    cargar();
  }, [cargar]);

  useEffect(() => {
    setPagina(0);
  }, [search, estadoFiltro]);

  const guardar = async (evento) => {
    evento.preventDefault();
    setGuardando(true);
    try {
      if (form.id) {
        await contabilidadAPI.actualizarDeuda(form.id, {
          nombre: form.nombre,
          tipo: form.tipo,
          tasaInteres: form.tasaInteres,
          cuotasTotales: form.cuotasTotales,
          montoCuota: form.montoCuota,
          fechaVencimiento: form.fechaVencimiento,
          // `pagado` is never sent from here: the balance decides it. See the file header.
          estado: form.estado === "pagado" ? "vencido" : form.estado,
          contactoNombre: form.contactoNombre,
          contactoTelefono: form.contactoTelefono,
          notas: form.notas
        });
        toast.success(`"${form.nombre}" actualizada`);
      } else {
        await contabilidadAPI.crearDeuda({
          nombre: form.nombre,
          tipo: form.tipo,
          montoOriginal: form.montoOriginal,
          tasaInteres: form.tasaInteres,
          cuotasTotales: form.cuotasTotales,
          montoCuota: form.montoCuota,
          fechaInicio: form.fechaInicio,
          fechaVencimiento: form.fechaVencimiento,
          contactoNombre: form.contactoNombre,
          contactoTelefono: form.contactoTelefono,
          notas: form.notas
        });
        toast.success(`"${form.nombre}" cargada`);
      }
      setForm(null);
      await cargar({ suprimeCargando: true });
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudo guardar la deuda"), { autoClose: 9000 });
    } finally {
      setGuardando(false);
    }
  };

  const abrirPago = (d) => {
    setCobrando(d);
    // The whole remaining balance is the common case for a shop paying off a loan instalment, and
    // it is also the maximum the repository accepts, so the field starts there.
    setMontoPago("");
    setMetodoPago("efectivo");
  };

  const pagar = async (evento) => {
    evento.preventDefault();
    setPagando(true);
    try {
      const res = await contabilidadAPI.registrarPagoDeuda({
        deudaId: cobrando.id,
        monto: montoPago,
        metodoPago
      });
      // The answer carries the debt AS IT NOW STANDS, read from the same transaction that wrote the
      // payment. The screen shows that number instead of subtracting one of its own.
      toast.success(
        `Pago registrado. Queda ${formatCentavos(res.deuda.saldoPendienteCentavos)} pendiente.`
      );
      if (res.deuda.estado === "pagado") {
        toast.info(`"${res.deuda.nombre}" quedó saldada.`, { autoClose: 7000 });
      }
      setCobrando(null);
      await cargar({ suprimeCargando: true });
    } catch (err) {
      // `PAGO_EXCEDE_SALDO` names the remaining amount, which is the number the operator needs.
      toast.error(mensajeDeError(err, "No se pudo registrar el pago"), { autoClose: 9000 });
    } finally {
      setPagando(false);
    }
  };

  const verHistorial = async (d) => {
    try {
      setHistorial({ deuda: d, pagos: await contabilidadAPI.listarPagosDeuda(d.id) });
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudo leer el historial"));
    }
  };

  const paginas = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className="bar">
        <h2>Deudas del negocio</h2>
        <div className="bar">
          <input
            className="filter-input"
            type="search"
            placeholder="Buscar por nombre o contacto"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Buscar deuda"
          />
          <select
            className="filter-input"
            value={estadoFiltro}
            onChange={(e) => setEstadoFiltro(e.target.value)}
            aria-label="Filtrar por estado"
          >
            <option value="">Todos los estados</option>
            <option value="activo">Activas</option>
            <option value="vencido">Vencidas</option>
            <option value="pagado">Pagadas</option>
          </select>
          <button
            className="btn-primary"
            onClick={() => setForm({ ...VACIO })}
            data-testid="nueva-deuda"
          >
            <i className="fa-solid fa-plus" aria-hidden="true"></i> Nueva deuda
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: "var(--kanagawa-fg-muted)", margin: 0 }}>
          Acá va lo que <strong>la tienda debe</strong>: un préstamo, el banco, MercadoPago, un
          proveedor. Lo que le deben los clientes está en <strong>Deudores</strong>, que es lo
          contrario.
        </p>
      </div>

      {loading ? (
        <p>Cargando deudas…</p>
      ) : filas.length === 0 ? (
        <div className="card">
          <p>
            {search || estadoFiltro
              ? "Ninguna deuda coincide con el filtro."
              : "No hay deudas cargadas. Si la tienda no debe nada, está bien que esta lista esté vacía."}
          </p>
        </div>
      ) : (
        <div className="table-container">
          <table className="product-list">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Tipo</th>
                <th style={{ textAlign: "right" }}>Original</th>
                <th style={{ textAlign: "right" }}>Pendiente</th>
                <th style={{ width: 120 }}>Avance</th>
                <th>Vence</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filas.map((d) => (
                <tr key={d.id} style={d.estado === "pagado" ? { opacity: 0.6 } : undefined}>
                  <td>
                    {d.nombre}
                    {d.contactoNombre ? (
                      <div style={{ fontSize: 12, color: "var(--kanagawa-fg-muted)" }}>
                        {d.contactoNombre}
                        {d.contactoTelefono ? ` · ${d.contactoTelefono}` : ""}
                      </div>
                    ) : null}
                  </td>
                  <td>{ETIQUETA_TIPO[d.tipo] ?? d.tipo}</td>
                  <td style={{ textAlign: "right" }}>{formatCentavos(d.montoOriginalCentavos)}</td>
                  <td
                    style={{
                      textAlign: "right",
                      fontWeight: 600,
                      color: d.saldoPendienteCentavos > 0 ? "var(--kanagawa-orange)" : undefined
                    }}
                  >
                    {formatCentavos(d.saldoPendienteCentavos)}
                  </td>
                  <td>
                    {/* A bar, because the number that matters here is "how far along am I" and a
                        percentage is read faster than two amounts side by side. */}
                    <div
                      style={{
                        background: "var(--kanagawa-surface0)",
                        borderRadius: 4,
                        height: 8,
                        overflow: "hidden"
                      }}
                      title={`${d.porcentajePagado}% pagado`}
                    >
                      <div
                        style={{
                          width: `${d.porcentajePagado}%`,
                          height: "100%",
                          background:
                            d.porcentajePagado >= 100
                              ? "var(--kanagawa-green)"
                              : "var(--kanagawa-blue)"
                        }}
                      />
                    </div>
                    <div style={{ fontSize: 11, color: "var(--kanagawa-fg-muted)" }}>
                      {d.porcentajePagado}%
                      {d.cuotasTotales ? ` · ${d.cuotasPagadas}/${d.cuotasTotales} cuotas` : ""}
                    </div>
                  </td>
                  <td>{d.fechaVencimiento ? formatDate(d.fechaVencimiento) : "—"}</td>
                  <td>
                    <span
                      className={`status ${
                        d.estado === "pagado"
                          ? "active-s"
                          : d.estado === "vencido"
                            ? "cancelled"
                            : "pending"
                      }`}
                    >
                      {d.estado === "pagado"
                        ? "Pagada"
                        : d.estado === "vencido"
                          ? "Vencida"
                          : "Activa"}
                    </span>
                  </td>
                  <td>
                    <button
                      className="btn-primary"
                      onClick={() => abrirPago(d)}
                      disabled={d.saldoPendienteCentavos === 0}
                      title={
                        d.saldoPendienteCentavos === 0
                          ? "Esta deuda ya está saldada"
                          : `Pagar sobre ${formatCentavos(d.saldoPendienteCentavos)}`
                      }
                      data-testid={`pagar-deuda-${d.id}`}
                    >
                      Pagar
                    </button>{" "}
                    <button className="btn-secondary" onClick={() => verHistorial(d)}>
                      Pagos
                    </button>{" "}
                    <button className="btn-secondary" onClick={() => setForm({ ...VACIO, ...d })}>
                      Editar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {paginas > 1 ? (
        <div className="mm-pager">
          <button
            className="btn-secondary"
            disabled={pagina === 0}
            onClick={() => setPagina((p) => p - 1)}
          >
            Anterior
          </button>
          <span>
            Página {pagina + 1} de {paginas} · {total} deudas
          </span>
          <button
            className="btn-secondary"
            disabled={pagina + 1 >= paginas}
            onClick={() => setPagina((p) => p + 1)}
          >
            Siguiente
          </button>
        </div>
      ) : null}

      {cobrando ? (
        <Modal
          isOpen
          onClose={() => setCobrando(null)}
          title={`Pagar ${cobrando.nombre}`}
          size="sm"
        >
          <p style={{ marginTop: 0 }}>
            Saldo pendiente: <strong>{formatCentavos(cobrando.saldoPendienteCentavos)}</strong>
          </p>
          <form onSubmit={pagar}>
            <div className="form-group">
              <label htmlFor="pago-monto">Monto a pagar *</label>
              <input
                id="pago-monto"
                className="input-field"
                inputMode="decimal"
                value={montoPago}
                onChange={(e) => setMontoPago(e.target.value)}
                placeholder="0.00"
                required
                autoFocus
                data-testid="monto-pago"
              />
              {/* The maximum, one click away. Typing a peso over the balance is the mistake the
                  repository refuses by name, and offering the exact figure is cheaper than reading
                  the refusal. */}
              <button
                type="button"
                className="btn-secondary"
                style={{ marginTop: 6 }}
                onClick={() => setMontoPago(String(cobrando.saldoPendienteCentavos / 100))}
              >
                Pagar todo ({formatCentavos(cobrando.saldoPendienteCentavos)})
              </button>
            </div>
            <div className="form-group">
              <label htmlFor="pago-metodo">Método</label>
              <select
                id="pago-metodo"
                className="input-field"
                value={metodoPago}
                onChange={(e) => setMetodoPago(e.target.value)}
              >
                {METODOS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <button
                type="submit"
                className="btn-primary"
                disabled={pagando}
                data-testid="confirmar-pago-deuda"
              >
                {pagando ? "Registrando…" : "Registrar pago"}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setCobrando(null)}>
                Cancelar
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {historial ? (
        <Modal
          isOpen
          onClose={() => setHistorial(null)}
          title={`Pagos de ${historial.deuda.nombre}`}
        >
          {historial.pagos.length === 0 ? (
            <p>Todavía no hay pagos registrados de esta deuda.</p>
          ) : (
            <table className="product-list">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Método</th>
                  <th>Cuota</th>
                  <th style={{ textAlign: "right" }}>Monto</th>
                </tr>
              </thead>
              <tbody>
                {historial.pagos.map((p) => (
                  <tr key={p.id}>
                    <td>{formatDate(p.fecha)}</td>
                    <td>{p.metodoPago}</td>
                    <td>{p.numeroCuota ?? "—"}</td>
                    <td style={{ textAlign: "right" }}>{formatCentavos(p.montoCentavos)}</td>
                  </tr>
                ))}
                <tr style={{ fontWeight: 700 }}>
                  <td colSpan={3} style={{ textAlign: "right" }}>
                    Total pagado
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {formatCentavos(historial.pagos.reduce((s, p) => s + p.montoCentavos, 0))}
                  </td>
                </tr>
              </tbody>
            </table>
          )}
          <div className="form-row" style={{ marginTop: 16 }}>
            <button className="btn-secondary" onClick={() => setHistorial(null)}>
              Cerrar
            </button>
          </div>
        </Modal>
      ) : null}

      {form ? (
        <Modal
          isOpen
          onClose={() => setForm(null)}
          title={form.id ? `Editar ${form.nombre}` : "Nueva deuda"}
          size="lg"
        >
          <form onSubmit={guardar}>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="deu-nombre">Nombre *</label>
                <input
                  id="deu-nombre"
                  className="input-field"
                  value={form.nombre}
                  onChange={(e) => setForm({ ...form, nombre: e.target.value })}
                  placeholder="Préstamo Banco Nación"
                  required
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label htmlFor="deu-tipo">Tipo</label>
                <select
                  id="deu-tipo"
                  className="input-field"
                  value={form.tipo}
                  onChange={(e) => setForm({ ...form, tipo: e.target.value })}
                >
                  {TIPOS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="deu-monto">Monto original *</label>
                <input
                  id="deu-monto"
                  className="input-field"
                  inputMode="decimal"
                  value={form.montoOriginal}
                  onChange={(e) => setForm({ ...form, montoOriginal: e.target.value })}
                  placeholder="0.00"
                  required
                  // The original amount is what the debt WAS. Editing it after payments would make
                  // the percentage paid a different claim, so it is fixed once the debt exists.
                  disabled={Boolean(form.id)}
                  title={form.id ? "El monto original no se edita: el saldo lo mueven los pagos" : undefined}
                />
              </div>
              <div className="form-group">
                <label htmlFor="deu-tasa">Tasa de interés (%)</label>
                <input
                  id="deu-tasa"
                  className="input-field"
                  inputMode="decimal"
                  value={form.tasaInteres}
                  onChange={(e) => setForm({ ...form, tasaInteres: e.target.value })}
                  placeholder="Sin interés"
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="deu-cuotas">Cuotas totales</label>
                <input
                  id="deu-cuotas"
                  className="input-field"
                  inputMode="numeric"
                  value={form.cuotasTotales}
                  onChange={(e) => setForm({ ...form, cuotasTotales: e.target.value })}
                  placeholder="Sin plan"
                />
              </div>
              <div className="form-group">
                <label htmlFor="deu-cuota-monto">Monto por cuota</label>
                <input
                  id="deu-cuota-monto"
                  className="input-field"
                  inputMode="decimal"
                  value={form.montoCuota}
                  onChange={(e) => setForm({ ...form, montoCuota: e.target.value })}
                  placeholder="0.00"
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="deu-inicio">Fecha de inicio</label>
                <input
                  id="deu-inicio"
                  className="input-field"
                  type="date"
                  value={form.fechaInicio}
                  onChange={(e) => setForm({ ...form, fechaInicio: e.target.value })}
                  disabled={Boolean(form.id)}
                />
              </div>
              <div className="form-group">
                <label htmlFor="deu-vencimiento">Vencimiento</label>
                <input
                  id="deu-vencimiento"
                  className="input-field"
                  type="date"
                  value={form.fechaVencimiento ?? ""}
                  onChange={(e) => setForm({ ...form, fechaVencimiento: e.target.value })}
                />
              </div>
              {form.id ? (
                <div className="form-group">
                  <label htmlFor="deu-estado">Estado</label>
                  <select
                    id="deu-estado"
                    className="input-field"
                    value={form.estado}
                    onChange={(e) => setForm({ ...form, estado: e.target.value })}
                  >
                    <option value="activo">Activa</option>
                    <option value="vencido">Vencida</option>
                    {form.estado === "pagado" ? <option value="pagado">Pagada</option> : null}
                  </select>
                </div>
              ) : null}
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="deu-contacto">Contacto</label>
                <input
                  id="deu-contacto"
                  className="input-field"
                  value={form.contactoNombre ?? ""}
                  onChange={(e) => setForm({ ...form, contactoNombre: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label htmlFor="deu-telefono">Teléfono</label>
                <input
                  id="deu-telefono"
                  className="input-field"
                  value={form.contactoTelefono ?? ""}
                  onChange={(e) => setForm({ ...form, contactoTelefono: e.target.value })}
                />
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="deu-notas">Notas</label>
              <textarea
                id="deu-notas"
                className="input-field"
                rows={2}
                value={form.notas ?? ""}
                onChange={(e) => setForm({ ...form, notas: e.target.value })}
              />
            </div>

            {form.id ? (
              <p style={{ fontSize: 12, color: "var(--kanagawa-fg-muted)" }}>
                El saldo pendiente no se edita a mano: lo mueven los pagos. Estado actual:{" "}
                <strong>{formatCentavos(form.saldoPendienteCentavos ?? 0)}</strong> pendiente.
              </p>
            ) : null}

            <div className="form-row">
              <button
                type="submit"
                className="btn-primary"
                disabled={guardando}
                data-testid="guardar-deuda"
              >
                {guardando ? "Guardando…" : "Guardar"}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setForm(null)}>
                Cancelar
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
};

export default Deudas;
