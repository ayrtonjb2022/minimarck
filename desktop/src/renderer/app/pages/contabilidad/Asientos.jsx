import React, { useCallback, useEffect, useMemo, useState } from "react";
import { contabilidadAPI } from "../../api/contabilidad";
import { mensajeDeError } from "../../api/ipc";
import { toast } from "react-toastify";
import { formatCentavos, formatDate } from "../../utils/formatters";
import Modal from "../../components/common/Modal";

/**
 * El libro diario — every entry, and the form that writes one by hand.
 *
 * ── WHAT A HAND-WRITTEN ENTRY IS FOR ──────────────────────────────────────────────────────────
 *
 * Sales, purchases, debtor payments and till movements all write their own entries, automatically,
 * inside their own transaction. What no feature can write is the things only a person knows: the
 * owner put money in, a debt was forgiven, a mistake from last month needs correcting. Those are
 * adjustments, and without this form they had nowhere to go — the shop carried a ledger it could
 * not add a line to.
 *
 * ── WHY THE FORM SHOWS THE BALANCE WHILE YOU TYPE ─────────────────────────────────────────────
 *
 * Because an unbalanced entry is REFUSED, and finding that out only after pressing Guardar is how
 * an operator loses a five-line entry they just typed. The running total is not the check — main
 * owns the check, and it throws before the first INSERT — it is the feedback that stops the
 * refusal from being a surprise. The two agree because both compare the same two sums.
 *
 * ── WHY `Guardar` IS DISABLED UNTIL IT BALANCES ───────────────────────────────────────────────
 *
 * Enabling the button and letting the server refuse would be equally correct and worse to use: a
 * red toast that says "debe 5000 != haber 3000" is the same sentence the total in the form already
 * shows, arriving later. The button is a convenience on top of the rule, never a replacement for it.
 */

const PAGE_SIZE = 20;

const TIPOS = [
  { value: "ajuste", label: "Ajuste" },
  { value: "apertura", label: "Apertura" },
  { value: "ingreso", label: "Ingreso" },
  { value: "egreso", label: "Egreso" }
];

const ETIQUETA_TIPO = Object.fromEntries(TIPOS.map((t) => [t.value, t.label]));

/** One blank partida. Two of them are the minimum a balanced entry can have. */
const partidaVacia = () => ({ cuentaId: "", debe: "", haber: "", descripcion: "" });

const FORM_VACIO = () => ({
  fecha: new Date().toISOString().slice(0, 10),
  descripcion: "",
  tipo: "ajuste",
  referencia: "",
  partidas: [partidaVacia(), partidaVacia()]
});

/**
 * Pesos typed by a person to centavos, for the running total ONLY.
 *
 * `toCents` is the authority and it lives in `shared/money.js`, which main uses to parse what the
 * form sends. This local reading exists so the total updates as the operator types, and it is
 * deliberately naive: a value it cannot read counts as zero and the total is briefly wrong, which
 * is harmless because the real parse happens in main and refuses rather than guesses.
 */
const aCentavos = (texto) => {
  const t = String(texto ?? "").trim().replace(",", ".");
  if (t === "") return 0;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

const Asientos = ({ cuentas, cargandoCuentas }) => {
  const [filas, setFilas] = useState([]);
  const [total, setTotal] = useState(0);
  const [pagina, setPagina] = useState(0);
  const [search, setSearch] = useState("");
  const [tipoFiltro, setTipoFiltro] = useState("");
  const [loading, setLoading] = useState(true);
  const [detalle, setDetalle] = useState(null);
  const [form, setForm] = useState(null);
  const [guardando, setGuardando] = useState(false);
  const [porEliminar, setPorEliminar] = useState(null);
  const [eliminando, setEliminando] = useState(false);

  const cargar = useCallback(
    async ({ suprimeCargando = false } = {}) => {
      if (!suprimeCargando) setLoading(true);
      try {
        const res = await contabilidadAPI.listarAsientos({
          search,
          tipo: tipoFiltro,
          limit: PAGE_SIZE,
          offset: pagina * PAGE_SIZE
        });
        setFilas(res.filas ?? []);
        setTotal(res.total ?? 0);
      } catch (err) {
        toast.error(mensajeDeError(err, "No se pudo leer el libro diario"));
      } finally {
        setLoading(false);
      }
    },
    [search, tipoFiltro, pagina]
  );

  useEffect(() => {
    cargar();
  }, [cargar]);

  // The page resets when a filter changes and not when the page itself does, or "Siguiente" would
  // bounce back to page 1. Same rule as every other paged list in this app.
  useEffect(() => {
    setPagina(0);
  }, [search, tipoFiltro]);

  const cuentasActivas = useMemo(
    () => (cuentas ?? []).filter((c) => c.activo),
    [cuentas]
  );

  const totales = useMemo(() => {
    if (!form) return { debe: 0, haber: 0, diferencia: 0 };
    const debe = form.partidas.reduce((s, p) => s + aCentavos(p.debe), 0);
    const haber = form.partidas.reduce((s, p) => s + aCentavos(p.haber), 0);
    return { debe, haber, diferencia: debe - haber };
  }, [form]);

  /**
   * A partida is only sent when the operator touched it. A row left blank would otherwise arrive as
   * `{cuentaId: '', debe: 0, haber: 0}` and main would refuse the whole entry for a reason the
   * operator cannot see — the row looks fine on screen because it is empty.
   */
  const partidasValidas = (p) =>
    p.cuentaId !== "" && (aCentavos(p.debe) !== 0 || aCentavos(p.haber) !== 0);

  const abrirNuevo = () => setForm(FORM_VACIO());

  const setPartida = (indice, cambios) => {
    setForm((f) => ({
      ...f,
      partidas: f.partidas.map((p, i) => (i === indice ? { ...p, ...cambios } : p))
    }));
  };

  const agregarPartida = () => setForm((f) => ({ ...f, partidas: [...f.partidas, partidaVacia()] }));
  const quitarPartida = (indice) =>
    setForm((f) => ({ ...f, partidas: f.partidas.filter((_, i) => i !== indice) }));

  const guardar = async (evento) => {
    evento.preventDefault();
    setGuardando(true);
    try {
      await contabilidadAPI.crearAsiento({
        fecha: form.fecha,
        descripcion: form.descripcion,
        tipo: form.tipo,
        referencia: form.referencia,
        // Amounts go out as the STRINGS the operator typed; main parses them with `toCents`. A form
        // that had already multiplied by 100 would be a form that had already made the arithmetic
        // decision that belongs to one module.
        partidas: form.partidas.filter(partidasValidas).map((p) => ({
          cuentaId: p.cuentaId,
          debe: p.debe,
          haber: p.haber,
          descripcion: p.descripcion
        }))
      });
      toast.success("Asiento registrado");
      setForm(null);
      await cargar({ suprimeCargando: true });
    } catch (err) {
      // The repository's own sentence, which names the problem: `ASIENTO_DESBALANCEADO` says by how
      // much, `ASIENTO_PARTIDA_DOBLE` names the line. Replacing it would throw away the only part
      // the operator can act on.
      toast.error(mensajeDeError(err, "No se pudo registrar el asiento"), { autoClose: 9000 });
    } finally {
      setGuardando(false);
    }
  };

  const verDetalle = async (a) => {
    try {
      setDetalle(await contabilidadAPI.obtenerAsiento(a.id));
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudo abrir el asiento"));
    }
  };

  const eliminar = async () => {
    if (!porEliminar) return;
    setEliminando(true);
    try {
      await contabilidadAPI.eliminarAsiento(porEliminar.id);
      toast.success("Asiento eliminado");
      setPorEliminar(null);
      await cargar({ suprimeCargando: true });
    } catch (err) {
      // The normal refusal here is `ASIENTO_DE_SISTEMA`: the entry was written by a sale or a
      // purchase, and its message already says to cancel that operation instead.
      toast.error(mensajeDeError(err, "No se pudo eliminar el asiento"), { autoClose: 9000 });
      setPorEliminar(null);
    } finally {
      setEliminando(false);
    }
  };

  const paginas = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const puedeGuardar = totales.diferencia === 0 && totales.debe > 0 && form?.descripcion?.trim();

  return (
    <div>
      <div className="bar">
        <h2>Libro diario</h2>
        <div className="bar">
          <input
            className="filter-input"
            type="search"
            placeholder="Buscar por descripción o referencia"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Buscar asiento"
          />
          <select
            className="filter-input"
            value={tipoFiltro}
            onChange={(e) => setTipoFiltro(e.target.value)}
            aria-label="Filtrar por tipo"
          >
            <option value="">Todos los tipos</option>
            {TIPOS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <button
            className="btn-primary"
            onClick={abrirNuevo}
            disabled={cargandoCuentas || cuentasActivas.length === 0}
            title={
              cuentasActivas.length === 0
                ? "Necesitás al menos una cuenta activa para escribir un asiento"
                : undefined
            }
            data-testid="nuevo-asiento"
          >
            <i className="fa-solid fa-plus" aria-hidden="true"></i> Nuevo asiento
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: "var(--kanagawa-fg-muted)", margin: 0 }}>
          Las ventas, las compras, los cobros y los movimientos de caja escriben su asiento solos.
          Acá se cargan los que sólo sabe una persona: un aporte del dueño, una corrección, una
          apertura. Un asiento que no balancea no se guarda.
        </p>
      </div>

      {loading ? (
        <p>Cargando asientos…</p>
      ) : filas.length === 0 ? (
        <div className="card">
          <p>
            {search || tipoFiltro
              ? "Ningún asiento coincide con el filtro."
              : "Todavía no hay asientos. Se escriben solos con la primera venta, o a mano con «Nuevo asiento»."}
          </p>
        </div>
      ) : (
        <div className="table-container">
          <table className="product-list">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Descripción</th>
                <th>Tipo</th>
                <th>Referencia</th>
                <th style={{ textAlign: "right" }}>Partidas</th>
                <th style={{ textAlign: "right" }}>Monto</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filas.map((a) => (
                <tr key={a.id}>
                  <td>{formatDate(a.fecha)}</td>
                  <td>{a.descripcion}</td>
                  <td>{ETIQUETA_TIPO[a.tipo] ?? a.tipo}</td>
                  <td style={{ fontFamily: "monospace", fontSize: 12 }}>{a.referencia ?? "—"}</td>
                  <td style={{ textAlign: "right" }}>{a.partidas}</td>
                  <td style={{ textAlign: "right" }}>{formatCentavos(a.montoTotalCentavos)}</td>
                  <td>
                    <button className="btn-secondary" onClick={() => verDetalle(a)}>
                      Ver
                    </button>{" "}
                    {/* An entry a feature wrote is refused by the repository. Hiding the button
                        would be a screen that lies about what is possible; leaving it visible and
                        letting the refusal explain is the honest version. */}
                    <button className="btn-danger" onClick={() => setPorEliminar(a)}>
                      Eliminar
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
            Página {pagina + 1} de {paginas} · {total} asientos
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

      {detalle ? (
        <Modal isOpen onClose={() => setDetalle(null)} title={`Asiento #${detalle.id}`} size="lg">
          <p style={{ marginTop: 0 }}>
            <strong>{detalle.descripcion}</strong>
          </p>
          <p style={{ fontSize: 13, color: "var(--kanagawa-fg-muted)" }}>
            {formatDate(detalle.fecha)} · {ETIQUETA_TIPO[detalle.tipo] ?? detalle.tipo}
            {detalle.referencia ? ` · referencia ${detalle.referencia}` : ""}
          </p>
          <table className="product-list">
            <thead>
              <tr>
                <th>Código</th>
                <th>Cuenta</th>
                <th style={{ textAlign: "right" }}>Debe</th>
                <th style={{ textAlign: "right" }}>Haber</th>
              </tr>
            </thead>
            <tbody>
              {detalle.detalles.map((d) => (
                <tr key={d.id}>
                  <td style={{ fontFamily: "monospace" }}>{d.codigo}</td>
                  <td>
                    {d.cuentaNombre}
                    {d.descripcion ? (
                      <div style={{ fontSize: 12, color: "var(--kanagawa-fg-muted)" }}>
                        {d.descripcion}
                      </div>
                    ) : null}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {d.debeCentavos ? formatCentavos(d.debeCentavos) : "—"}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {d.haberCentavos ? formatCentavos(d.haberCentavos) : "—"}
                  </td>
                </tr>
              ))}
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={2} style={{ textAlign: "right" }}>
                  Totales
                </td>
                <td style={{ textAlign: "right" }}>{formatCentavos(detalle.totalDebeCentavos)}</td>
                <td style={{ textAlign: "right" }}>{formatCentavos(detalle.totalHaberCentavos)}</td>
              </tr>
            </tbody>
          </table>
          <div className="form-row" style={{ marginTop: 16 }}>
            <button className="btn-secondary" onClick={() => setDetalle(null)}>
              Cerrar
            </button>
          </div>
        </Modal>
      ) : null}

      {form ? (
        <Modal isOpen onClose={() => setForm(null)} title="Nuevo asiento" size="lg">
          <form onSubmit={guardar}>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="as-fecha">Fecha</label>
                <input
                  id="as-fecha"
                  className="input-field"
                  type="date"
                  value={form.fecha}
                  onChange={(e) => setForm({ ...form, fecha: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="as-tipo">Tipo</label>
                <select
                  id="as-tipo"
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

            <div className="form-group">
              <label htmlFor="as-descripcion">Descripción *</label>
              <input
                id="as-descripcion"
                className="input-field"
                value={form.descripcion}
                onChange={(e) => setForm({ ...form, descripcion: e.target.value })}
                placeholder="Aporte de capital del dueño"
                required
                autoFocus
              />
            </div>

            <div className="form-group">
              <label htmlFor="as-referencia">Referencia (opcional)</label>
              <input
                id="as-referencia"
                className="input-field"
                value={form.referencia}
                onChange={(e) => setForm({ ...form, referencia: e.target.value })}
                placeholder="Sin referencia"
              />
              <small style={{ color: "var(--kanagawa-fg-muted)" }}>
                Un asiento con referencia queda marcado como escrito por la app y no se puede
                eliminar. Dejalo vacío para un asiento manual.
              </small>
            </div>

            <h3 className="mm-sub">Partidas</h3>
            <div className="table-container">
              <table className="product-list">
                <thead>
                  <tr>
                    <th>Cuenta</th>
                    <th style={{ width: 140, textAlign: "right" }}>Debe</th>
                    <th style={{ width: 140, textAlign: "right" }}>Haber</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {form.partidas.map((p, i) => (
                    <tr key={i}>
                      <td>
                        <select
                          className="input-field"
                          value={p.cuentaId}
                          onChange={(e) => setPartida(i, { cuentaId: e.target.value })}
                          aria-label={`Cuenta de la partida ${i + 1}`}
                          data-testid={`partida-cuenta-${i}`}
                        >
                          <option value="">Elegí una cuenta…</option>
                          {cuentasActivas.map((c) => (
                            <option key={c.id} value={String(c.id)}>
                              {c.codigo} · {c.nombre}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          className="input-field"
                          inputMode="decimal"
                          style={{ textAlign: "right" }}
                          value={p.debe}
                          onChange={(e) => setPartida(i, { debe: e.target.value })}
                          placeholder="0.00"
                          aria-label={`Debe de la partida ${i + 1}`}
                          data-testid={`partida-debe-${i}`}
                        />
                      </td>
                      <td>
                        <input
                          className="input-field"
                          inputMode="decimal"
                          style={{ textAlign: "right" }}
                          value={p.haber}
                          onChange={(e) => setPartida(i, { haber: e.target.value })}
                          placeholder="0.00"
                          aria-label={`Haber de la partida ${i + 1}`}
                          data-testid={`partida-haber-${i}`}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => quitarPartida(i)}
                          disabled={form.partidas.length <= 2}
                          title={
                            form.partidas.length <= 2
                              ? "Un asiento necesita al menos dos partidas"
                              : "Quitar esta partida"
                          }
                          aria-label={`Quitar la partida ${i + 1}`}
                        >
                          <i className="fa-solid fa-minus" aria-hidden="true"></i>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="form-row" style={{ justifyContent: "space-between" }}>
              <button type="button" className="btn-secondary" onClick={agregarPartida}>
                <i className="fa-solid fa-plus" aria-hidden="true"></i> Agregar partida
              </button>
              {/* The running balance. It is feedback, not the rule: main still refuses an
                  unbalanced entry before the first INSERT. */}
              <span style={{ fontSize: 15 }} data-testid="totales-asiento">
                Debe <strong>{formatCentavos(totales.debe)}</strong> · Haber{" "}
                <strong>{formatCentavos(totales.haber)}</strong>{" "}
                {totales.diferencia === 0 ? (
                  <span style={{ color: "var(--kanagawa-green)", fontWeight: 600 }}>
                    <i className="fa-solid fa-circle-check" aria-hidden="true"></i> Balancea
                  </span>
                ) : (
                  <span style={{ color: "var(--kanagawa-red)", fontWeight: 600 }}>
                    Diferencia {formatCentavos(Math.abs(totales.diferencia))}
                  </span>
                )}
              </span>
            </div>

            <div className="form-row" style={{ marginTop: 16 }}>
              <button
                type="submit"
                className="btn-primary"
                disabled={guardando || !puedeGuardar}
                data-testid="guardar-asiento"
              >
                {guardando ? "Guardando…" : "Guardar asiento"}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setForm(null)}>
                Cancelar
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {porEliminar ? (
        <Modal
          isOpen
          onClose={() => setPorEliminar(null)}
          title={`Eliminar el asiento #${porEliminar.id}`}
        >
          <p>
            <strong>{porEliminar.descripcion}</strong>
          </p>
          <p>
            Se borran el asiento y todas sus partidas. Esto <strong>no es una anulación</strong>{" "}
            contable: la forma correcta de corregir un asiento equivocado es escribir el asiento
            espejo, para que el libro muestre qué pasó y cómo se corrigió.
          </p>
          <p>
            Los asientos que escribió la app (una venta, una compra, un cobro){" "}
            <strong>no se pueden borrar</strong>: se anula la operación que los generó.
          </p>
          <div className="form-row">
            <button
              className="btn-danger"
              data-testid="confirmar-eliminar-asiento"
              onClick={eliminar}
              disabled={eliminando}
            >
              {eliminando ? "Eliminando…" : "Sí, eliminar"}
            </button>
            <button className="btn-secondary" onClick={() => setPorEliminar(null)}>
              Volver
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
};

export default Asientos;
