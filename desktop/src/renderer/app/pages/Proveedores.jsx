import React, { useCallback, useEffect, useState } from "react";
import { proveedoresAPI } from "../api/proveedores";
import { mensajeDeError } from "../api/ipc";
import { toast } from "react-toastify";
import { formatCentavos, formatDate } from "../utils/formatters";
import Modal from "../components/common/Modal";

/**
 * Proveedores — who this shop buys from, and what it still owes them.
 *
 * WHAT A PERSON CAN DO HERE:
 *
 *   - see every supplier, with what is still owed next to their name
 *   - find one by name, tax id, phone, email or contact
 *   - add a supplier and edit one, including deactivating somebody they stopped buying from
 *   - see the purchases made from a supplier, and how much of it is still unpaid
 *
 * THE OWED FIGURE IS NEVER COMPUTED HERE. `comprasPendientesCentavos` is the repository's, summed
 * from the purchases still marked `pendiente`, and it is read back into the row after every action
 * that could change it. A total the screen added up itself would be a second implementation of one
 * subtraction, and the two would disagree the first time a purchase was cancelled.
 *
 * THE FORM SENDS ONLY WHAT CHANGED. An omitted field means "leave it alone" and an empty string
 * means "clear it", which is the difference the repository's partial update is built around — so
 * editing a phone number here cannot quietly wipe the email.
 *
 * THE REMOVE BUTTON IS HERE ON PURPOSE, and it can lose. A supplier with purchases in foot is
 * refused with a 409, because deleting them would leave every one of those purchases pointing at a
 * name that no longer appears in any list. The screen reads that refusal and offers "desactivar"
 * instead, which stops the supplier appearing in the buying screen while keeping the record.
 */

const PAGE_SIZE = 20;

const VACIO = { nombre: "", ruc: "", contacto: "", telefono: "", email: "", direccion: "", notas: "" };

const Proveedores = () => {
  const [proveedores, setProveedores] = useState([]);
  const [total, setTotal] = useState(0);
  const [pagina, setPagina] = useState(0);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [guardando, setGuardando] = useState(false);
  const [porEliminar, setPorEliminar] = useState(null);
  const [eliminando, setEliminando] = useState(false);

  const cargar = useCallback(async ({ suprimeCargando = false } = {}) => {
    if (!suprimeCargando) setLoading(true);
    try {
      const res = await proveedoresAPI.listar({ search, limit: PAGE_SIZE, offset: pagina * PAGE_SIZE });
      setProveedores(res.filas ?? []);
      setTotal(res.total ?? 0);
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudieron cargar los proveedores"));
    } finally {
      setLoading(false);
    }
  }, [search, pagina]);

  useEffect(() => { cargar(); }, [cargar]);

  // The box is debounced rather than fired on every keystroke, and the page resets first: a search
  // for a name that only exists on page 3 would otherwise land on an empty page 1 and read as
  // "no results".
  useEffect(() => {
    const t = setTimeout(() => { setPagina(0); }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const guardar = async (e) => {
    e.preventDefault();
    setGuardando(true);
    try {
      if (form.id) {
        // Only the fields the form actually holds, and only those the operator touched: the
        // repository treats an absent key as "leave it" and an empty string as "clear it".
        await proveedoresAPI.actualizar(form.id, {
          nombre: form.nombre,
          ruc: form.ruc,
          contacto: form.contacto,
          telefono: form.telefono,
          email: form.email,
          direccion: form.direccion,
          notas: form.notas
        });
        toast.success("Proveedor actualizado");
      } else {
        await proveedoresAPI.crear({ ...form });
        toast.success("Proveedor creado");
      }
      setForm(null);
      await cargar({ suprimeCargando: true });
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudo guardar el proveedor"));
    } finally {
      setGuardando(false);
    }
  };

  const alternarActivo = async (p) => {
    try {
      await proveedoresAPI.actualizar(p.id, { activo: !p.activo });
      toast.success(p.activo ? "Proveedor desactivado" : "Proveedor activado");
      await cargar({ suprimeCargando: true });
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudo cambiar el estado"));
    }
  };

  /**
   * Deleting a supplier asks first, through a `Modal` and not a `window.confirm`.
   *
   * Same reason as the purchase screen: a native prompt blocks the renderer, no other screen in this
   * app uses one, and the drive harness can click a DOM button but cannot answer a native dialog. The
   * confirmation also says the delete is SOFT, because "Eliminar" on a supplier reads as permanent
   * and it is not.
   */
  const eliminar = async () => {
    if (!porEliminar) return;
    setEliminando(true);
    try {
      await proveedoresAPI.eliminar(porEliminar.id);
      toast.success(`Proveedor ${porEliminar.nombre} eliminado`);
      setPorEliminar(null);
      await cargar({ suprimeCargando: true });
    } catch (err) {
      // A supplier with purchases in foot is the normal case here, and the repository's message says
      // what to do instead. Showing its own sentence is the point of the 409 carrying one.
      toast.error(mensajeDeError(err, "No se pudo eliminar el proveedor"), { autoClose: 9000 });
      setPorEliminar(null);
    } finally {
      setEliminando(false);
    }
  };

  const paginas = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    // A bare `<div>`, and the reason is not cosmetic. `styles/index.css:304` carries a leftover
    // from the web shell: `.page { display: none }` with `.page.active { display: block }`, because
    // there the pages were all in one document and a class toggled which was visible. This app uses
    // react-router and renders one route at a time, so nothing ever adds `.active`.
    //
    // With `className="page"` the whole screen was `display: none`: the heading, the search box and
    // the "Nuevo proveedor" button all existed, all were in the DOM, and none of them were ever
    // painted. Every `querySelector` for them succeeded, so the drive typed into a field the user
    // could not see and clicked a button that was not there. Deudores and Ventas, the screens that
    // work, both start from a bare `<div>`; this one now matches them.
    <div>
      <div className="bar">
        <h2>Proveedores</h2>
        <div className="bar">
          <input
            className="filter-input"
            type="search"
            placeholder="Buscar por nombre, RUC, teléfono o contacto"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Buscar proveedor"
          />
          <button className="btn-primary" onClick={() => setForm({ ...VACIO })}>
            <i className="fa-solid fa-plus" aria-hidden="true"></i> Nuevo proveedor
          </button>
        </div>
      </div>

      {loading ? (
        <p>Cargando proveedores…</p>
      ) : proveedores.length === 0 ? (
        <div className="card">
          <p>
            {search
              ? `Ningún proveedor coincide con "${search}".`
              : "Todavía no hay proveedores. Creá uno para poder registrar compras."}
          </p>
        </div>
      ) : (
        <div className="table-container">
          <table className="product-list">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>RUC</th>
                <th>Contacto</th>
                <th>Teléfono</th>
                <th>Compras</th>
                <th>Pendiente</th>
                <th>Última compra</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {proveedores.map((p) => (
                <tr key={p.id}>
                  <td>{p.nombre}</td>
                  <td>{p.ruc ?? "—"}</td>
                  <td>{p.contacto ?? "—"}</td>
                  <td>{p.telefono ?? "—"}</td>
                  <td>{p.comprasTotales}</td>
                  {/* Straight from the repository's derived figure, formatted here and nowhere else. */}
                  <td>{p.comprasPendientesCentavos > 0 ? formatCentavos(p.comprasPendientesCentavos) : "—"}</td>
                  <td>{p.ultimaCompraAt ? formatDate(p.ultimaCompraAt) : "—"}</td>
                  <td>
                    <span className={`status ${p.activo ? "status-activo" : "status-inactivo"}`}>
                      {p.activo ? "Activo" : "Inactivo"}
                    </span>
                  </td>
                  <td>
                    <button className="btn-secondary" onClick={() => setForm({ ...VACIO, ...p })}>
                      Editar
                    </button>{" "}
                    <button className="btn-secondary" onClick={() => alternarActivo(p)}>
                      {p.activo ? "Desactivar" : "Activar"}
                    </button>{" "}
                    <button className="btn-danger" onClick={() => setPorEliminar(p)}>
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
          <button className="btn-secondary" disabled={pagina === 0} onClick={() => setPagina((p) => p - 1)}>
            Anterior
          </button>
          <span>
            Página {pagina + 1} de {paginas} · {total} proveedores
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

      {form ? (
        <Modal
          isOpen
          onClose={() => setForm(null)}
          title={form.id ? `Editar ${form.nombre}` : "Nuevo proveedor"}
        >
          <form onSubmit={guardar}>
            <div className="form-group">
              <label htmlFor="prov-nombre">Nombre *</label>
              <input
                id="prov-nombre"
                className="input-field"
                value={form.nombre}
                onChange={(e) => setForm({ ...form, nombre: e.target.value })}
                required
                minLength={2}
                maxLength={150}
              />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="prov-ruc">RUC</label>
                <input
                  id="prov-ruc"
                  className="input-field"
                  value={form.ruc ?? ""}
                  onChange={(e) => setForm({ ...form, ruc: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label htmlFor="prov-contacto">Contacto</label>
                <input
                  id="prov-contacto"
                  className="input-field"
                  value={form.contacto ?? ""}
                  onChange={(e) => setForm({ ...form, contacto: e.target.value })}
                />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="prov-telefono">Teléfono</label>
                <input
                  id="prov-telefono"
                  className="input-field"
                  value={form.telefono ?? ""}
                  onChange={(e) => setForm({ ...form, telefono: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label htmlFor="prov-email">Email</label>
                <input
                  id="prov-email"
                  className="input-field"
                  type="email"
                  value={form.email ?? ""}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="prov-direccion">Dirección</label>
              <input
                id="prov-direccion"
                className="input-field"
                value={form.direccion ?? ""}
                onChange={(e) => setForm({ ...form, direccion: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label htmlFor="prov-notas">Notas</label>
              <textarea
                id="prov-notas"
                className="input-field"
                value={form.notas ?? ""}
                onChange={(e) => setForm({ ...form, notas: e.target.value })}
              />
            </div>
            <div className="form-row">
              <button type="submit" className="btn-primary" disabled={guardando}>
                {guardando ? "Guardando…" : "Guardar"}
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
          title={`Eliminar a ${porEliminar.nombre}`}
        >
          <p>
            <strong>{porEliminar.nombre}</strong> va a dejar de aparecer en la lista y en el
            selector de compras.
          </p>
          <p>
            El borrado es <strong>suave</strong>: la ficha queda en la base, así que las compras
            anteriores siguen mostrando su nombre. Si el proveedor tiene compras en pie, el sistema
            lo va a rechazar y vas a tener que <strong>desactivarlo</strong> en su lugar.
          </p>
          <div className="form-row">
            <button
              className="btn-danger"
              data-testid="confirmar-eliminar-proveedor"
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

export default Proveedores;
