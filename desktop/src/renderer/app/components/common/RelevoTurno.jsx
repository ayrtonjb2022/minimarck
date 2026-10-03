import React, { useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { mensajeDeError } from "../../api/ipc";
import Modal from "./Modal";

/**
 * HANDING THE TILL OVER, AND TAKING IT BACK. One control, both directions.
 *
 * THE PASSWORD IS THE WHOLE FEATURE. The person taking the till types THEIR OWN password, and
 * the person giving it up types NOTHING that grants anything. There is no "cambiar de persona"
 * operation anywhere in this app, because a call that changed the operator without checking a
 * credential would be a lock that opens by itself — and the worst version of that bug is an
 * employee reaching the owner's account, which is the one thing the shopkeeper is buying.
 *
 * So the flow is: the current operator opens this, CLICKS the person taking over, and that
 * person types their own password. The main process verifies it against that person's own stored
 * secret and replaces the session. If the password is wrong, nothing changes and the till stays
 * with whoever was on it.
 *
 * The list shows EVERYONE in the shop, not only employees, and that is deliberate: the person on
 * the till needs to pick the OWNER to hand it back. "Taking control back" is not a separate
 * feature with its own rules; it is this dialog with a different row clicked, which is why it
 * cannot have a path that the handover does not.
 *
 * A person listed with no password cannot be picked, and says so on the row instead of failing
 * silently at the password step — the owner can see that an employee exists but has never been
 * given a password.
 */
const RelevoTurno = () => {
  const { user, personas, login } = useAuth();
  const [abierto, setAbierto] = useState(false);
  const [elegido, setElegido] = useState(null);
  const [password, setPassword] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState(null);

  const cerrar = () => {
    setAbierto(false);
    setElegido(null);
    setPassword("");
    setError(null);
  };

  const entrar = async (evento) => {
    evento.preventDefault();
    if (!elegido) return;
    // The HANDLE is what signs in, never `email`. The adopted legacy owner keeps an email
    // (`admin@minimarck.local`) that is not their access name, so handing that to `auth.login`
    // produced a picker that looked correct and refused every single handover.
    const handle = elegido.nombreAcceso ?? elegido.email;
    setOcupado(true);
    setError(null);
    try {
      await login(handle, password);
      cerrar();
    } catch (err) {
      setError(mensajeDeError(err, "No se pudo cambiar de persona"));
    } finally {
      setOcupado(false);
    }
  };

  return (
    <>
      <button
        className="btn-header"
        title="Relegar turno"
        data-testid="relevo-turno"
        onClick={() => setAbierto(true)}
      >
        <i className="fa-solid fa-user-switch"></i>
      </button>
      {abierto && (
        <Modal isOpen={abierto} onClose={cerrar} title="Relegar el turno" size="sm">
          <p style={{ fontSize: 13, color: "var(--kanagawa-comment)", marginTop: 0 }}>
            Elegí quién queda en la caja. Esa persona escribe su propia contraseña.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
            {personas.map((p) => (
              <button
                key={p.id}
                type="button"
                className={elegido?.id === p.id ? "relevo-fila activa" : "relevo-fila"}
                data-testid={`relevo-persona-${p.id}`}
                disabled={!p.puedeIngresar}
                onClick={() => { setElegido(p); setPassword(""); setError(null); }}
              >
                <span style={{ fontWeight: 600, color: "var(--kanagawa-fg)" }}>{p.nombre}</span>
                <span style={{ fontSize: 12, color: "var(--kanagawa-comment)" }}>
                  {p.rol}{p.id === user?.id ? " · estás vos" : ""}
                </span>
                {!p.puedeIngresar && (
                  <span style={{ fontSize: 12, color: "#f59e0b" }}>sin contraseña</span>
                )}
              </button>
            ))}
          </div>
          {elegido && (
            <form onSubmit={entrar}>
              <div className="form-group">
                <label htmlFor="relevo-password">Contraseña de {elegido.nombre}</label>
                <input
                  id="relevo-password"
                  data-testid="relevo-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  autoFocus
                />
              </div>
              {error && <div className="acceso-error">{error}</div>}
              <button
                type="submit"
                className="btn-primary"
                data-testid="relevo-confirmar"
                disabled={ocupado || password.length === 0}
              >
                {ocupado ? "Un momento…" : `Dejar la caja a ${elegido.nombre}`}
              </button>
            </form>
          )}
        </Modal>
      )}
    </>
  );
};

export default RelevoTurno;
