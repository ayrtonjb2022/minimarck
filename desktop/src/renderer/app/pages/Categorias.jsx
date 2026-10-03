import React, { useCallback, useEffect, useRef, useState } from "react";
import { categoriasAPI } from "../api/categorias";
import { productosAPI } from "../api/productos";
import { mensajeDeError } from "../api/ipc";
import { toast } from "react-toastify";
import Modal from "../components/common/Modal";

/**
 * Categorías — the buckets the catalogue is filed under, and the POS's filter row.
 *
 * ── WHY THIS IS A SCREEN AND NOT A FIELD ──────────────────────────────────────────────────────
 *
 * `categorias.list` was already implemented because the POS grid needed a filter and the
 * "fraccionar" flow needed somewhere to put a derived product. But nothing in the app could CREATE
 * a category: a shop whose products are all "Sin categoría" had a filter row with one option and no
 * way to add a second. The five `categorias.*` operations now all have handlers, so the screen that
 * uses them is what turns "the filter exists" into "the shop can organise its shelf".
 *
 * ── WHY THE PRODUCT COUNT IS ASKED FOR, AND WHY IT IS ASKED FOR HERE ──────────────────────────
 *
 * Deleting a category is REFUSED while active products still point at it (`CATEGORIA_CON_PRODUCTOS`,
 * 400) — the category is a filter row, so removing one in use would leave those products filed
 * under something that no longer resolves. An operator clicking "Eliminar" on a category holding
 * forty products has learned nothing except that the answer is no. The count is fetched per category
 * with `productos.list` and `limit: 1`, which is ONE row and a `total`: the cheapest query that can
 * answer "how many", and the only one the contract offers without adding an operation to the frozen
 * 89.
 *
 * ── AND WHY THE INACTIVE ONES ARE SHOWN ───────────────────────────────────────────────────────
 *
 * `categorias.list` answers ACTIVE categories only, because that is what the POS filter and the
 * product form's `<select>` need. This screen therefore keeps its OWN set — the active ones from
 * the list call, plus any it deactivated in this session — so that "Desactivar" does not make the
 * row vanish with no way back. That is a real asymmetry with `Productos`, which can ask for
 * everything, and it is stated here rather than hidden: the moment `categorias.list` accepts
 * `soloActivos`, this screen should use it and this paragraph should go.
 */

const VACIO = { nombre: "", descripcion: "", activo: true };

const Categorias = () => {
  const [categorias, setCategorias] = useState([]);
  const [conteos, setConteos] = useState({});
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [guardando, setGuardando] = useState(false);
  const [porEliminar, setPorEliminar] = useState(null);
  const [eliminando, setEliminando] = useState(false);

  /**
   * The rows deactivated DURING THIS SESSION, held in a REF rather than in state.
   *
   * `categorias.list` answers active categories only, so the moment one is deactivated it leaves
   * the list call's answer. Merging it back is what keeps the row visible and re-activatable — but
   * as STATE it would be a dependency of `cargar`, and `cargar` writes it, which is the render loop
   * the previous version had (`useEffect(() => cargar(), [cargar])` re-firing on every merge).
   *
   * A ref is the honest fix and not a workaround: this is a list of ids the SCREEN remembers, not
   * something it renders from. The rows themselves still render from `categorias`.
   */
  const inactivasRef = useRef([]);
  const recordarInactiva = useCallback((categoria) => {
    inactivasRef.current = [
      ...inactivasRef.current.filter((i) => i.id !== categoria.id),
      categoria,
    ];
  }, []);
  const olvidarInactiva = useCallback((id) => {
    inactivasRef.current = inactivasRef.current.filter((i) => i.id !== id);
  }, []);

  /**
   * The product count per category. Failures are NOT toasted: this is a courtesy figure next to a
   * delete button, and a shop whose catalogue call failed should still be able to rename a category.
   * A toast per category would be five toasts about something the operator did not ask for.
   */
  const cargarConteos = useCallback(async (lista) => {
    const pares = await Promise.all(
      lista.map(async (c) => {
        try {
          const res = await productosAPI.listar({ categoriaId: c.id, soloActivos: true, limit: 1 });
          return [String(c.id), res.total ?? 0];
        } catch {
          return [String(c.id), null];
        }
      })
    );
    setConteos(Object.fromEntries(pares));
  }, []);

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const activas = (await categoriasAPI.listar()) ?? [];
      // A category deactivated in this session is no longer in the list call's answer, so the ones
      // this screen remembers are merged back in, alphabetically, by name. Without this the row
      // would disappear on the very click that deactivated it, with no way to undo.
      const fusion = [
        ...activas,
        ...inactivasRef.current.filter((i) => !activas.some((a) => a.id === i.id)),
      ].sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" }));
      setCategorias(fusion);
      await cargarConteos(fusion);
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudieron cargar las categorías"));
    } finally {
      setLoading(false);
    }
  }, [cargarConteos]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const guardar = async (evento) => {
    evento.preventDefault();
    setGuardando(true);
    try {
      if (form.id) {
        const guardada = await categoriasAPI.actualizar(form.id, {
          nombre: form.nombre,
          descripcion: form.descripcion,
          activo: form.activo,
        });
        // The list call answers ACTIVE rows only, so a category that stays inactive has to be
        // remembered by this screen or it disappears on the click that deactivated it. The mutation
        // returns the row it wrote, which is what makes this exact instead of a re-read.
        if (guardada && guardada.activo === false) recordarInactiva(guardada);
        else olvidarInactiva(form.id);
        toast.success(`"${form.nombre}" actualizada`);
      } else {
        await categoriasAPI.crear({ nombre: form.nombre, descripcion: form.descripcion });
        toast.success(`"${form.nombre}" creada`);
      }
      setForm(null);
      await cargar();
    } catch (err) {
      // `CATEGORIA_NOMBRE_DUPLICADO` carries the name that collided; the repository's sentence is the
      // only thing that says WHICH category already exists.
      toast.error(mensajeDeError(err, "No se pudo guardar la categoría"), { autoClose: 9000 });
    } finally {
      setGuardando(false);
    }
  };

  const alternarActivo = async (c) => {
    try {
      const guardada = await categoriasAPI.actualizar(c.id, { activo: !c.activo });
      // Same rule as the form: an inactive row is remembered here, an active one is not.
      if (guardada && guardada.activo === false) recordarInactiva(guardada);
      else olvidarInactiva(c.id);
      toast.success(c.activo ? `"${c.nombre}" desactivada` : `"${c.nombre}" activada`);
      await cargar();
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudo cambiar el estado"));
    }
  };

  const eliminar = async () => {
    if (!porEliminar) return;
    setEliminando(true);
    try {
      await categoriasAPI.eliminar(porEliminar.id);
      toast.success(`"${porEliminar.nombre}" eliminada`);
      setPorEliminar(null);
      await cargar();
    } catch (err) {
      // The refusal is the NORMAL answer for a category in use, and its message already says what to
      // do instead. The row is kept in the modal's place and the operator is offered "desactivar".
      toast.error(mensajeDeError(err, "No se pudo eliminar la categoría"), { autoClose: 9000 });
      setPorEliminar((actual) => (actual ? { ...actual, rechazada: true } : actual));
    } finally {
      setEliminando(false);
    }
  };

  return (
    <div>
      <div className="bar">
        <h2>Categorías</h2>
        <div className="bar">
          <button
            className="btn-primary"
            onClick={() => setForm({ ...VACIO })}
            data-testid="nueva-categoria"
          >
            <i className="fa-solid fa-plus" aria-hidden="true"></i> Nueva categoría
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: "var(--kanagawa-fg-muted)", margin: 0 }}>
          Las categorías son el filtro del punto de venta: agrupan el catálogo para encontrar un
          producto rápido en el mostrador. Un producto sin categoría sigue siendo vendible.
        </p>
      </div>

      {loading ? (
        <p>Cargando categorías…</p>
      ) : categorias.length === 0 ? (
        <div className="card">
          <p>
            Todavía no hay categorías. Creá una (por ejemplo <strong>Bebidas</strong>) y después
            asignásela a tus productos.
          </p>
        </div>
      ) : (
        <div className="table-container">
          <table className="product-list">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Descripción</th>
                <th style={{ textAlign: "right" }}>Productos activos</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {categorias.map((c) => {
                const n = conteos[String(c.id)];
                return (
                  <tr key={c.id} style={c.activo ? undefined : { opacity: 0.6 }}>
                    <td>{c.nombre}</td>
                    <td>{c.descripcion ?? "—"}</td>
                    <td style={{ textAlign: "right" }}>
                      {n === null || n === undefined ? "—" : n}
                    </td>
                    <td>
                      <span className={`status ${c.activo ? "active-s" : "inactive-s"}`}>
                        {c.activo ? "Activa" : "Inactiva"}
                      </span>
                    </td>
                    <td>
                      <button
                        className="btn-secondary"
                        onClick={() => setForm({ ...VACIO, ...c })}
                      >
                        Editar
                      </button>{" "}
                      <button className="btn-secondary" onClick={() => alternarActivo(c)}>
                        {c.activo ? "Desactivar" : "Activar"}
                      </button>{" "}
                      {/* Offered only where it can succeed. A category with active products is
                          refused by the repository, and a button that always fails is a button that
                          teaches the operator to distrust the screen. */}
                      <button
                        className="btn-danger"
                        onClick={() => setPorEliminar({ ...c, rechazada: false })}
                        disabled={typeof n === "number" && n > 0}
                        title={
                          typeof n === "number" && n > 0
                            ? `Tiene ${n} producto(s) activo(s): desactivala en su lugar`
                            : undefined
                        }
                      >
                        Eliminar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {form ? (
        <Modal
          isOpen
          onClose={() => setForm(null)}
          title={form.id ? `Editar ${form.nombre}` : "Nueva categoría"}
          size="sm"
        >
          <form onSubmit={guardar}>
            <div className="form-group">
              <label htmlFor="cat-nombre">Nombre *</label>
              <input
                id="cat-nombre"
                className="input-field"
                value={form.nombre}
                onChange={(e) => setForm({ ...form, nombre: e.target.value })}
                required
                autoFocus
              />
            </div>
            <div className="form-group">
              <label htmlFor="cat-descripcion">Descripción</label>
              <textarea
                id="cat-descripcion"
                className="input-field"
                rows={2}
                value={form.descripcion ?? ""}
                onChange={(e) => setForm({ ...form, descripcion: e.target.value })}
              />
            </div>
            {form.id ? (
              <div className="form-group">
                <label
                  htmlFor="cat-activo"
                  style={{ display: "flex", alignItems: "center", gap: 8, textTransform: "none" }}
                >
                  <input
                    id="cat-activo"
                    type="checkbox"
                    checked={form.activo !== false}
                    onChange={(e) => setForm({ ...form, activo: e.target.checked })}
                  />
                  Aparece en el filtro del punto de venta
                </label>
              </div>
            ) : null}
            <div className="form-row">
              <button
                type="submit"
                className="btn-primary"
                disabled={guardando}
                data-testid="guardar-categoria"
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

      {porEliminar ? (
        <Modal
          isOpen
          onClose={() => setPorEliminar(null)}
          title={`Eliminar ${porEliminar.nombre}`}
        >
          {porEliminar.rechazada ? (
            <>
              <p>
                <strong>{porEliminar.nombre}</strong> tiene productos activos, así que no se puede
                eliminar: esos productos quedarían archivados bajo una categoría que ya no existe y
                el filtro del punto de venta mostraría una opción que nunca encuentra nada.
              </p>
              <p>
                Si ya no la usás, <strong>desactivála</strong>: deja de aparecer en el filtro y los
                productos que la tenían no cambian.
              </p>
              <div className="form-row">
                <button
                  className="btn-primary"
                  onClick={async () => {
                    await alternarActivo(porEliminar);
                    setPorEliminar(null);
                  }}
                >
                  Desactivar en su lugar
                </button>
                <button className="btn-secondary" onClick={() => setPorEliminar(null)}>
                  Volver
                </button>
              </div>
            </>
          ) : (
            <>
              <p>
                <strong>{porEliminar.nombre}</strong> va a dejar de aparecer en el filtro del punto
                de venta y en el formulario de productos.
              </p>
              <p>
                El borrado es <strong>suave</strong>: la ficha queda en la base, así que no se pierde
                nada. Si todavía tiene productos activos, el sistema lo va a rechazar.
              </p>
              <div className="form-row">
                <button
                  className="btn-danger"
                  data-testid="confirmar-eliminar-categoria"
                  onClick={eliminar}
                  disabled={eliminando}
                >
                  {eliminando ? "Eliminando…" : "Sí, eliminar"}
                </button>
                <button className="btn-secondary" onClick={() => setPorEliminar(null)}>
                  Volver
                </button>
              </div>
            </>
          )}
        </Modal>
      ) : null}
    </div>
  );
};

export default Categorias;
