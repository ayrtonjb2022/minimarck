import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { productosAPI } from "../api/productos";
import { categoriasAPI } from "../api/categorias";
import { mensajeDeError } from "../api/ipc";
import { toast } from "react-toastify";
import {
  formatCentavos,
  formatCantidad,
  centavosAEntrada,
  milliAEntrada,
} from "../utils/formatters";
import Modal from "../components/common/Modal";

/**
 * Productos — the catalogue itself: what the shop sells, at what price, with how much on the shelf.
 *
 * ── WHY THIS SCREEN EXISTED AS A HOLE ─────────────────────────────────────────────────────────
 *
 * The five `productos.*` operations and the five `categorias.*` ones have handlers in main, and the
 * route tree still listed `/productos` and `/categorias` under "todavia no". That gap had a
 * concrete cost: the only way to change a price, fix a barcode or put stock back on a shelf was the
 * CLI, and a shopkeeper cannot be asked to run `node scripts/...` to reprice an item. The backend
 * was complete and unreachable, which is the same defect `ControlesDeTurno` records for the
 * handover control.
 *
 * ── WHAT IT SAVES, AND WHY THAT DIRECTION MATTERS ─────────────────────────────────────────────
 *
 * PRICES GO OUT IN PESOS and stock in DECIMAL UNITS, because that is the renderer's vocabulary;
 * `productos.repo.js` parses both to integer centavos and thousandths on the way in. The form is
 * therefore built by CONVERTING THE STORED INTEGERS BACK (`centavosAEntrada`, `milliAEntrada`), not
 * by dividing by 100 at the call site: `formatCents` output would put `$` and a thousands separator
 * into an `<input>`, and `toCents` refuses both on the way back — `'1.050,50'` is 1050 in Argentina
 * and 1.05 in the US, so it refuses rather than guesses.
 *
 * ── WHY THE LIST SHOWS INACTIVE PRODUCTS ──────────────────────────────────────────────────────
 *
 * `productos.remove` is not one thing. A product with sales in its history is DEACTIVATED rather
 * than deleted, so that no past ticket loses the item it points at. A list that only asked for
 * active rows would make that product invisible AND unreachable: it would disappear from the only
 * screen that can bring it back. So the default here is `soloActivos: false` with an explicit
 * filter, and the status column says which state each row is in.
 *
 * ── WHY STOCK IS READ-ONLY IS NOT A THING HERE ────────────────────────────────────────────────
 *
 * Stock is editable on purpose. The screen has no "ajuste de stock" operation to call, and the
 * honest reading of the schema is that `stock_milli` is a column a shop corrects after a physical
 * count — the alternative is an operator who counts the shelf, finds 3 instead of 5, and has no way
 * to say so.
 */

const PAGE_SIZE = 20;

/**
 * The twelve units `001_init.sql` CHECKs, and the same list `productos.repo.js` refuses against.
 * Kept as data with a label, because the operator picks "Kilogramo", not "kg".
 */
const UNIDADES = [
  { value: "unidad", label: "Unidad" },
  { value: "kg", label: "Kilogramo (kg)" },
  { value: "g", label: "Gramo (g)" },
  { value: "l", label: "Litro (l)" },
  { value: "ml", label: "Mililitro (ml)" },
  { value: "m", label: "Metro (m)" },
  { value: "cm", label: "Centímetro (cm)" },
  { value: "par", label: "Par" },
  { value: "caja", label: "Caja" },
  { value: "pack", label: "Pack" },
  { value: "docena", label: "Docena" },
];

const ETIQUETA_UNIDAD = Object.fromEntries(UNIDADES.map((u) => [u.value, u.label]));

/**
 * The blank form. Every numeric field is a STRING because that is what an `<input>` holds and what
 * the repository parses; a number here would be a float the moment the operator typed a comma.
 */
const VACIO = {
  nombre: "",
  descripcion: "",
  codigo: "",
  categoriaId: "",
  unidadMedida: "unidad",
  precio: "",
  precioCompra: "",
  stock: "",
  stockMinimo: "",
  tieneIva: false,
  iva: "",
  margen: "",
  imagen: "",
  activo: true,
};

/** The stored product, back in the renderer's vocabulary, ready to edit. */
const aFormulario = (p) => ({
  id: p.id,
  nombre: p.nombre ?? "",
  descripcion: p.descripcion ?? "",
  codigo: p.codigo ?? "",
  categoriaId: p.categoriaId == null ? "" : String(p.categoriaId),
  unidadMedida: p.unidadMedida ?? "unidad",
  precio: centavosAEntrada(p.precioCentavos ?? 0),
  precioCompra: centavosAEntrada(p.precioCompraCentavos ?? 0),
  stock: milliAEntrada(p.stockMilli ?? 0),
  stockMinimo: milliAEntrada(p.stockMinimoMilli ?? 0),
  tieneIva: Boolean(p.tieneIva),
  iva: p.ivaPorcentaje == null ? "" : String(p.ivaPorcentaje),
  margen: p.margen == null ? "" : String(p.margen),
  imagen: p.imagen ?? "",
  activo: p.activo !== false,
});

/**
 * The margin the shop gets at the listed price, as a percentage, or `null`.
 *
 * IT IS DERIVED, NEVER SENT. `margen` is a stored column the repository keeps, and this number only
 * exists to be SHOWN next to the two prices the operator actually typed — a shopkeeper judging
 * "is 40% enough" should not have to divide in their head at the counter. The arithmetic is integer
 * all the way: `(precio - costo) * 100 / precio`, floored, with the multiplication before the
 * division so no centavo is lost to rounding on the way.
 */
const margenCalculado = (precioTexto, costoTexto) => {
  const precio = Number(String(precioTexto).replace(",", "."));
  const costo = Number(String(costoTexto).replace(",", "."));
  if (!Number.isFinite(precio) || !Number.isFinite(costo) || precio <= 0) return null;
  const precioCentavos = Math.round(precio * 100);
  const costoCentavos = Math.round(costo * 100);
  return Math.floor(((precioCentavos - costoCentavos) * 100) / precioCentavos);
};

const Productos = () => {
  // React Query, to reach ACROSS screens. The POS caches the product list under
  // `["productos","all-for-pos"]` with a five-minute life, and this page never wrote to that cache:
  // a product created here showed up in the catalogue and stayed missing at the till until the
  // cache expired. The writes below invalidate the `productos` family instead.
  const queryClient = useQueryClient();
  const [filas, setFilas] = useState([]);
  const [total, setTotal] = useState(0);
  const [pagina, setPagina] = useState(0);
  const [search, setSearch] = useState("");
  const [categoriaFiltro, setCategoriaFiltro] = useState("");
  const [soloActivos, setSoloActivos] = useState(false);
  const [categorias, setCategorias] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [guardando, setGuardando] = useState(false);
  const [porEliminar, setPorEliminar] = useState(null);
  const [eliminando, setEliminando] = useState(false);

  /**
   * Categories are read ONCE and used for three things: the filter row, the form's `<select>` and
   * the category column's label. A second call per render would be a second answer to the same
   * question, and the two would disagree the moment one of them was a request behind.
   */
  const cargarCategorias = useCallback(async () => {
    try {
      const lista = await categoriasAPI.listar();
      setCategorias(lista ?? []);
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudieron cargar las categorías"));
    }
  }, []);

  const cargar = useCallback(
    async ({ suprimeCargando = false } = {}) => {
      if (!suprimeCargando) setLoading(true);
      try {
        const res = await productosAPI.listar({
          search,
          categoriaId: categoriaFiltro === "" ? null : categoriaFiltro,
          soloActivos,
          limit: PAGE_SIZE,
          offset: pagina * PAGE_SIZE,
        });
        setFilas(res.filas ?? []);
        setTotal(res.total ?? 0);
      } catch (err) {
        toast.error(mensajeDeError(err, "No se pudieron cargar los productos"));
      } finally {
        setLoading(false);
      }
    },
    [search, categoriaFiltro, soloActivos, pagina]
  );

  useEffect(() => {
    cargarCategorias();
  }, [cargarCategorias]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  // The page resets when a filter changes, and NOT when the page itself changes — otherwise
  // "Siguiente" would immediately bounce back to page 1. Same rule as Proveedores: a search for a
  // name that only exists on page 3 would otherwise land on an empty page 1 and read as "no results".
  useEffect(() => {
    setPagina(0);
  }, [search, categoriaFiltro, soloActivos]);

  const etiquetaCategoria = useMemo(() => {
    const mapa = Object.fromEntries(categorias.map((c) => [String(c.id), c.nombre]));
    return (id) => (id == null ? "—" : mapa[String(id)] ?? "—");
  }, [categorias]);

  const abrirNuevo = () => {
    // A product needs a category, and a shop with none cannot create one from here without losing
    // what it typed. Saying so up front is better than a form that fails on submit.
    setForm({ ...VACIO, categoriaId: categorias[0] ? String(categorias[0].id) : "" });
  };

  // A write the POS has to see. `["productos"]` matches by PREFIX, so it also catches the POS's
  // `["productos","all-for-pos"]` — one call covers create, edit, toggle and delete.
  const avisarAlPos = () => queryClient.invalidateQueries({ queryKey: ["productos"] });

  const guardar = async (evento) => {
    evento.preventDefault();
    setGuardando(true);
    try {
      // Every field the form renders is sent, so the PATCH's "absent means leave it" applies to
      // nothing this screen edits, and clearing a box clears the column. Prices and stock travel as
      // the strings the operator typed; the repository is the only place that turns them into
      // integers, and it is the only place that can refuse one.
      const cuerpo = {
        nombre: form.nombre,
        descripcion: form.descripcion,
        codigo: form.codigo,
        categoriaId: form.categoriaId === "" ? null : form.categoriaId,
        unidadMedida: form.unidadMedida,
        precio: form.precio,
        precioCompra: form.precioCompra,
        stock: form.stock,
        stockMinimo: form.stockMinimo,
        tieneIva: form.tieneIva,
        iva: form.iva,
        margen: form.margen,
        imagen: form.imagen,
        activo: form.activo,
      };

      if (form.id) {
        await productosAPI.actualizar(form.id, cuerpo);
        toast.success(`"${form.nombre}" actualizado`);
      } else {
        await productosAPI.crear(cuerpo);
        toast.success(`"${form.nombre}" creado`);
      }
      await avisarAlPos();
      setForm(null);
      await cargar({ suprimeCargando: true });
    } catch (err) {
      // The repository's own sentence, which names the field: `PRODUCTO_CODIGO_DUPLICADO` says which
      // barcode collided, and `PRODUCTO_UNIDAD_INVALIDA` lists what is allowed. Replacing that with
      // a generic message would throw away the only part the operator can act on.
      toast.error(mensajeDeError(err, "No se pudo guardar el producto"), { autoClose: 9000 });
    } finally {
      setGuardando(false);
    }
  };

  const alternarActivo = async (p) => {
    try {
      await productosAPI.actualizar(p.id, { activo: !p.activo });
      toast.success(p.activo ? `"${p.nombre}" desactivado` : `"${p.nombre}" activado`);
      await avisarAlPos();
      await cargar({ suprimeCargando: true });
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudo cambiar el estado"));
    }
  };

  const eliminar = async () => {
    if (!porEliminar) return;
    setEliminando(true);
    try {
      // The answer says WHICH thing happened. A product with sales is deactivated instead of
      // deleted, and telling the operator "eliminado" for that case would be a lie they discover
      // later, when the item is still there under the inactive filter.
      const res = await productosAPI.eliminar(porEliminar.id);
      toast.success(
        res?.desactivado
          ? `"${porEliminar.nombre}" tiene ventas: quedó desactivado en vez de eliminado`
          : `"${porEliminar.nombre}" eliminado`
      );
      await avisarAlPos();
      setPorEliminar(null);
      await cargar({ suprimeCargando: true });
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudo eliminar el producto"), { autoClose: 9000 });
      setPorEliminar(null);
    } finally {
      setEliminando(false);
    }
  };

  const paginas = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const margen = form ? margenCalculado(form.precio, form.precioCompra) : null;

  return (
    <div>
      <div className="bar">
        <h2>Productos</h2>
        <div className="bar">
          <input
            className="filter-input"
            type="search"
            placeholder="Buscar por nombre o código"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Buscar producto"
          />
          <select
            className="filter-input"
            value={categoriaFiltro}
            onChange={(e) => setCategoriaFiltro(e.target.value)}
            aria-label="Filtrar por categoría"
          >
            <option value="">Todas las categorías</option>
            {categorias.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.nombre}
              </option>
            ))}
          </select>
          <label
            style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}
            title="Un producto con ventas no se borra: queda inactivo y deja de venderse"
          >
            <input
              type="checkbox"
              checked={soloActivos}
              onChange={(e) => setSoloActivos(e.target.checked)}
            />
            Sólo activos
          </label>
          <button className="btn-primary" onClick={abrirNuevo} data-testid="nuevo-producto">
            <i className="fa-solid fa-plus" aria-hidden="true"></i> Nuevo producto
          </button>
        </div>
      </div>

      {loading ? (
        <p>Cargando productos…</p>
      ) : filas.length === 0 ? (
        <div className="card">
          <p>
            {search || categoriaFiltro
              ? "Ningún producto coincide con el filtro."
              : "Todavía no hay productos. Creá el primero para poder venderlo en el punto de venta."}
          </p>
        </div>
      ) : (
        <div className="table-container">
          <table className="product-list">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Código</th>
                <th>Categoría</th>
                <th>Unidad</th>
                <th style={{ textAlign: "right" }}>Precio</th>
                <th style={{ textAlign: "right" }}>Costo</th>
                <th style={{ textAlign: "right" }}>Stock</th>
                <th style={{ textAlign: "right" }}>Mínimo</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filas.map((p) => {
                // `stockMinimoMilli` is compared against `stockMilli` in the SAME unit, which is the
                // whole reason both are thousandths. Below the minimum is the one number on this
                // screen worth colouring: it is what tells the operator to buy more.
                const bajo = p.stockMilli <= p.stockMinimoMilli;
                return (
                  <tr key={p.id} style={p.activo ? undefined : { opacity: 0.6 }}>
                    <td>
                      {p.nombre}
                      {p.descripcion ? (
                        <div style={{ fontSize: 12, color: "var(--kanagawa-fg-muted)" }}>
                          {p.descripcion}
                        </div>
                      ) : null}
                    </td>
                    <td>{p.codigo ?? "—"}</td>
                    <td>{etiquetaCategoria(p.categoriaId)}</td>
                    <td>
                      {ETIQUETA_UNIDAD[p.unidadMedida] ?? p.unidadMedida}
                      {p.esPesable ? (
                        <i
                          className="fa-solid fa-scale-balanced"
                          style={{ marginLeft: 6, color: "var(--kanagawa-blue)" }}
                          title="Se puede vender por peso"
                          aria-hidden="true"
                        ></i>
                      ) : null}
                    </td>
                    <td style={{ textAlign: "right" }}>{formatCentavos(p.precioCentavos)}</td>
                    <td style={{ textAlign: "right" }}>{formatCentavos(p.precioCompraCentavos)}</td>
                    <td
                      style={{
                        textAlign: "right",
                        color: bajo ? "var(--kanagawa-red)" : undefined,
                        fontWeight: bajo ? 600 : undefined,
                      }}
                      title={bajo ? "En el mínimo o por debajo" : undefined}
                    >
                      {/* `baseDecimals` is what makes a kilo read as `1,5 kg` instead of `1 500 g`.
                          Without it a weight is printed in its sub-unit, which is the form a
                          RECEIPT wants and the wrong one for a shelf count: the operator is looking
                          at the product's own unit. */}
                      {formatCantidad(p.stockMilli, { unidad: p.unidadMedida, baseDecimals: true })}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {formatCantidad(p.stockMinimoMilli, {
                        unidad: p.unidadMedida,
                        baseDecimals: true,
                      })}
                    </td>
                    <td>
                      <span className={`status ${p.activo ? "active-s" : "inactive-s"}`}>
                        {p.activo ? "Activo" : "Inactivo"}
                      </span>
                    </td>
                    <td>
                      <button className="btn-secondary" onClick={() => setForm(aFormulario(p))}>
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
                );
              })}
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
            Página {pagina + 1} de {paginas} · {total} productos
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
          title={form.id ? `Editar ${form.nombre}` : "Nuevo producto"}
          size="lg"
        >
          <form onSubmit={guardar}>
            <div className="form-group">
              <label htmlFor="prod-nombre">Nombre *</label>
              <input
                id="prod-nombre"
                className="input-field"
                value={form.nombre}
                onChange={(e) => setForm({ ...form, nombre: e.target.value })}
                required
                autoFocus
              />
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="prod-codigo">Código de barras</label>
                <input
                  id="prod-codigo"
                  className="input-field"
                  value={form.codigo}
                  onChange={(e) => setForm({ ...form, codigo: e.target.value })}
                  placeholder="Sin código"
                />
              </div>
              <div className="form-group">
                <label htmlFor="prod-categoria">Categoría</label>
                <select
                  id="prod-categoria"
                  className="input-field"
                  value={form.categoriaId}
                  onChange={(e) => setForm({ ...form, categoriaId: e.target.value })}
                >
                  <option value="">Sin categoría</option>
                  {categorias.map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {c.nombre}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="prod-precio">Precio de venta *</label>
                {/* NOT `type="number"`: a number input with `step="0.01"` accepts exponential
                    notation and values the decimal parser refuses, and the operator would get a
                    format error without knowing why. `toCents` is the thing that says what a valid
                    amount is, so the field is text and it is the parser that answers. */}
                <input
                  id="prod-precio"
                  className="input-field"
                  inputMode="decimal"
                  value={form.precio}
                  onChange={(e) => setForm({ ...form, precio: e.target.value })}
                  placeholder="0.00"
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="prod-costo">Precio de costo</label>
                <input
                  id="prod-costo"
                  className="input-field"
                  inputMode="decimal"
                  value={form.precioCompra}
                  onChange={(e) => setForm({ ...form, precioCompra: e.target.value })}
                  placeholder="0.00"
                />
              </div>
              <div className="form-group">
                <label htmlFor="prod-margen">Margen</label>
                <input
                  id="prod-margen"
                  className="input-field"
                  inputMode="decimal"
                  value={form.margen}
                  onChange={(e) => setForm({ ...form, margen: e.target.value })}
                  placeholder="Sin definir"
                />
                {margen !== null ? (
                  <small style={{ color: "var(--kanagawa-fg-muted)" }}>
                    Con estos precios el margen es {margen}%
                  </small>
                ) : null}
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="prod-unidad">Unidad de medida</label>
                <select
                  id="prod-unidad"
                  className="input-field"
                  value={form.unidadMedida}
                  onChange={(e) => setForm({ ...form, unidadMedida: e.target.value })}
                >
                  {UNIDADES.map((u) => (
                    <option key={u.value} value={u.value}>
                      {u.label}
                    </option>
                  ))}
                </select>
                {form.unidadMedida === "kg" || form.unidadMedida === "g" ? (
                  <small style={{ color: "var(--kanagawa-fg-muted)" }}>
                    Se va a poder vender por peso desde el punto de venta.
                  </small>
                ) : null}
              </div>
              <div className="form-group">
                <label htmlFor="prod-stock">Stock</label>
                <input
                  id="prod-stock"
                  className="input-field"
                  inputMode="decimal"
                  value={form.stock}
                  onChange={(e) => setForm({ ...form, stock: e.target.value })}
                  placeholder="0"
                />
              </div>
              <div className="form-group">
                <label htmlFor="prod-minimo">Stock mínimo</label>
                <input
                  id="prod-minimo"
                  className="input-field"
                  inputMode="decimal"
                  value={form.stockMinimo}
                  onChange={(e) => setForm({ ...form, stockMinimo: e.target.value })}
                  placeholder="5"
                />
                <small style={{ color: "var(--kanagawa-fg-muted)" }}>
                  Avisa cuando el stock baja de acá.
                </small>
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label
                  htmlFor="prod-iva"
                  style={{ display: "flex", alignItems: "center", gap: 8, textTransform: "none" }}
                >
                  <input
                    id="prod-iva-activo"
                    type="checkbox"
                    checked={form.tieneIva}
                    onChange={(e) => setForm({ ...form, tieneIva: e.target.checked })}
                  />
                  Cobra IVA
                </label>
                <input
                  id="prod-iva"
                  className="input-field"
                  inputMode="decimal"
                  value={form.iva}
                  onChange={(e) => setForm({ ...form, iva: e.target.value })}
                  placeholder="21"
                  disabled={!form.tieneIva}
                  aria-label="Porcentaje de IVA"
                />
              </div>
              <div className="form-group">
                <label htmlFor="prod-imagen">Imagen (ruta o URL local)</label>
                <input
                  id="prod-imagen"
                  className="input-field"
                  value={form.imagen}
                  onChange={(e) => setForm({ ...form, imagen: e.target.value })}
                  placeholder="Sin imagen"
                />
                {/* The app makes ZERO network calls (`verify:offline` fails the build on any external
                    origin), so this field is a path inside the machine or nothing. Saying that here
                    is cheaper than an operator pasting a URL and waiting for a picture that will
                    never arrive on a till with no connectivity. */}
                <small style={{ color: "var(--kanagawa-fg-muted)" }}>
                  La app no sale a internet: usá un archivo local.
                </small>
              </div>
              <div className="form-group">
                <label htmlFor="prod-activo" style={{ textTransform: "none" }}>
                  Estado
                </label>
                <label
                  htmlFor="prod-activo"
                  style={{ display: "flex", alignItems: "center", gap: 8, textTransform: "none" }}
                >
                  <input
                    id="prod-activo"
                    type="checkbox"
                    checked={form.activo}
                    onChange={(e) => setForm({ ...form, activo: e.target.checked })}
                  />
                  Se puede vender
                </label>
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="prod-descripcion">Descripción</label>
              <textarea
                id="prod-descripcion"
                className="input-field"
                rows={2}
                value={form.descripcion}
                onChange={(e) => setForm({ ...form, descripcion: e.target.value })}
              />
            </div>

            <div className="form-row">
              <button
                type="submit"
                className="btn-primary"
                disabled={guardando}
                data-testid="guardar-producto"
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
          <p>
            <strong>{porEliminar.nombre}</strong> va a dejar de aparecer en el punto de venta.
          </p>
          {/* The two outcomes are stated BEFORE the click, because the operator cannot tell them
              apart from the outside: the button says "Eliminar" and half the time the row stays. */}
          <p>
            Si el producto <strong>nunca se vendió</strong>, se borra de la lista. Si{" "}
            <strong>tiene ventas</strong>, queda <strong>desactivado</strong> en lugar de borrarse,
            para que las ventas viejas sigan mostrando qué se vendió. En los dos casos deja de
            venderse.
          </p>
          <div className="form-row">
            <button
              className="btn-danger"
              data-testid="confirmar-eliminar-producto"
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

export default Productos;
