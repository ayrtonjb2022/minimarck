import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { cajasAPI } from "../api/cajas";
import { mensajeDeError } from "../api/ipc";
import { toast } from "react-toastify";
import { formatCents, toCents } from "../../../shared/money";

/**
 * Cierre de caja — counting the drawer at the end of a day, and deciding what to do when the count
 * does not match.
 *
 * ── POR QUÉ EXISTE ESTA PANTALLA ─────────────────────────────────────────────────────────────
 *
 * `cajas.close` ya existía y ya estaba implementada, pero cerraba la caja sobre lo que dicen los
 * movimientos y no sobre lo que el operador cuenta. Sin una pantalla que pida el conteo, el cajero
 * no tiene dónde escribirlo: la diferencia se discovers recién cuando alguien revisa la caja un
 * mes después, cuando ya no hay nadie que recuerde qué pasó. Contar es un hecho del día, y un hecho
 * del día que no se escribe en ningún lado no es un dato: es un olvido.
 *
 * ── LAS TRES CIFRAS, Y POR QUÉ SON TRES Y NO DOS ──────────────────────────────────────────────
 *
 *   Esperado   lo que dicen los movimientos de la caja — el saldoActualCentavos que calculó el
 *              proceso principal, no una fórmula repetida acá
 *   Contado    lo que el operador acaba de contar con las manos en el cajón
 *   Diferencia la resta, y lo que decide si hace falta reconocerla
 *
 * La diferencia se muestra ANTES de cerrar, mientras todavía se puede pensar. Una pantalla que
 * recién muestra el descuadre después de cerrar transformó un momento de decisión en un informe.
 *
 * ── LA DIFERENCIA NO SE RECHAZA, SE RECONOCE ──────────────────────────────────────────────────
 *
 * Un cajón que no cuadra es el final ORDINARIO de un día real, no un error: sobró un billete de
 * cien, faltaba una moneda, alguien devolvió de más. Rechazarla sería mentir sobre el negocio, y
 * aceptarla en silencio sería peor: la diferencia tiene que quedar escrita y atribuida a una
 * decisión consciente de alguien. Por eso el checkbox NO es una validación decorativa — sin él el
 * botón de cerrar no se habilita cuando la diferencia es distinta de cero.
 *
 * El backend igual registra lo que el operador eligió (`5.4.02 Faltantes` / `4.2.02 Sobrantes`),
 * y esta pantalla no decide el signo ni el monto: solo pide que alguien lo mire antes de escribir.
 *
 * ── POR QUÉ EL CONTEO ES OBLIGATORIO ACÁ, SI EL BACKEND LO ACEPTA COMO OPCIONAL ──────────────────
 *
 * `cerrar` trata `conteo: null` como "nadie contó", que es real (la web no tiene el campo) y por eso
 * existe. En ESTA pantalla no: el propósito de la pantalla es exactamente contar, así que un campo
 * vacío no es una opción sino una tarea sin hacer. El camino sin conteo sigue disponible para quien
 * llame a la operación por API.
 *
 * ── EL input NO es type="number" ───────────────────────────────────────────────────────────────
 *
 * Igual que en `ModalAperturaCaja`: un `number` acepta notación exponencial y valores que el
 * parser decimal de `toCents` rechaza, y el cajero vería un error de formato sin entender por qué.
 * `toCents` es el que decide qué es un monto válido.
 */

/** Un campo de texto a entero de centavos, o `null` mientras no haya nada countable. */
function conteoACentavos(texto) {
  if (texto === null || texto === undefined || texto.trim() === '') return null;
  try {
    return toCents(texto, "monto contado");
  } catch {
    // A medio escribir ("5", "50,") el texto todavía no es un monto. La pantalla lo muestra como
    // "aún no es un número" en vez de avisar un error por cada tecla.
    return null;
  }
}

const CierreDeCaja = () => {
  const navegar = useNavigate();
  const [caja, setCaja] = useState(null);
  const [cerrada, setCerrada] = useState(null);
  const [conteo, setConteo] = useState("");
  const [observaciones, setObservaciones] = useState("");
  const [reconocido, setReconocido] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      setCaja(await cajasAPI.activa());
      setError(null);
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudo leer la caja"));
      setError(err);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  // Lo que dice el sistema, calculado en el proceso principal y traído con la caja abierta.
  const esperado = caja ? caja.saldoActualCentavos : 0;

  const conteoCentavos = useMemo(() => conteoACentavos(conteo), [conteo]);

  // `null` mientras el campo no sea un monto todavía. Es distinto de cero, y la diferencia tiene
  // que distinguirlo: "no contaste" no es "contaste cero".
  const diferencia = conteoCentavos === null ? null : conteoCentavos - esperado;

  const hayFaltante = diferencia !== null && diferencia < 0;
  const haySobrante = diferencia !== null && diferencia > 0;

  // Reconocer es obligatorio solo cuando HAY diferencia. Con el cajón cuadrado no hay nada que
  // reconocer, y pedir la confirmación igual entrenaría a la gente a marcar una casilla a ciegas.
  const faltaReconocer = diferencia !== null && diferencia !== 0 && !reconocido;
  const puedeCerrar = conteoCentavos !== null && !faltaReconocer && !guardando;

  const cerrar = async () => {
    if (!puedeCerrar) return;
    setGuardando(true);
    try {
      const resultado = await cajasAPI.cierre({
        id: caja.id,
        conteo,
        observaciones: observaciones.trim() || undefined
      });
      setCerrada(resultado);
      setCaja(null);
      toast.success("Caja cerrada");
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudo cerrar la caja"));
      setError(err);
    } finally {
      setGuardando(false);
    }
  };

  const abrirNueva = async () => {
    try {
      await cajasAPI.apertura({ saldoInicial: 0 });
      setCerrada(null);
      setConteo("");
      setObservaciones("");
      setReconocido(false);
      await cargar();
      toast.success("Caja abierta");
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudo abrir una caja nueva"));
    }
  };

  if (cargando) {
    return <div className="page"><p>Cargando caja…</p></div>;
  }

  // ── LA PANTALLA TRAS CERRAR ──────────────────────────────────────────────────────────────────
  // Las tres cifras vuelven a estar visibles, y ahora sí como un hecho registrado. `esperado` viaja
  // en la respuesta justamente para esto: la caja cerrada ya tiene la diferencia integrada en sus
  // totales, así que un render que lo recalculara desde la fila cerrada mostraría siempre cero.
  if (cerrada) {
    return (
      <div className="page">
        <div className="card">
          <div className="card-header">
            <div>
              <h3 style={{ margin: 0, fontSize: "18px" }}>Caja cerrada</h3>
              <span className="tag" style={{ marginTop: "4px", display: "inline-block" }}>
                {cerrada.fecha_cierre ? new Date(cerrada.fecha_cierre).toLocaleString("es-AR") : ""}
              </span>
            </div>
          </div>
          <div style={{ padding: "22px", display: "flex", flexDirection: "column", gap: "14px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px" }}>
              <div className="stat-card">
                <span>Esperado</span>
                <strong>{formatCents(cerrada.saldo_esperado_centavos)}</strong>
              </div>
              <div className="stat-card">
                <span>Contado</span>
                <strong>{formatCents(cerrada.monto_contado_centavos ?? 0)}</strong>
              </div>
              <div className="stat-card">
                <span>Diferencia</span>
                <strong>
                  {(cerrada.diferencia_centavos ?? 0) === 0
                    ? "Sin diferencia"
                    : formatCents(cerrada.diferencia_centavos)}
                </strong>
                {(cerrada.diferencia_centavos ?? 0) !== 0 && (
                  <small>
                    {(cerrada.diferencia_centavos ?? 0) < 0
                      ? "Registrado como faltante en 5.4.02"
                      : "Registrado como sobrante en 4.2.02"}
                  </small>
                )}
              </div>
            </div>

            {cerrada.observaciones && <p style={{ margin: 0 }}>{cerrada.observaciones}</p>}

            <div style={{ display: "flex", gap: "12px" }}>
              <button onClick={() => navegar("/pos")} className="btn-secondary" style={{ flex: 1 }}>
                Volver a vender
              </button>
              <button onClick={abrirNueva} className="btn-primary" style={{ flex: 1 }}>
                Abrir la caja de mañana
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── NO HAY CAJA ABIERTA ──────────────────────────────────────────────────────────────────────
  if (!caja) {
    return (
      <div className="page">
        <div className="card">
          <div className="card-header">
            <h3 style={{ margin: 0, fontSize: "18px" }}>No hay caja abierta</h3>
          </div>
          <div style={{ padding: "22px", display: "flex", flexDirection: "column", gap: "14px" }}>
            <p style={{ margin: 0 }}>
              No hay una caja abierta para contar. Abrí una caja y volvé a entrar acá.
            </p>
            <button onClick={() => navegar("/pos")} className="btn-primary">
              Ir a vender
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── LA PANTALLA DE CONTAR ────────────────────────────────────────────────────────────────────
  return (
    <div className="page">
      <div className="card">
        <div className="card-header">
          <div>
            <h3 style={{ margin: 0, fontSize: "18px" }}>Cierre de caja</h3>
            <span className="tag" style={{ marginTop: "4px", display: "inline-block" }}>
              Contá el efectivo del cajón
            </span>
          </div>
        </div>

        <div style={{ padding: "22px", display: "flex", flexDirection: "column", gap: "18px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px" }}>
            <div className="stat-card">
              <span>Esperado (sistema)</span>
              <strong>{formatCents(esperado)}</strong>
            </div>

            <div className="form-group" style={{ margin: 0 }}>
              <label>Contado ($)</label>
              <input
                type="text"
                inputMode="decimal"
                value={conteo}
                onChange={(e) => {
                  setConteo(e.target.value);
                  // Reconocer es una afirmación sobre ESTA diferencia. Si el número cambia, el
                  // operador está contestando otra pregunta y la afirmación anterior ya no vale.
                  setReconocido(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") cerrar();
                }}
                placeholder="Ej: 5000"
                data-testid="cierre-conteo"
              />
            </div>

            <div className="stat-card">
              <span>Diferencia</span>
              <strong data-testid="cierre-diferencia">
                {diferencia === null
                  ? "—"
                  : diferencia === 0
                    ? "Sin diferencia"
                    : formatCents(diferencia)}
              </strong>
              {hayFaltante && <small>Faltante</small>}
              {haySobrante && <small>Sobrante</small>}
            </div>
          </div>

          {faltaReconocer && (
            <label
              style={{
                display: "flex",
                gap: "10px",
                alignItems: "flex-start",
                padding: "12px",
                border: "1px solid #f59e0b",
                borderRadius: "8px",
                cursor: "pointer"
              }}
            >
              <input
                type="checkbox"
                checked={reconocido}
                onChange={(e) => setReconocido(e.target.checked)}
                data-testid="cierre-reconocer"
                style={{ marginTop: "3px" }}
              />
              <span>
                Conté y el cajón{" "}
                <strong>{hayFaltante ? "no cuadra: falta efectivo" : "sobra efectivo"}</strong>. Confirmá
                que reconocés la diferencia antes de cerrar.
              </span>
            </label>
          )}

          <div className="form-group" style={{ margin: 0 }}>
            <label>Observaciones (opcional)</label>
            <input
              type="text"
              value={observaciones}
              onChange={(e) => setObservaciones(e.target.value)}
              placeholder="Ej: turno tarde"
              data-testid="cierre-observaciones"
            />
          </div>

          <div style={{ display: "flex", gap: "12px" }}>
            <button
              onClick={() => navegar("/pos")}
              className="btn-secondary"
              style={{ flex: 1 }}
              disabled={guardando}
            >
              Cancelar
            </button>
            <button
              onClick={cerrar}
              className="btn-primary"
              style={{ flex: 1 }}
              disabled={!puedeCerrar}
              data-testid="cierre-confirmar"
            >
              {guardando ? "Cerrando…" : "Cerrar caja"}
            </button>
          </div>

          {error && (
            <p style={{ margin: 0, color: "#b91c1c" }}>
              {mensajeDeError(error, "No se pudo cerrar la caja")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default CierreDeCaja;