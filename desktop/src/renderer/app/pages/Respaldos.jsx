import React, { useCallback, useEffect, useRef, useState } from "react";
import { backupAPI } from "../api/backup";
import { mensajeDeError } from "../api/ipc";
import { toast } from "react-toastify";
import { formatDate } from "../utils/formatters";
import Modal from "../components/common/Modal";

/**
 * Respaldos — the shop's file, made survivable, and the one screen that can undo a disaster.
 *
 * ── WHY THIS IS THE MOST DANGEROUS SCREEN IN THE APP ─────────────────────────────────────────
 *
 * Every other screen writes rows. `Restaurar` REPLACES THE DATABASE: the catalogue, the sales
 * ledger, the till history and the users all become whatever the archive holds. Done by mistake on
 * the wrong archive it is the only operation here with no undo — which is why the confirmation is
 * not a yes/no dialog. It states what will be lost, it says that main takes an automatic backup of
 * the CURRENT file first, and it names the archive by its date so nobody confirms a filename they
 * did not read.
 *
 * ── WHY THE LIST SHOWS `sin manifiesto` ───────────────────────────────────────────────────────
 *
 * A `.db` can be dropped into the folder by hand — that is exactly what somebody restoring a
 * machine does. Those archives are listed and restorable, and the row says nobody recorded anything
 * about them rather than inventing a date or a checksum. `Verificar` re-derives everything from the
 * file, so an unverified row is a question, not a defect.
 *
 * ── WHY PROGRESS IS NOT DECORATION ───────────────────────────────────────────────────────────
 *
 * A backup of a shop-sized database takes seconds. Before this screen, that was seconds of an
 * unchanged button, and the natural response to an unchanged button is to press it again — which
 * starts a second SQLite copy. The subscription is real: main emits on `backup:progress`, which is
 * the first event this app has ever sent.
 */

/** Bytes to something a person reads. Binary units, because that is what the file size is. */
const formatearBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const unidades = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < unidades.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${i === 0 ? n : n.toFixed(n >= 10 ? 0 : 1)} ${unidades[i]}`;
};

/**
 * A friendly name for an archive id, which is an ISO timestamp with the separators normalised.
 *
 * EXPORTED, not copied. `tests/ui/respaldos.spec.jsx` used to keep its own transcription of this
 * function so it could compute what the row should say — and a transcription is not an assertion: it
 * is a second implementation that a reviewer has to diff by eye, and the failure it hides is the
 * screen quietly changing format while every date assertion in the suite stayed green because the
 * copy had not changed with it. There is now ONE implementation, and the spec pins its format
 * directly (`pins the archive-id format the screen prints`) rather than mirroring it.
 */
export const fechaDeId = (id) => {
  const m = /^minimarck-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(id);
  if (!m) return id;
  return `${m[1]} ${m[2]}:${m[3]}:${m[4]}`;
};

const Respaldos = () => {
  const [filas, setFilas] = useState([]);
  const [dir, setDir] = useState(null);
  const [loading, setLoading] = useState(true);
  const [creando, setCreando] = useState(false);
  const [progreso, setProgreso] = useState(null);
  const [verificando, setVerificando] = useState(null);
  const [porRestaurar, setPorRestaurar] = useState(null);
  const [restaurando, setRestaurando] = useState(false);
  const [porPodar, setPorPodar] = useState(false);
  const [conservar, setConservar] = useState(10);
  const [podando, setPodando] = useState(false);
  const [restaurado, setRestaurado] = useState(null);

  /**
   * The progress subscription. `alProgresar` returns the unsubscribe `on()` hands back, so the
   * effect cleans up — a listener left behind on a re-render is the classic leak, and this one
   * would keep calling `setState` on an unmounted screen.
   */
  useEffect(() => {
    const desuscribir = backupAPI.alProgresar((ev) => {
      if (!ev?.fase) return;
      const etiquetas = {
        iniciando: "Preparando el respaldo…",
        listo: "Respaldo terminado",
        verificando: "Verificando el respaldo…",
        verificado: "Verificación terminada",
        restaurando: "Restaurando el respaldo…",
        restaurado: "Respaldo restaurado",
        podado: "Limpieza terminada",
      };
      setProgreso(etiquetas[ev.fase] ?? ev.fase);
      // A terminal phase clears itself, so a finished operation does not leave a stale line on the
      // screen that reads as "still working".
      if (["listo", "verificado", "restaurado", "podado"].includes(ev.fase)) {
        setTimeout(() => setProgreso(null), 2500);
      }
    });
    return desuscribir;
  }, []);

  const cargar = useCallback(async ({ suprimeCargando = false } = {}) => {
    if (!suprimeCargando) setLoading(true);
    try {
      const res = await backupAPI.listar();
      setFilas(res.filas ?? []);
      setDir(res.backupDir ?? null);
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudieron leer los respaldos"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const crear = async () => {
    setCreando(true);
    try {
      const fila = await backupAPI.crear({ motivo: "manual" });
      toast.success(`Respaldo creado (${formatearBytes(fila.bytes)})`);
      await cargar({ suprimeCargando: true });
    } catch (err) {
      // The repository's own sentence: a failed checkpoint, a full disk and an unreadable archive
      // all mean different things and the message says which.
      toast.error(mensajeDeError(err, "No se pudo crear el respaldo"), { autoClose: 9000 });
    } finally {
      setCreando(false);
    }
  };

  const verificar = async (fila) => {
    setVerificando(fila.id);
    try {
      const res = await backupAPI.verificar(fila.id);
      if (res.ok) {
        toast.success(
          `"${fechaDeId(fila.id)}" está sano: ${res.ventas} venta(s), esquema v${res.userVersion}`,
          { autoClose: 6000 }
        );
      } else {
        toast.error(`"${fechaDeId(fila.id)}" NO sirve para restaurar: ${res.motivo}`, {
          autoClose: 12000,
        });
      }
      await cargar({ suprimeCargando: true });
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudo verificar el respaldo"));
    } finally {
      setVerificando(null);
    }
  };

  const restaurar = async () => {
    if (!porRestaurar) return;
    setRestaurando(true);
    try {
      const res = await backupAPI.restaurar(porRestaurar.id);
      setPorRestaurar(null);
      // NOT a toast, and not a reload. The database underneath every screen was just replaced, so
      // the honest thing is to say what came back and let the operator reload deliberately, when
      // they have read the number.
      //
      // AND WHAT HAPPENS TO THE SESSION IS NOT WHAT A FIRST READING ASSUMES. An earlier version of
      // this comment said the session "was part of" what got replaced, which is false and was worth
      // removing rather than softening: `session.js` holds the operator as an in-memory `activo` in
      // MAIN. Restoring a file does not touch it, it is not persisted, and nothing rebuilds it. So
      // after a restore the session is still open — and that is exactly the problem, because the
      // window keeps drawing rows it read before the file changed.
      //
      // It ends only INCIDENTALLY, and only for some restores: `actual()` re-reads the `users` row
      // on every call and nulls itself when that row is gone, so restoring an archive taken before
      // this operator existed signs them out, while restoring one taken after leaves them signed in.
      // Neither is a designed consequence of restoring, and the comment should not pretend otherwise.
      //
      // The reload is therefore for the DATA, not for the session — `main` survives a window reload,
      // which is the same reason a renderer reload does not log anybody out.
      setRestaurado(res);
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudo restaurar el respaldo"), { autoClose: 12000 });
      setPorRestaurar(null);
      await cargar({ suprimeCargando: true });
    } finally {
      setRestaurando(false);
    }
  };

  const podar = async () => {
    setPodando(true);
    try {
      const res = await backupAPI.podar(conservar);
      const fallos = res.fallidos?.length ?? 0;
      toast.success(
        `Se eliminaron ${res.eliminados.length} respaldo(s) y se liberaron ${formatearBytes(res.liberadoBytes)}` +
          (fallos ? `. ${fallos} no se pudieron borrar.` : ""),
        { autoClose: fallos ? 10000 : 5000 }
      );
      setPorPodar(false);
      await cargar({ suprimeCargando: true });
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudo limpiar"));
    } finally {
      setPodando(false);
    }
  };

  const ocupado = creando || restaurando || podando || verificando !== null;

  return (
    <div>
      <div className="bar">
        <h2>Respaldos</h2>
        <div className="bar">
          <button
            className="btn-primary"
            onClick={crear}
            disabled={ocupado}
            data-testid="crear-respaldo"
          >
            <i className={`fa-solid ${creando ? "fa-spinner fa-spin" : "fa-plus"}`} aria-hidden="true"></i>{" "}
            {creando ? "Respaldando…" : "Crear respaldo"}
          </button>
          <button
            className="btn-secondary"
            onClick={() => setPorPodar(true)}
            disabled={ocupado || filas.length === 0}
            data-testid="podar-respaldos"
          >
            <i className="fa-solid fa-trash" aria-hidden="true"></i> Limpiar viejos
          </button>
        </div>
      </div>

      {/* The progress line. It exists because a backup takes seconds, and an unchanged button for
          seconds is a button somebody presses twice — which starts a second copy. */}
      {progreso ? (
        <div className="card" style={{ marginBottom: 16 }} data-testid="progreso-respaldo">
          <span style={{ fontSize: 14 }}>
            <i className="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> {progreso}
          </span>
        </div>
      ) : null}

      {restaurado ? (
        <div className="card" style={{ marginBottom: 16, borderColor: "var(--kanagawa-green)" }}>
          <h3 className="mm-sub" style={{ marginTop: 0 }}>
            <i className="fa-solid fa-circle-check" style={{ color: "var(--kanagawa-green)" }} aria-hidden="true"></i>{" "}
            Respaldo restaurado
          </h3>
          <p style={{ fontSize: 14 }}>
            La base volvió al estado del <strong>{fechaDeId(restaurado.id)}</strong>: {restaurado.ventas}{" "}
            venta(s) y esquema v{restaurado.userVersion}.
          </p>
          <p style={{ fontSize: 13, color: "var(--kanagawa-fg-muted)" }}>
            Antes de tocar nada se guardó el estado anterior como{" "}
            <strong>{fechaDeId(restaurado.seguridad)}</strong>. Si restaurabas el respaldo equivocado,
            restaura ese y volvés atrás.
          </p>
          <p style={{ fontSize: 13, color: "var(--kanagawa-orange)" }}>
            <strong>Recargá la ventana</strong> (Ctrl+R) o cerrá y abrí la app: las pantallas siguen
            mostrando los datos de la base anterior. Si el respaldo es más viejo que tu usuario, al
            recargar vas a tener que entrar de nuevo.
          </p>
          <div className="form-row">
            <button className="btn-primary" onClick={() => window.location.reload()}>
              <i className="fa-solid fa-rotate" aria-hidden="true"></i> Recargar ahora
            </button>
            <button className="btn-secondary" onClick={() => setRestaurado(null)}>
              Entendido
            </button>
          </div>
        </div>
      ) : null}

      <div className="card" style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: "var(--kanagawa-fg-muted)", margin: 0 }}>
          Un respaldo es <strong>una copia completa de la base</strong>: catálogo, ventas, caja,
          cuentas corrientes y usuarios. Se guarda en{" "}
          <code style={{ fontSize: 12 }}>{dir ?? "la carpeta de datos"}</code> — copiá esa carpeta a
          un pendrive para tenerlo fuera de la máquina.
        </p>
      </div>

      {loading ? (
        <p>Cargando respaldos…</p>
      ) : filas.length === 0 ? (
        <div className="card">
          <p>
            Todavía no hay respaldos. Creá el primero antes de hacer algo importante: cambiar precios
            en masa, restaurar datos de otro sistema o mover la app de máquina.
          </p>
        </div>
      ) : (
        <div className="table-container">
          <table className="product-list">
            <thead>
              <tr>
                <th>Fecha</th>
                <th style={{ textAlign: "right" }}>Tamaño</th>
                <th style={{ textAlign: "right" }}>Ventas</th>
                <th>Esquema</th>
                <th>Origen</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filas.map((f) => {
                const desalineado =
                  f.bytesEsperados !== null && f.bytesEsperados !== undefined && f.bytesEsperados !== f.bytes;
                return (
                  <tr key={f.id} data-testid={`respaldo-${f.id}`}>
                    <td>
                      {fechaDeId(f.id)}
                      {f.motivo === "antes-de-restaurar" ? (
                        <div style={{ fontSize: 12, color: "var(--kanagawa-orange)" }}>
                          copia automática antes de restaurar
                        </div>
                      ) : null}
                      {f.nota ? (
                        <div style={{ fontSize: 12, color: "var(--kanagawa-fg-muted)" }}>{f.nota}</div>
                      ) : null}
                    </td>
                    <td style={{ textAlign: "right" }}>{formatearBytes(f.bytes)}</td>
                    <td style={{ textAlign: "right" }}>{f.ventas ?? "—"}</td>
                    <td>{f.userVersion === null ? "—" : `v${f.userVersion}`}</td>
                    <td style={{ fontSize: 12 }}>
                      {f.origen === "manifiesto" ? (
                        f.motivo === "manual" ? (
                          "Manual"
                        ) : (
                          (f.motivo ?? "—")
                        )
                      ) : (
                        <span style={{ color: "var(--kanagawa-fg-muted)" }}>sin manifiesto</span>
                      )}
                    </td>
                    <td>
                      {/* Three states, and the middle one matters: an archive nobody recorded
                          anything about is not broken, it is unverified — and the row says so
                          rather than showing a red mark for a file that may restore perfectly. */}
                      {desalineado ? (
                        <span className="status cancelled" title="El archivo cambió de tamaño desde que se creó">
                          Alterado
                        </span>
                      ) : f.verificado ? (
                        <span className="status active-s">Verificado</span>
                      ) : (
                        <span className="status pending">Sin verificar</span>
                      )}
                    </td>
                    <td>
                      <button
                        className="btn-secondary"
                        onClick={() => verificar(f)}
                        disabled={ocupado}
                        data-testid={`verificar-${f.id}`}
                      >
                        {verificando === f.id ? "Verificando…" : "Verificar"}
                      </button>{" "}
                      <button
                        className="btn-danger"
                        onClick={() => setPorRestaurar(f)}
                        disabled={ocupado}
                        data-testid={`restaurar-${f.id}`}
                      >
                        Restaurar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {porRestaurar ? (
        <Modal
          isOpen
          onClose={() => setPorRestaurar(null)}
          title={`Restaurar el respaldo del ${fechaDeId(porRestaurar.id)}`}
        >
          {/* This confirmation is not a yes/no. Restoring the wrong archive is the only operation in
              the app with no undo, so the dialog states what will be replaced, what happens to the
              current data, and how to come back. */}
          <p>
            <strong style={{ color: "var(--kanagawa-red)" }}>
              Se va a reemplazar la base actual entera
            </strong>{" "}
            por la del <strong>{fechaDeId(porRestaurar.id)}</strong>
            {porRestaurar.ventas !== null && porRestaurar.ventas !== undefined
              ? ` (${porRestaurar.ventas} venta(s))`
              : ""}
            .
          </p>
          <p>
            Todo lo que se cargó <strong>después</strong> de esa fecha se pierde: ventas, cobros,
            movimientos de caja y usuarios creados. El catálogo y los precios vuelven a como estaban.
          </p>
          <p style={{ fontSize: 13, color: "var(--kanagawa-fg-muted)" }}>
            Antes de tocar nada se guarda una <strong>copia automática del estado actual</strong>, así
            que si restaurás el respaldo equivocado podés volver restaurando esa copia.
          </p>
          {!porRestaurar.verificado ? (
            <p style={{ fontSize: 13, color: "var(--kanagawa-orange)" }}>
              <i className="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> Este respaldo no
              está verificado todavía. Se va a verificar antes de restaurarlo, y si no sirve no se
              toca nada.
            </p>
          ) : null}
          <div className="form-row">
            <button
              className="btn-danger"
              onClick={restaurar}
              disabled={restaurando}
              data-testid="confirmar-restaurar"
            >
              {restaurando ? "Restaurando…" : "Sí, restaurar"}
            </button>
            <button className="btn-secondary" onClick={() => setPorRestaurar(null)}>
              Cancelar
            </button>
          </div>
        </Modal>
      ) : null}

      {porPodar ? (
        <Modal isOpen onClose={() => setPorPodar(false)} title="Limpiar respaldos viejos" size="sm">
          <p>
            Se conservan los <strong>más nuevos</strong> y se borran los demás. Los respaldos se
            borran con su ficha, y lo que se borra <strong>no se puede recuperar</strong>.
          </p>
          <div className="form-group">
            <label htmlFor="podar-conservar">Cuántos conservar</label>
            <input
              id="podar-conservar"
              className="input-field"
              type="number"
              min="1"
              value={conservar}
              onChange={(e) => setConservar(e.target.value)}
            />
            <small style={{ color: "var(--kanagawa-fg-muted)" }}>
              Hay {filas.length} respaldo(s). Se van a borrar{" "}
              {Math.max(0, filas.length - (Number(conservar) || 0))}.
            </small>
          </div>
          <div className="form-row">
            <button
              className="btn-danger"
              onClick={podar}
              disabled={podando || Math.max(0, filas.length - (Number(conservar) || 0)) === 0}
              data-testid="confirmar-podar"
            >
              {podando ? "Limpiando…" : "Sí, limpiar"}
            </button>
            <button className="btn-secondary" onClick={() => setPorPodar(false)}>
              Cancelar
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
};

export default Respaldos;
