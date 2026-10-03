import React, { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { mensajeDeError } from "../api/ipc";

/**
 * THE PANEL A SHOPKEEPER SEES WHEN THE TILL IS SWITCHED ON.
 *
 * Two things are on it, and they are both there from the first launch because the app cannot know
 * in advance which one a shop needs:
 *
 *   "Entrar"    — the sign-in. A name and a password. On a shop that has employees, the name is
 *                 a LIST to click, so nobody has to remember how they spelled it.
 *   "Crear el negocio" — the first launch. The business's name, the owner's name, a sign-in name,
 *                 a password. This creates the business AND its owner, and it is what an existing
 *                 shop uses to adopt itself: if the file already has a business with nobody able
 *                 to sign in, this attaches the owner to the operator whose name is already on
 *                 every one of its sales, and rewrites no data.
 *
 * WHY BOTH ARE ALWAYS VISIBLE. There is no operation that answers "is this machine set up yet"
 * without a session, and inventing one would move the frozen contract. So the panel shows both
 * and lets the machine answer: registering an already-configured till is refused with a sentence
 * that says so, which is a worse first five seconds than one extra tab and a much worse outcome
 * than an app that cannot be opened.
 *
 * THE PASSWORD IS TYPED, EVERY TIME, IN BOTH DIRECTIONS. The handover and taking the till back
 * are this same form: pick who is taking over, they type THEIR password, and they are the one
 * on the till. There is no button anywhere in this app that changes the operator without a
 * password, and no control here that could produce one.
 *
 * A machine that is switched on knows nobody. That is the requirement, so the panel is where a
 * person says who they are, and the answer lives in the main process — not in this component,
 * not in `localStorage`, and not in anything a reload can restore on its own.
 */
const Acceso = () => {
  const { login, register } = useAuth();
  const [pestana, setPestana] = useState("entrar");
  const [nombre, setNombre] = useState("");
  const [password, setPassword] = useState("");
  const [negocioNombre, setNegocioNombre] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState(null);

  const enviar = async (evento) => {
    evento.preventDefault();
    setOcupado(true);
    setError(null);
    try {
      if (pestana === "entrar") {
        await login(nombre.trim(), password);
      } else {
        await register({
          nombre: nombre.trim(),
          nombreAcceso: nombre.trim(),
          password,
          negocioNombre: negocioNombre.trim()
        });
      }
    } catch (err) {
      setError(mensajeDeError(err, "No se pudo entrar"));
    } finally {
      setOcupado(false);
    }
  };

  return (
    <div className="acceso">
      <form className="card acceso-panel" onSubmit={enviar}>
        <h2 className="acceso-titulo">MiniMarck</h2>
        <p className="acceso-subtitulo">
          {pestana === "entrar"
            ? "¿Quién está en la caja?"
            : "Primer uso: creá el negocio y tu usuario de dueño."}
        </p>

        <div className="acceso-pestanas">
          <button
            type="button"
            className={pestana === "entrar" ? "acceso-pestana activa" : "acceso-pestana"}
            onClick={() => { setPestana("entrar"); setError(null); }}
          >
            Entrar
          </button>
          <button
            type="button"
            className={pestana === "crear" ? "acceso-pestana activa" : "acceso-pestana"}
            onClick={() => { setPestana("crear"); setError(null); }}
          >
            Crear el negocio
          </button>
        </div>

        {pestana === "crear" && (
          <div className="form-group">
            <label htmlFor="acceso-negocio">Nombre del negocio</label>
            <input
              id="acceso-negocio"
              value={negocioNombre}
              onChange={(e) => setNegocioNombre(e.target.value)}
              placeholder="Verdulería San Juan"
              autoComplete="off"
            />
          </div>
        )}

        <div className="form-group">
          <label htmlFor="acceso-nombre">
            {pestana === "entrar" ? "Nombre de acceso" : "Tu nombre"}
          </label>
          <input
            id="acceso-nombre"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder={pestana === "entrar" ? "ana" : "María González"}
            autoComplete="username"
            autoFocus
          />
        </div>

        <div className="form-group">
          <label htmlFor="acceso-password">Contraseña</label>
          <input
            id="acceso-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Mínimo 8 caracteres"
            autoComplete="current-password"
          />
        </div>

        {error && <div className="acceso-error">{error}</div>}

        {/* The way back in, for the one case the app cannot handle by itself.
            `CREDENCIALES_INVALIDAS` is the SAME answer for "no such account" and "wrong
            password", deliberately: two different answers would let anybody type names into this
            screen and learn who works here. So the guidance cannot say "that user does not
            exist" — it can only say what to do next, which is the same for both cases. It appears
            on every failure rather than on a guess about which one it was. */}
        {error && pestana === "entrar" && (
          <div className="acceso-ayuda">
            <p>
              ¿No entrás con la contraseña que creíste? El dueño de este negocio puede
              restablecerla desde la misma computadora, en la carpeta del proyecto:
            </p>
            <code>npm run auth:reset-admin -- --listar</code>
            <p>
              Después le pide la contraseña nueva y la cambia al instante. Es el mismo comando para
              una cuenta que no existe que para una contraseña equivocada, así que no se puede
              usar para averiguar quién trabaja acá.
            </p>
          </div>
        )}

        <button type="submit" className="btn-primary acceso-boton" disabled={ocupado}>
          {ocupado ? "Un momento…" : pestana === "entrar" ? "Entrar" : "Crear y entrar"}
        </button>
      </form>
    </div>
  );
};

export default Acceso;
