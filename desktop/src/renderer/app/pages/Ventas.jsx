import React, { useCallback, useEffect, useState } from "react";
import { ventasAPI } from "../api/ventas";
import Modal from "../components/common/Modal";
import { toast } from "react-toastify";
import { formatCentavos, formatDate, formatCantidad } from "../utils/formatters";
import { isCents } from "../../../shared/money";

/**
 * Sales history, read-only, over the desktop contract.
 *
 * Four things the web version got wrong here, all of which would have been visible on the
 * first render:
 *
 * 1. `response.data.data` / `response.data.pagination`. The web unwrapped an axios envelope.
 *    Over IPC the handler returns the value itself: `{ filas, total }`. Reading
 *    `response.data.data` on the desktop yields `undefined`, and the table renders
 *    "No hay ventas registradas" forever while the database fills up.
 *
 * 2. `row.total`, `row.subtotal`, `row.iva`, `detalle.precioUnitario`. The contract is
 *    integer centavos — `totalCentavos`, `subtotalCentavos`, `ivaCentavos`,
 *    `precioUnitarioCentavos` — and quantities are integer thousandths (`cantidadMilli`).
 *    `formatCentavos(undefined)` does NOT render "$0.00": it THROWS `MONEY_NOT_CENTS` from
 *    `assertCents`, which rejects anything that is not an integer of centavos. So a wrong
 *    field name took the whole screen down instead of showing a column of zeroes, and every
 *    call site here was renamed to the contract's name to keep that from happening.
 *
 * 3. `row.usuario.nombre`. There is no joined user object; a sale carries `userId`, and
 *    resolving it would need an operation the frozen contract does not have. So the
 *    column is gone instead of showing a blank cell forever. The operator on duty is in the
 *    top bar, which is the truth about who is selling.
 *
 * 4. "Nueva Venta" opened a `SaleForm` modal. The desktop's sale path is the POS at
 *    /pos, and a second entry point for the same transaction is a second place for the
 *    money to be wrong. The button here is "Volver a vender", which is where a sale
 *    actually belongs.
 *
 * The Excel export is gone too: it needed a spreadsheet library, and adding one for a
 * button is not worth a dependency on a machine with no network. `ventas.list` already
 * filters by date range and state, which is what an operator was reaching for it to do.
 */

const PAGE_SIZE = 20;

const METODO_PAGO = {
  efectivo: "Efectivo",
  tarjeta: "Tarjeta",
  transferencia: "Transferencia",
  credito: "Credito",
};

const metodoLabel = (m) => METODO_PAGO[m] || m || "-";

const estadoClass = (estado) => {
  if (estado === "completada") return "paid";
  if (estado === "pendiente") return "pending";
  return "cancelled";
};

const estadoLabel = (estado) => {
  if (estado === "completada") return "Completada";
  if (estado === "pendiente") return "Pendiente";
  return "Anulada";
};

const Ventas = () => {
  const [ventas, setVentas] = useState([]);
  const [total, setTotal] = useState(0);
  const [pagina, setPagina] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ fechaDesde: "", fechaHasta: "", estado: "" });
  const [seleccionada, setSeleccionada] = useState(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const res = await ventasAPI.listar({
        limit: PAGE_SIZE,
        offset: pagina * PAGE_SIZE,
        estado: filters.estado || undefined,
        fechaDesde: filters.fechaDesde || undefined,
        fechaHasta: filters.fechaHasta || undefined,
      });
      // `{ filas, total }` is the handler's return value, not an envelope.
      setVentas(Array.isArray(res?.filas) ? res.filas : []);
      setTotal(Number(res?.total) || 0);
    } catch (err) {
      // An empty table that says "no sales" when the read FAILED is a lie an operator
      // cannot detect, so a failure has to look different from an empty day.
      setVentas([]);
      setTotal(0);
      toast.error(`No se pudieron leer las ventas: ${err?.message || "error desconocido"}`);
    } finally {
      setLoading(false);
    }
  }, [pagina, filters]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  // Any filter change goes back to page 0: staying on page 4 of a list that just got
  // narrower shows an empty table and reads as "the sales disappeared".
  const setFiltro = (patch) => {
    setPagina(0);
    setFilters((f) => ({ ...f, ...patch }));
  };

  const totalPaginas = Math.ceil(total / PAGE_SIZE);

  return (
    <div>
      <div className="table-container">
        <div className="table-header">
          <h3>Ventas {total > 0 ? <span className="tag">{total}</span> : null}</h3>
          <div className="actions">
            <input
              type="date"
              value={filters.fechaDesde}
              onChange={(e) => setFiltro({ fechaDesde: e.target.value })}
              aria-label="Desde"
            />
            <input
              type="date"
              value={filters.fechaHasta}
              onChange={(e) => setFiltro({ fechaHasta: e.target.value })}
              aria-label="Hasta"
            />
            <select
              value={filters.estado}
              onChange={(e) => setFiltro({ estado: e.target.value })}
              aria-label="Estado"
            >
              <option value="">Todos los estados</option>
              <option value="completada">Completada</option>
              <option value="anulada">Anulada</option>
            </select>
            <button type="button" onClick={cargar} className="btn-secondary">
              <i className="fa-solid fa-rotate" aria-hidden="true"></i> Actualizar
            </button>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Folio</th>
              <th>Fecha</th>
              <th>Cliente</th>
              <th>Metodo</th>
              <th style={{ textAlign: "right" }}>Total</th>
              <th>Estado</th>
              <th aria-label="Detalle"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", padding: 32, color: "var(--kanagawa-comment)" }}>
                  <i className="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Cargando...
                </td>
              </tr>
            ) : ventas.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", padding: 32, color: "var(--kanagawa-comment)" }}>
                  No hay ventas para estos filtros
                </td>
              </tr>
            ) : (
              ventas.map((v) => (
                <tr key={v.id}>
                  <td>#{v.folio}</td>
                  <td>{formatDate(v.fecha)}</td>
                  <td>{v.clienteNombre || "-"}</td>
                  <td>{metodoLabel(v.metodoPago)}</td>
                  <td style={{ textAlign: "right", fontWeight: 600 }}>
                    {formatCentavos(v.totalCentavos)}
                  </td>
                  <td>
                    <span className={`status ${estadoClass(v.estado)}`}>
                      <span className="dot" aria-hidden="true"></span>
                      {estadoLabel(v.estado)}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={() => setSeleccionada(v)}
                      className="btn-secondary"
                      style={{ padding: "4px 10px" }}
                      title={`Ver detalle de la venta ${v.folio}`}
                      aria-label={`Ver detalle de la venta ${v.folio}`}
                    >
                      <i className="fa-solid fa-eye" aria-hidden="true"></i>
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
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
            <span>
              Pagina {pagina + 1} de {totalPaginas}
            </span>
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
        isOpen={!!seleccionada}
        onClose={() => setSeleccionada(null)}
        title={seleccionada ? `Venta #${seleccionada.folio}` : ""}
        size="lg"
      >
        {seleccionada ? (
          <DetalleVenta
            venta={seleccionada}
            onCancelada={() => {
              // Close, then reload: leaving the modal open over a row the operator just voided
              // would show a detail of a cancelled sale next to a list that still claims it is
              // live, and the operator has no way to tell which of the two is current.
              setSeleccionada(null);
              toast.success(`Venta #${seleccionada.folio} cancelada`);
              cargar();
            }}
          />
        ) : null}
      </Modal>
    </div>
  );
};

/**
 * The detail body. `ventas.list` does not return the lines — it selects `ventas.*` only —
 * so this calls `ventas.get` for the selected id instead of reading `venta.detalles` off a
 * list row that never had it. Without that call the product table would render empty on
 * every sale, which looks like a till that sold nothing.
 */
const DetalleVenta = ({ venta, onCancelada }) => {
  const [detalle, setDetalle] = useState(null);
  const [error, setError] = useState("");
  // Cancelling moves stock, reverses the drawer entry and posts a mirror journal row, so the
  // button is two-step: the first click arms it and asks for a reason, the second one sends it.
  // One click on a button that undoes a sale is one misclick away from an unrecorded refund.
  const [armado, setArmado] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [anulando, setAnulando] = useState(false);
  const cancelable = venta.estado !== "cancelada";

  const anular = async () => {
    setAnulando(true);
    try {
      await ventasAPI.cancelar(venta.id, motivo.trim() || null);
      onCancelada?.();
    } catch (err) {
      setError(err?.message || "No se pudo cancelar la venta");
      setArmado(false);
    } finally {
      setAnulando(false);
    }
  };

  useEffect(() => {
    let vigente = true;
    setDetalle(null);
    setError("");
    ventasAPI
      .obtener(venta.id)
      .then((full) => {
        if (vigente) setDetalle(full);
      })
      .catch((err) => {
        if (vigente) setError(err?.message || "No se pudo leer la venta");
      });
    return () => {
      vigente = false;
    };
  }, [venta.id]);

  const lineas = detalle?.detalles ?? [];

  return (
    <div className="card">
      <div className="card-header">
        <h3>Detalle #{venta.folio}</h3>
        <span className={`status ${estadoClass(venta.estado)}`}>
          <span className="dot" aria-hidden="true"></span>
          {estadoLabel(venta.estado)}
        </span>
      </div>

      <div className="mm-detail-grid">
        <div>
          <span>Fecha</span>
          <div>{formatDate(venta.fecha)}</div>
        </div>
        <div>
          <span>Metodo de pago</span>
          <div>{metodoLabel(venta.metodoPago)}</div>
        </div>
        <div>
          <span>Cliente</span>
          <div>{venta.clienteNombre || "-"}</div>
        </div>
        {/* EL RECIBIDO/CAMBIO ES DEL EFECTIVO Y DE NADIE MÁS. Una venta por crédito, tarjeta o
            transferencia no tiene "recibido": nadie puso billetes en el mostrador, así que las dos
            columnas llegan en `null` — legítimamente. `formatCentavos(null)` no dibuja un cero:
            TIRA `MONEY_NOT_CENTS`, porque el módulo de dinero rechaza todo lo que no sea un entero
            de centavos.

            Esa excepción se llevaba puesto el detalle ENTERO: React desmonta el componente que
            tira durante el render, así que el modal quedaba abierto con el folio en el título y el
            cuerpo en blanco. Visto desde el mostrador eso no parece un crash, parece "esta venta no
            tiene productos" — y con dos de tres ventas (crédito y transferencia) pasando por acá,
            el historial entero se veía roto.

            El guardia va ACÁ y no adentro de `formatCentavos`: la estrictez del formateador es la
            que delata a quien le pasa pesos donde van centavos, y aflojarla para tapar un `null`
            que SÍ es válido cambiaría una pantalla rota por un número mal cobrado, en silencio.

            Y el predicado es `isCents`, no `Number.isSafeInteger`. El formateador encadena
            `formatCents` → `assertCents` → `isCents`, así que el guardia tiene que ser LA MISMA
            puerta o más ancha; uno más ancho reabre la pantalla en blanco por la puerta de
            atrás. `Number.isSafeInteger` acepta un entero que exceda `MAX_CENTS`, y ese valor
            pasa el guardia y TIRA un centavo más adentro del render.

            El `&&` es a propósito: un solo `—` blanquea las DOS columnas cuando cualquiera de las
            dos no es centavos, y eso es correcto sólo porque `ventas.repo.js:329-341` las
            inicializa en `null` y las asigna JUNTAS dentro del mismo `if`. Nunca hay una sola
            seteada, así que no existe el caso "una columna válida y la otra no". */}
        <div>
          <span>Recibido / Cambio</span>
          <div>
            {isCents(venta.montoRecibidoCentavos) && isCents(venta.montoCambioCentavos)
              ? `${formatCentavos(venta.montoRecibidoCentavos)} / ${formatCentavos(venta.montoCambioCentavos)}`
              : "—"}
          </div>
        </div>
      </div>

      {error ? (
        <p style={{ color: "var(--kanagawa-red)", fontSize: 14 }}>{error}</p>
      ) : !detalle ? (
        <p style={{ color: "var(--kanagawa-comment)" }}>
          <i className="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Cargando productos...
        </p>
      ) : (
        <div style={{ borderTop: "1px solid var(--kanagawa-border)", paddingTop: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>Productos</div>
          <table>
            <thead>
              <tr>
                <th>Producto</th>
                <th style={{ textAlign: "right" }}>Cantidad</th>
                <th style={{ textAlign: "right" }}>Precio unit.</th>
                <th style={{ textAlign: "right" }}>Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {lineas.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: "center", color: "var(--kanagawa-comment)" }}>
                    Esta venta no tiene lineas
                  </td>
                </tr>
              ) : (
                lineas.map((d) => (
                  <tr key={d.id}>
                    <td>{d.producto?.nombre || d.nombreProducto || `#${d.productoId}`}</td>
                    {/* 500 thousandths is half a kilo, and the formatter says so. */}
                    <td style={{ textAlign: "right" }}>{formatCantidad(d.cantidadMilli)}</td>
                    <td style={{ textAlign: "right" }}>{formatCentavos(d.precioUnitarioCentavos)}</td>
                    <td style={{ textAlign: "right" }}>{formatCentavos(d.subtotalCentavos)}</td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3} style={{ textAlign: "right", fontWeight: 500, paddingTop: 8 }}>
                  Subtotal:
                </td>
                <td style={{ textAlign: "right", fontWeight: 500, paddingTop: 8 }}>
                  {formatCentavos(detalle.subtotalCentavos)}
                </td>
              </tr>
              <tr>
                <td colSpan={3} style={{ textAlign: "right", fontWeight: 500 }}>
                  IVA:
                </td>
                <td style={{ textAlign: "right", fontWeight: 500 }}>
                  {formatCentavos(detalle.ivaCentavos)}
                </td>
              </tr>
              <tr>
                <td colSpan={3} style={{ textAlign: "right", fontWeight: 700, fontSize: 16 }}>
                  Total:
                </td>
                <td style={{ textAlign: "right", fontWeight: 700, fontSize: 16 }}>
                  {formatCentavos(detalle.totalCentavos)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {cancelable && (
        <div
          style={{
            borderTop: "1px solid var(--kanagawa-border)",
            marginTop: 14,
            paddingTop: 12,
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          {!armado ? (
            <>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setArmado(true)}
                data-testid="armar-cancelacion"
              >
                <i className="fa-solid fa-ban" aria-hidden="true"></i> Cancelar venta
              </button>
              {/* Says what cancelling actually does, before it does it. */}
              <span style={{ fontSize: 12, color: "var(--kanagawa-comment)" }}>
                Devuelve el stock, revierte el dinero de la caja y deja la venta marcada.
              </span>
            </>
          ) : (
            <>
              <input
                type="text"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Motivo (opcional)"
                aria-label="Motivo de la cancelacion"
                disabled={anulando}
                style={{ flex: "1 1 180px", minWidth: 160 }}
              />
              <button
                type="button"
                className="btn-primary"
                onClick={anular}
                disabled={anulando}
                data-testid="confirmar-cancelacion"
              >
                {anulando ? "Cancelando..." : "Confirmar cancelacion"}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setArmado(false)}
                disabled={anulando}
              >
                Volver
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default Ventas;
