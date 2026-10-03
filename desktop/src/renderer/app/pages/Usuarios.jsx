import React, { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { mensajeDeError } from "../api/ipc";
import Modal from "../components/common/Modal";

/**
 * THE PEOPLE WHO CAN TAKE THE TILL.
 *
 * The list is the answer `auth.me` already brings — one call the shell was making anyway, now
 * carrying one more field — because §L has no `usuarios` group to read it with, and adding one
 * would move the frozen contract off 89. Creating somebody is `auth.register` with a session
 * open, which is the same call the first launch makes: the branch is chosen by whether anybody
 * is signed in, not by a flag the window sends.
 *
 * The roles are the web's three, spelled the web's way: `admin` (the dueño), `supervisor` and
 * `vendedor`. Nothing here invents a fourth.
 *
 * WHY THE OWNER SEES A "sin contraseña" MARKER. The web has a users list and a form that renders
 * nothing, so an employee can exist there with no way to sign in and no way to tell. Here the
 * list is built from `users` LEFT JOINED to the credential, so somebody who exists but was never
 * given a password is visible as exactly that — a fact the owner can act on instead of a person
 * who mysteriously cannot work the till.
 */
const Usuarios = () => {
  const { personas, register, negocio, actual, restablecerPassword } = useAuth();
  const [abierto, setAbierto] = useState(false);
  const [nombre, setNombre] = useState("");
  const [nombreAcceso, setNombreAcceso] = useState("");
  const [rol, setRol] = useState("vendedor");
  const [password, setPassword] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState(null);
  const [exito, setExito] = useState(null);
  /* The reset dialog is a SECOND modal state, not a mode of the create modal: creating somebody and
     changing a password of somebody who already works here are different acts, and folding them
     into one form would let the owner reset a password while the "new employee" fields sit there
     half filled. */
  const [reseteando, setReseteando] = useState(null);
  const [passwordNueva, setPasswordNueva] = useState("");

  const cerrar = () => {
    setAbierto(false);
    setNombre("");
    setNombreAcceso("");
    setRol("vendedor");
    setPassword("");
    setError(null);
  };

  const cerrarReset = () => {
    setReseteando(null);
    setPasswordNueva("");
    setError(null);
  };

  const restablecer = async (evento) => {
    evento.preventDefault();
    setOcupado(true);
    setError(null);
    try {
      /* No old password, and that is the point: `auth.changePassword` only demands one when the
         target is yourself. This is the owner resetting somebody else's, so the owner is proving
         who they are with their own session, and the employee is not asked to remember a password
         they have forgotten. */
      await restablecerPassword(reseteando.id, passwordNueva);
      setExito(
        `La contraseña de ${reseteando.nombre} quedó restablecida. Avisale cuando pueda: ` +
          `la próxima vez que entre, MiniMarck le va a pedir la nueva.`
      );
      cerrarReset();
    } catch (err) {
      setError(mensajeDeError(err, "No se pudo restablecer la contraseña"));
    } finally {
      setOcupado(false);
    }
  };

  const crear = async (evento) => {
    evento.preventDefault();
    setOcupado(true);
    setError(null);
    try {
      const creado = await register({ nombre, nombreAcceso, password, rol });
      setExito(`${creado.nombre} ya puede entrar con su nombre y su contraseña.`);
      setNombre("");
      setNombreAcceso("");
      setPassword("");
    } catch (err) {
      setError(mensajeDeError(err, "No se pudo crear el usuario"));
    } finally {
      setOcupado(false);
    }
  };

  return (
    <div className="card">
      <div className="card-header">
        <h3>Usuarios de {negocio?.nombre || "la tienda"}</h3>
        <button className="btn-primary" onClick={() => { setAbierto(true); setExito(null); }}>
          <i className="fa-solid fa-user-plus"></i> Nuevo empleado
        </button>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Nombre de acceso</th>
            <th>Rol</th>
            <th>Último ingreso</th>
            <th aria-label="Acciones"></th>
          </tr>
        </thead>
        <tbody>
          {personas.map((p) => (
            <tr key={p.id}>
              <td>{p.nombre}</td>
              <td>{p.email}</td>
              <td>{p.rol}</td>
              <td>
                {p.puedeIngresar
                  ? p.ultimoAcceso
                    ? new Date(p.ultimoAcceso).toLocaleString("es")
                    : "nunca"
                  : <span style={{ color: "#f59e0b" }}>sin contraseña</span>}
              </td>
              <td>
                {/* Only for somebody who HAS a password, and only for somebody else. Resetting your
                    own password is a different screen (`Acceso`) that asks for the current one —
                    offering it here would let the owner "reset" themselves without ever proving
                    they know their own password, which is exactly the proof the sign-in screen is
                    for. And there is no button on a row that cannot be reset: `auth.changePassword`
                    would refuse with SIN_CREDENCIAL, and a button that only ever fails is a lie
                    about what the owner can do. */}
                {actual?.rol === "admin" && p.puedeIngresar && p.id !== actual.id && (
                  <button
                    className="btn-secondary btn-sm"
                    data-testid={`resetear-${p.email}`}
                    onClick={() => { setReseteando(p); setExito(null); setError(null); }}
                  >
                    <i className="fa-solid fa-key"></i> Restablecer
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {exito && <div className="acceso-ok">{exito}</div>}

      {abierto && (
        <Modal isOpen={abierto} onClose={cerrar} title="Nuevo empleado" size="sm">
          <form onSubmit={crear}>
            <div className="form-group">
              <label htmlFor="usuario-nombre">Nombre</label>
              <input id="usuario-nombre" data-testid="usuario-nombre" value={nombre}
                onChange={(e) => setNombre(e.target.value)} placeholder="Ana Ruiz" />
            </div>
            <div className="form-group">
              <label htmlFor="usuario-acceso">Nombre de acceso</label>
              <input id="usuario-acceso" data-testid="usuario-acceso" value={nombreAcceso}
                onChange={(e) => setNombreAcceso(e.target.value)} placeholder="ana" />
            </div>
            <div className="form-group">
              <label htmlFor="usuario-rol">Rol</label>
              <select id="usuario-rol" data-testid="usuario-rol" value={rol}
                onChange={(e) => setRol(e.target.value)}>
                <option value="vendedor">vendedor</option>
                <option value="supervisor">supervisor</option>
                <option value="admin">dueño (admin)</option>
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="usuario-password">Contraseña</label>
              <input id="usuario-password" data-testid="usuario-password" type="password"
                value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="Mínimo 8 caracteres" autoComplete="new-password" />
            </div>
            {error && <div className="acceso-error">{error}</div>}
            {exito && <div className="acceso-ok">{exito}</div>}
            <button type="submit" className="btn-primary" data-testid="usuario-crear"
              disabled={ocupado}>
              {ocupado ? "Creando…" : "Crear y que pueda entrar"}
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
};

export default Usuarios;
