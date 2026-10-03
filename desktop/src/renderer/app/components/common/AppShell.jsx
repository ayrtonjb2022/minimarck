import React from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../context/ThemeContext";
import ControlesDeTurno from "./ControlesDeTurno";

/**
 * EL CROMO DE LA APLICACIÓN, EN UN SOLO COMPONENTE.
 *
 * `App.jsx` tenía catorce rutas y catorce copias de
 * `<div className="app-layout"><main className="main"><TopBar …/><Page /></main></div>`.
 * Duplicado catorce veces, el mismo `<div className="main">` no es un detalle: es catorce
 * lugares donde un cambio de cromo hay que recordar aplicar, y el sitio donde se olvidaría
 * es la mitad de las pantallas. Una sola definición, un solo lugar al que mirar.
 *
 * `TopBar` no desaparece como concepto: pasa a ser la barra delgada de arriba. Lo que se
 * mueve es la tira de doce enlaces, que era el problema.
 */

/**
 * LOS ROLES, COMO LOS DICE EL RESTO DE LA APLICACIÓN.
 *
 * `Usuarios.jsx` los escribe en el `<select>` exactamente así — `vendedor`, `supervisor`,
 * `admin (dueño)` — y los comentarios de `AuthContext` llaman `admin` "el dueño". Acá se
 * capitaliza porque es el pie de la barra lateral, no un valor de formulario. La clave ES
 * el dato crudo: no se reescribe ni se normaliza, para que el pie diga exactamente el rol
 * que main guardó.
 */
const ROLES = { admin: "Dueño", supervisor: "Supervisor", vendedor: "Vendedor" };

/**
 * EL MENÚ: DOCE ENTRADAS, CUATRO SECCIONES, EN VEZ DE DOCE ENLACES SEGUIDOS.
 *
 * La tira horizontal anterior metía las doce pantallas en una sola fila de 1280px. A esa
 * altura doce textos no forman una barra: forman un muro. Nada dice cuál es la pantalla de
 * arranque, cuál es configuración y cuál es la que se mira a la mañana, y a 100% de zoom
 * los últimos enlaces ya no entran en la ventana.
 *
 * `styles/index.css` hacía años que traía el diseño entero de una barra lateral —
 * `.sidebar`, `.sidebar-menu`, `.sub-label`, `.avatar-mini`, `.sidebar.collapsed`, los
 * `@media` que la achican a 72px — y no había ni un `.jsx` que lo montara. Este componente
 * es el que lo monta, así que la hoja no se rediseñó: se le dio el markup que ya estaba
 * escrito y se dejó de tirar CSS muerto.
 *
 * DENTRO DE CADA SECCIÓN EL ORDEN ES EL QUE TENÍA LA TIRA, sin reordenar nada: lo que se
 * movió es de qué sección es cada cosa. La lectura de punta a punta es la del dueño —
 * vender, consultar, abastecer, administrar — y las cuatro secciones se nombran con el
 * `.sub-label` que la hoja ya definía y que hasta ahora nadie escribía.
 */
const SECCIONES = [
  {
    titulo: "Vender",
    entradas: [
      { to: "/pos", etiqueta: "Vender", icono: "fa-cash-register" },
      { to: "/ventas", etiqueta: "Ventas", icono: "fa-receipt" },
    ],
  },
  {
    titulo: "Consultar",
    entradas: [
      /* El panel y los reportes son las dos pantallas que RESPONDEN una pregunta en vez de
         registrar algo, así que abren la segunda sección en vez de cerrar la barra: el
         operador que abre la app un lunes a la mañana quiere los números primero. Lo que
         antes las ponía "al principio de la tira" ahora es "primera sección de consulta", y
         es el mismo criterio: leer el negocio va antes que tocarlo. */
      { to: "/dashboard", etiqueta: "Panel", icono: "fa-gauge-high" },
      { to: "/reportes/ventas", etiqueta: "Reportes", icono: "fa-chart-column" },
      { to: "/deudores", etiqueta: "Deudores", icono: "fa-coins" },
    ],
  },
  {
    titulo: "Abastecer",
    entradas: [
      /* Todo lo que mete mercadería: los proveedores, las compras, y el catálogo con las
         cubetas en que está ordenado. El catálogo responde "¿qué vende este negocio y a
         cuánto?", que es la pregunta que uno se hace justo antes de pasar algo por el
         mostrador — por eso van juntos y no escondidos detrás de un menú de ajustes que acá
         no existe. */
      { to: "/proveedores", etiqueta: "Proveedores", icono: "fa-truck-field" },
      { to: "/compras", etiqueta: "Compras", icono: "fa-cart-plus" },
      { to: "/productos", etiqueta: "Catálogo", icono: "fa-box-open" },
      { to: "/categorias", etiqueta: "Categorías", icono: "fa-tags" },
    ],
  },
  {
    titulo: "Administrar",
    entradas: [
      /* El libro contable. Va al final porque va al final en la cabeza del dueño: vender,
         comprar, y recién entonces mirar qué dicen los números. La tira de pestañas de la
         pantalla agrupa sus cuatro lecturas. */
      { to: "/contabilidad", etiqueta: "Contabilidad", icono: "fa-scale-balanced" },
      /* El archivo del negocio. Al final de todo, y sólo para quien puede administrar
         usuarios — el mismo predicado que mira la ruta. Una restauración reemplaza la base
         INCLUYENDO los usuarios, así que ofrecerla a un vendedor sería ofrecerle las llaves
         del negocio. */
      { to: "/respaldos", etiqueta: "Respaldos", icono: "fa-database", soloAdministraUsuarios: true },
      /* `/usuarios` es una ruta montada y filtrada por rol desde que llegó el acceso, y
         durante años sólo se llegaba escribiendo la URL a mano: nada en el cromo la
         enlazaba. El mismo defecto que el comentario de `ControlesDeTurno` le recuerda al
         relevo, y la misma solución: un enlace junto a lo que es suyo. Se muestra a los
         roles que la propia ruta admite, así que la barra no puede ofrecer una puerta que
         conteste "no".

         `soloAdministraUsuarios` NO es una regla nueva: es la bandera que dice "esto lo
         decide `puedeAdministrarUsuarios`", el predicado importado de `AuthContext` — que es
         exactamente `admin || supervisor`, el mismo que chequea la ruta. No se recalcula acá
         porque dos copias del mismo criterio son dos criterios que un día dejan de
         coincidir. */
      { to: "/usuarios", etiqueta: "Usuarios", icono: "fa-users", soloAdministraUsuarios: true },
    ],
  },
];

/**
 * LA BARRA LATERAL.
 *
 * `NavLink` y NO `<button onClick>`, en cada entrada, sin excepción. Los recorridos
 * automáticos (`payment-drive.js`, `deudores-drive.js`, `compras-drive.js`) cambian de
 * pantalla HACIENDO CLIC en `a[href="…"]`, y `payment-drive.js` además AFIRMA que ese
 * enlace existe en la pantalla del punto de venta. Un botón con `onClick` deja de ser un
 * enlace: el DOM deja de contestarle al selector y el recorrido falla moves. El `NavLink`
 * además lo resuelve solo — es el router el que decide si el destino es la ruta actual — y
 * le agrega `aria-current="page"`.
 */
const BarraLateral = ({ colapsado, onAlternar }) => {
  const { user, negocio, puedeAdministrarUsuarios } = useAuth();

  return (
    <aside className={`sidebar${colapsado ? " collapsed" : ""}`}>
      {/* La marca, con el nombre del negocio debajo y no al lado: en 260px el nombre del
          negocio al lado del nombre de la app no entra, y recortado a la mitad no dice
          qué negocio es — que es justo lo que un cajero tiene que comprobar cuando hay
          dos cajas en la misma máquina. */}
      <div className="sidebar-brand">
        <i className="fa-solid fa-store" aria-hidden="true"></i>
        <span>MiniMarck</span>
        {negocio?.nombre ? <span className="sidebar-shop">{negocio.nombre}</span> : null}
      </div>

      <ul className="sidebar-menu" aria-label="Secciones">
        {SECCIONES.map((seccion) => (
          <React.Fragment key={seccion.titulo}>
            <li className="sub-label">{seccion.titulo}</li>
            {seccion.entradas.map((entrada) => {
              if (entrada.soloAdministraUsuarios && !puedeAdministrarUsuarios) return null;

              return (
                /* El `<li>` es el hijo DIRECTO de `.sidebar-menu` y el enlace va adentro.
                   Toda la sección de la hoja está escrita sobre el `<li>`
                   (`.sidebar-menu li.active::before` y compañía), y `NavLink` dibuja un
                   `<a>`; si el `<a>` fuera el hijo, ninguna de esas reglas aplicaría. La
                   clase `active` la pone el router sobre el `<a>`, y el `::before` la
                   recoge el selector `li:has(> a.active)` de la hoja — con el porqué
                   escrito al lado. */
                <li key={entrada.to}>
                  <NavLink to={entrada.to}>
                    <i className={`fa-solid ${entrada.icono}`} aria-hidden="true"></i>
                    <span>{entrada.etiqueta}</span>
                  </NavLink>
                </li>
              );
            })}
          </React.Fragment>
        ))}
      </ul>

      {/* Un `<button>`, no un `<div onClick>` como el `Sidebar.jsx` que este componente
          reemplaza. La persona que pliega el menú tiene un teclado en la mano igual que
          tiene un mouse, y un control que no se puede alcanzar con el Tab es un control
          que para media tienda no existe. */}
      <button
        type="button"
        className="sidebar-collapse-btn"
        onClick={onAlternar}
        title={colapsado ? "Expandir menú" : "Colapsar menú"}
        aria-label={colapsado ? "Expandir el menú lateral" : "Colapsar el menú lateral"}
        aria-expanded={!colapsado}
      >
        <i
          className={colapsado ? "fa-solid fa-chevron-right" : "fa-solid fa-chevron-left"}
          aria-hidden="true"
        ></i>
      </button>

      {/* Quién está en el cajero, en el pie y no arriba: arriba es donde vive el nombre de
          la pantalla, y un operador que ve su nombre y el de la empresa mezclados en la
          misma línea termina creyendo que la sesión es de otro. */}
      <div className="sidebar-footer">
        <div className="avatar-mini">{(user?.nombre || "U")[0]}</div>
        <div className="user-info">
          <div className="name">{user?.nombre || "Usuario"}</div>
          <div className="role-text">{ROLES[user?.rol] || user?.rol || ""}</div>
        </div>
      </div>
    </aside>
  );
};



/**
 * LA BARRA DE ARRIBA, DELGADA. NO LA DE ENLACES.
 *
 * Lo que desaparece al pasar la navegación a la barra lateral es la TIRA: doce enlaces en
 * fila. Lo que queda acá NO es un top bar nuevo — es el mismo control de pantalla que
 * escribía `TopBar` en `App.jsx`, reducido a lo que no puede bajar a la barra lateral: en
 * qué pantalla estás, quién está en el cajero, y la salida. La marca y el nombre del
 * negocio bajaron con el menú, y la barra lateral ya los dibuja.
 *
 * `.mm-topbar-title` NO se renombra a gusto, y no es un nombre bonito: `src/main/index.js`
 * lo lee del DOM real para comprobar que un enlace profundo a `/ventas` montó la pantalla
 * de ventas y no una página de error (NAV-2). Ese probe es el mismo que quemó al `Navbar`,
 * y por eso `styles/index.css` conserva las tres clases.
 */
const BarraSuperior = ({ titulo }) => {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="mm-topbar">
      <div className="mm-topbar-title">{titulo}</div>

      <div className="mm-topbar-right">
        {/* EL CONTROL DE RELEVO. Este control ya no es una excepción del POS: antes vivía
            sólo en `ControlesDeTurno compacto` colgado de la fila del punto de venta,
            porque `/pos` se renderizaba fuera de `app-layout` y no había barra donde
            colgarlo. `/pos` ahora pasa por `AppShell` como todas las pantallas, así que el
            lugar natural es ESTE, y el POS conserva el suyo en compacto porque el relevo se
            pide con el ticket abierto en pantalla. Es el mismo control en los dos sitios:
            una definición, dos puntos de montaje, para que no puedan divergir.

            Antes de esto el relevo era una feature completa e INALCANZABLE — el botón
            colgaba de `Navbar` y `Sidebar`, archivos que este árbol de rutas no monta — y 29
            pruebas del módulo pasaban igual, porque ninguna monta un componente: sólo el
            recorrido a mano pudo preguntarle a la app real por ese `data-testid` y recibir
            `false`. */}
        <ControlesDeTurno />

        {/* Quién está en el cajero. El ROL también, con `title`: el mismo dato que el pie de
            la barra lateral, y acá en pequeño porque en la barra sirve para la sesión, no
            para presentar al equipo. */}
        {user?.nombre ? (
          <span className="mm-turno-quien" title={`Rol: ${user.rol}`}>
            {user.nombre}
          </span>
        ) : null}

        <button
          type="button"
          className="theme-toggle"
          onClick={toggleTheme}
          title={theme === "light" ? "Modo oscuro" : "Modo claro"}
          aria-label={theme === "light" ? "Cambiar a modo oscuro" : "Cambiar a modo claro"}
        >
          <i className={`fa-solid ${theme === "light" ? "fa-moon" : "fa-sun"}`} aria-hidden="true"></i>
        </button>

        {/* LA SALIDA DE LA SESIÓN, en el cromo que esta app REALMENTE monta. Vivía sólo en
            `Navbar`/`Sidebar`, que el árbol de rutas nunca renderizó: una salida definida e
            inalcanzable, el mismo agujero que el comentario de arriba le recuerda al relevo.
            `AuthContext.logout` borra la sesión y `isAuthenticated` da vuelta, así que el
            shell cambia `<Routes>` por `<Acceso />`; el botón es la mitad del operador de
            ese cambio.

            `data-testid="cerrar-sesion"` no es decoración: `tests/ui/reportes.spec.jsx`
            encuentra el botón por ahí, igual que lo encontraría una mano. */}
        {user ? (
          <button
            type="button"
            className="theme-toggle"
            onClick={logout}
            title="Cerrar sesión"
            aria-label="Cerrar sesión"
            data-testid="cerrar-sesion"
          >
            <i className="fa-solid fa-right-from-bracket" aria-hidden="true"></i>
          </button>
        ) : null}
      </div>
    </header>
  );
};

/**
 * EL LAYOUT COMPARTIDO: BARRA LATERAL + BARRA DE PANTALLA + CONTENIDO.
 *
 * Ahora TODO pasa por este layout: también `/pos` y `/ventas`. Esa unificación es lo que
 * jubila los cuatro `NavLink` que el POS cargaba en la fila de su buscador (`/ventas`,
 * `/deudores`, `/proveedores`, `/compras`), así que el motivo de ambos queda escrito acá,
 * una sola vez: `App.jsx` y `puntoDeVenta.jsx` apuntan a este docblock en vez de repetirlo.
 *
 * POR QUÉ EXISTÍAN, porque el motivo era real: `/pos` era la única ruta sin `app-layout`, o
 * sea sin barra lateral, y esos cuatro botones eran su única puerta de salida. El POS abre la
 * app —`/index.html` redirige a `/pos`—, así que sin ellos, después de cobrar, el cajero no
 * tenía forma de llegar a la lista de ventas, que es donde vive la cancelación de una venta,
 * y salir era reiniciar la app con el ticket abierto. Para `/deudores` el argumento era el
 * inverso: el POS es la única forma de fiar y el cajero está parado ahí con el ticket abierto.
 *
 * POR QUÉ SE FUERON: la barra lateral hace ese trabajo ahora, y en todas las pantallas, así
 * que los enlaces del POS sobraban. Los recorridos automáticos NO se rompieron al hacerlo —
 * `payment-drive.js` afirma que exista un `a[href="/ventas"]` en la pantalla del POS y ahora
 * lo encuentra en la barra lateral. Ese es el orden correcto: primero el cromo, después el
 * recorrido. Por eso las entradas `/ventas`, `/deudores`, `/proveedores` y `/compras` de
 * `SECCIONES` no son negociables: si la barra lateral dejara de ofrecerlas, el recorrido del
 * cobro y el de las compras volverían a romperse, y por una razón distinta a la original.
 *
 * `colapsado` y `onAlternar` bajan desde `App` a propósito: el estado vive mientras viva
 * la sesión. El botón de plegar muestra solo íconos cuando colapsado, tal como definía el
 * CSS existente.
 */
const AppShell = ({ titulo, colapsado, onAlternarColapsado, children }) => (
  <div className="app-layout">
    <BarraLateral colapsado={colapsado} onAlternar={onAlternarColapsado} />
    <main className="main">
      <BarraSuperior titulo={titulo} />
      {children}
    </main>
  </div>
);

export default AppShell;
