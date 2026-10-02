import { IpcError } from '../../bridge/errors.js'
import { assertCents, formatCents, toCents, toRate } from '../../../shared/money.js'
import { assertMilli, toMilli } from '../../../shared/qty.js'
import { requireTenant } from '../seed.js'
import { esViolacionUnicaEn } from '../errores-sqlite.js'

/**
 * The catalogue: products and the category a product belongs to.
 *
 * WHY THIS FILE EXISTS NOW. `ventas.repo.js` was shipped and tested without it, and a point of
 * sale that cannot list its own catalogue is a point of sale that cannot sell: `crear` in
 * `ventas.repo.js` reads `productos` by id to price a line, and there was no operation anywhere
 * in the app that could put a product there in the first place. The POS screen is therefore only
 * reachable once these reads exist, and they are inside the FROZEN contract already —
 * `productos: [list, get, findByCode, create, update, remove]` and
 * `categorias: [list, get, create, update, remove]`. Nothing was added to `OPS` (still 89).
 *
 * WHAT IS IMPLEMENTED, AND WHAT IS NOT. `list`, `get`, `findByCode` and `create` for products;
 * `list` and `create` for categories. `update`, `remove` and the rest are contract members whose
 * handler is not in this build, so the registry answers `NOT_IMPLEMENTED` (501) for them — the
 * truthful answer, and the same one every other unimplemented contract member already gives. A
 * product edit screen is a different piece of work; what a sale needs is to READ the catalogue
 * and to be able to add the one product the cashier is looking at.
 *
 * UNITS. This file speaks the RENDERER's language on the way in and the DATABASE's on the way
 * out, exactly like `ventas.repo.js` and `cajas.repo.js`:
 *
 *   in   `precio`, `precioCompra`  decimal pesos, parsed by `toCents` — `'1050,50'` -> 105050
 *       `stock`, `stockMinimo`     decimal units, parsed by `toMilli` — `'0,5'` -> 500
 *       `iva`, `margen`             percentages, parsed by `toRate` — 21 means 21%
 *   out  `precioCentavos`, `stockMilli`, ... — the stored integers, never a float
 *
 * The web sends the same shapes over HTTP, so the POS code that builds the payload is unchanged;
 * only the transport is. Two consequences for the vendored renderer, both learned from
 * `shared/money.js` rather than assumed: a value must carry NO thousands separator (`'1050,50'`
 * parses, `'1.050,50'` is refused with a 400, because `1.050` is 1050 in Argentina and 1.05 in the
 * US and this is a cash register), and a NEGATIVE amount is NOT refused by `toCents` — the
 * non-negativity checks below are what turn one into a 400 with a sentence instead of letting the
 * schema's CHECK fire as a 500. See `shared/money.js` and `shared/qty.js`.
 */

/**
 * The twelve units `001_init.sql` CHECKs, mirrored here so the refusal is a 400 with a useful
 * sentence instead of SQLite's column name. `es_pesable` is GENERATED from the first two, so the
 * list is the whole truth about what a shop may sell by weight.
 */
const UNIDADES = Object.freeze([
  'unidad', 'kg', 'g', 'l', 'ml', 'm', 'cm', 'par', 'caja', 'pack', 'docena'
])

/** snake_case row -> the camelCase shape the renderer's components read. */
export function mapProducto(row) {
  if (!row) return null
  return {
    id: row.id,
    nombre: row.nombre,
    descripcion: row.descripcion,
    codigo: row.codigo,
    precioCentavos: row.precio_centavos,
    precioCompraCentavos: row.precio_compra_centavos,
    stockMilli: row.stock_milli,
    stockMinimoMilli: row.stock_minimo_milli,
    categoriaId: row.categoria_id,
    userId: row.user_id,
    negocioId: row.negocio_id,
    activo: Boolean(row.activo),
    imagen: row.imagen,
    tieneIva: Boolean(row.tiene_iva),
    ivaPorcentaje: row.iva_porcentaje,
    margen: row.margen,
    unidadMedida: row.unidad_medida,
    // GENERATED column: read it, never write it. The badge, the scale button and the "cannot
    // fraction" guard all read THIS ONE value instead of each re-deriving the answer from the
    // unit and eventually disagreeing with the database.
    esPesable: Boolean(row.es_pesable),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapCategoria(row) {
  if (!row) return null
  return {
    id: row.id,
    nombre: row.nombre,
    descripcion: row.descripcion,
    userId: row.user_id,
    negocioId: row.negocio_id,
    activo: Boolean(row.activo),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** A name the operator typed. Trimmed; a blank is a blank, not an empty string. */
function textoOpcional(valor) {
  if (valor === null || valor === undefined) return null
  const t = String(valor).trim()
  return t === '' ? null : t
}

/**
 * Refuse a negative amount where the schema says the value cannot be negative.
 *
 * The code is per-field so the operator is told WHICH one. `PRODUCTO_PRECIO_NEGATIVO` and its
 * siblings are also what the vendored POS can branch on, instead of parsing an error sentence to
 * find out what went wrong.
 */
function assertNoNegativo(valor, campo) {
  if (valor < 0) {
    const clave = campo.toUpperCase().normalize('NFD').replace(/[^A-Z]/g, '_')
    throw new IpcError(
      `PRODUCTO_${clave}_NEGATIVO`,
      400,
      `${campo} no puede ser negativo: ${formatCents(valor)}`
    )
  }
  return valor
}

/**
 * Does this business ALREADY use this code, ignoring case?
 *
 * MEASURED, NOT ASSUMED. `ux_productos_codigo_negocio` is a plain unique index, so SQLite
 * compares TEXT with BINARY and `ABC` and `abc` are two different barcodes — while the web
 * resolved codes through MySQL's `utf8mb4_general_ci`, where they were the same one. The desktop
 * would therefore accept a product the web refused, and then `findByCode('abc')` would return
 * whichever of the two rows came first, which is not a lookup any more. So the check is here,
 * case-insensitively, before the insert.
 *
 * The index is still the guarantee: this pre-check and the insert are not one atomic step against
 * another writer, so `crear` KEEPS the index-name catch below as the backstop for the race.
 */
function codigoEnUso(db, negocioId, codigo) {
  if (!codigo) return null
  const fila = db
    .prepare('SELECT id FROM productos WHERE codigo = ? COLLATE NOCASE AND negocio_id = ?')
    .get(codigo, negocioId)
  return fila ? fila.id : null
}

/**
 * Validate a product for creation. Everything refusable is refused BEFORE the transaction opens,
 * so a bad payload costs no write lock.
 *
 * NO LENGTH BOUNDS ARE INVENTED. `001_init.sql` §7i records that the Sequelize `STRING(n)`
 * validators were deliberately not translated into CHECKs because "design §D.2 asks for it and
 * this file does not do it… NOT a hidden omission", and it is honest about that. Guessing a
 * maximum here would be inventing a bound the model never had, and a bound that refuses data a
 * shop can legitimately produce is a bound that lies by omission. What IS enforced is what the
 * SCHEMA enforces — non-negative money, non-negative stock, a unit from the CHECK list, a
 * category that belongs to this business — plus "a product has a name", which no constraint in
 * the schema can express and without which the till prints a blank line.
 */
function validarProducto(body) {
  if (!body || typeof body !== 'object') {
    throw new IpcError('PRODUCTO_CUERPO_INVALIDO', 400, 'El producto debe enviar un cuerpo de petición')
  }
  const nombre = textoOpcional(body.nombre)
  if (!nombre) {
    throw new IpcError('PRODUCTO_NOMBRE_REQUERIDO', 400, 'El producto necesita un nombre')
  }

  const unidadMedida = textoOpcional(body.unidadMedida)?.toLowerCase() ?? 'unidad'
  if (!UNIDADES.includes(unidadMedida)) {
    throw new IpcError(
      'PRODUCTO_UNIDAD_INVALIDA',
      400,
      `Unidad de medida inválida: ${unidadMedida}. Permitidas: ${UNIDADES.join(', ')}`
    )
  }

  // `toCents`/`toMilli` throw MoneyError/QtyError, which `toIpcError` already turns into a
  // structured 400 with the same `message`. They are NOT re-wrapped here: the wording those
  // modules produce ("1050,50" is not a valid amount) is the wording the operator needs, and a
  // second wrapper would only replace it with a vaguer one.
  //
  // The sign is checked HERE and not left to the schema. `toCents('-5')` returns `-500` — it
  // parses, because a ledger has legitimate negative amounts and refusing them in a shared
  // parser would break `ventas.repo.js` too. So `productos.precio_centavos >= 0` is the only
  // thing that stops a product priced at -$5, and a CHECK violation surfaces as
  // `SQLITE_CONSTRAINT_CHECK`, which `toIpcError` cannot recognise and turns into INTERNAL/500.
  // A 500 for a price a human typed is a bug report about a cash register.
  const precioCentavos = body.precio === undefined || body.precio === null || body.precio === ''
    ? 0
    : assertNoNegativo(assertCents(toCents(body.precio, 'precio'), 'precio'), 'precio')
  const precioCompraCentavos = body.precioCompra === undefined || body.precioCompra === null || body.precioCompra === ''
    ? 0
    : assertNoNegativo(assertCents(toCents(body.precioCompra, 'precio de compra'), 'precio de compra'), 'precio de compra')
  const stockMilli = body.stock === undefined || body.stock === null || body.stock === ''
    ? 0
    : assertNoNegativo(assertMilli(toMilli(body.stock, 'stock'), 'stock'), 'stock')
  const stockMinimoMilli = body.stockMinimo === undefined || body.stockMinimo === null || body.stockMinimo === ''
    ? 5000
    : assertNoNegativo(assertMilli(toMilli(body.stockMinimo, 'stock mínimo'), 'stock mínimo'), 'stock mínimo')

  return {
    nombre,
    descripcion: textoOpcional(body.descripcion),
    // A blank barcode is NULL, not ''. `ux_productos_codigo_negocio` is PARTIAL on
    // `codigo IS NOT NULL`, so an empty string would take a unique slot that no other product
    // could ever use — the second product with no barcode would fail the index.
    codigo: textoOpcional(body.codigo),
    precioCentavos,
    precioCompraCentavos,
    stockMilli,
    stockMinimoMilli,
    unidadMedida,
    imagen: textoOpcional(body.imagen),
    tieneIva: body.tieneIva ? 1 : 0,
    ivaPorcentaje: body.iva === undefined || body.iva === null || body.iva === '' ? null : toRate(body.iva, 'IVA'),
    margen: body.margen === undefined || body.margen === null || body.margen === '' ? null : toRate(body.margen, 'margen'),
    categoriaId: body.categoriaId === undefined || body.categoriaId === null || body.categoriaId === ''
      ? null
      : Number(body.categoriaId),
    activo: body.activo === false || body.activo === 0 ? 0 : 1
  }
}

/**
 * A category that belongs to THIS business, or a refusal.
 *
 * NOT left to the foreign key. `productos.categoria_id REFERENCES categorias (id)` carries no
 * `negocio_id`, so the database would happily accept another tenant's category id and the
 * product would then belong to a business that does not exist. The check is here for the same
 * reason every other repository scopes by `negocio_id`: the FK is a referential guarantee, not a
 * tenant boundary.
 */
function exigirCategoria(ctx, categoriaId) {
  if (categoriaId === null) return null
  if (!Number.isSafeInteger(categoriaId) || categoriaId < 1) {
    throw new IpcError('CATEGORIA_ID_INVALIDO', 400, `Id de categoría inválido: ${categoriaId}`)
  }
  const fila = ctx.db
    .prepare('SELECT id FROM categorias WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL')
    .get(categoriaId, ctx.negocioId)
  if (!fila) {
    throw new IpcError('CATEGORIA_NO_ENCONTRADA', 400, `Categoría con ID ${categoriaId} no encontrada`)
  }
  return fila.id
}

/**
 * Create a product. One transaction: the row and its audit trail, or neither.
 *
 * The duplicate-barcode refusal is caught by INDEX NAME, not by matching SQLite's wording,
 * because the wording is not an API and it changes between versions. `es_pesable` is absent from
 * the INSERT on purpose: it is a STORED generated column, and writing it is an error SQLite
 * refuses with a sentence no operator can act on.
 */
export function crear(ctx, body) {
  requireTenant(ctx.negocioId)
  if (!ctx.actorId) {
    throw new IpcError('ACTOR_REQUERIDO', 401, 'La operación necesita un usuario en sesión')
  }
  const p = validarProducto(body)
  const categoriaId = exigirCategoria(ctx, p.categoriaId)
  const codigoRepetido = codigoEnUso(ctx.db, ctx.negocioId, p.codigo)
  if (codigoRepetido !== null) {
    throw new IpcError('PRODUCTO_CODIGO_DUPLICADO', 400, `El código "${p.codigo}" ya existe en esta tienda`)
  }
  const ts = new Date().toISOString()

  return ctx.tx(() => {
    let info
    try {
      info = ctx.db
        .prepare(
          `INSERT INTO productos
             (nombre, descripcion, codigo, precio_centavos, precio_compra_centavos, stock_milli,
              stock_minimo_milli, categoria_id, user_id, negocio_id, activo, imagen, tiene_iva,
              iva_porcentaje, margen, unidad_medida, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          p.nombre,
          p.descripcion,
          p.codigo,
          p.precioCentavos,
          p.precioCompraCentavos,
          p.stockMilli,
          p.stockMinimoMilli,
          categoriaId,
          ctx.actorId,
          ctx.negocioId,
          p.activo,
          p.imagen,
          p.tieneIva,
          p.ivaPorcentaje,
          p.margen,
          p.unidadMedida,
          ts,
          ts
        )
    } catch (err) {
      // Matched on the COLUMNS, because SQLite names the columns a UNIQUE INDEX covers and never
      // the index itself: the message is "UNIQUE constraint failed: productos.codigo,
      // productos.negocio_id" and `ux_productos_codigo_negocio` appears nowhere in it. The old guard
      // matched the index name, so it matched nothing and a repeated barcode escaped as an
      // untranslated SQLite error. Both columns, because the index is on the PAIR.
      if (esViolacionUnicaEn(err, 'productos.codigo', 'productos.negocio_id')) {
        throw new IpcError('PRODUCTO_CODIGO_DUPLICADO', 400, `El código "${p.codigo}" ya existe en esta tienda`)
      }
      throw err
    }

    const id = Number(info.lastInsertRowid)
    ctx.db
      .prepare(
        `INSERT INTO auditoria (tabla, registro_id, accion, valores_anteriores, valores_nuevos, user_id, negocio_id, created_at, updated_at)
         VALUES ('productos', ?, 'CREATE', NULL, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        JSON.stringify({ nombre: p.nombre, codigo: p.codigo, precioCentavos: p.precioCentavos, stockMilli: p.stockMilli }),
        ctx.actorId,
        ctx.negocioId,
        ts,
        ts
      )

    return mapProducto(ctx.db.prepare('SELECT * FROM productos WHERE id = ?').get(id))
  })
}

/** One product, scoped by business: another tenant's id is a 404, not a 200. */
export function obtener(ctx, id) {
  requireTenant(ctx.negocioId)
  const productoId = Number(id)
  if (!Number.isSafeInteger(productoId) || productoId < 1) {
    throw new IpcError('PRODUCTO_ID_INVALIDO', 400, `Id de producto inválido: ${id}`)
  }
  const row = ctx.db
    .prepare('SELECT * FROM productos WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL')
    .get(productoId, ctx.negocioId)
  if (!row) {
    throw new IpcError('PRODUCTO_NO_ENCONTRADO', 404, 'Producto no encontrado')
  }
  return mapProducto(row)
}

/**
 * A product by its barcode — the one read a USB scanner makes, a hundred times an hour.
 *
 * `COLLATE NOCASE` is deliberate and it is NOT SQLite's default. `=` on TEXT is
 * case-sensitive (`ABC` ≠ `abc`), and the web resolved barcodes through MySQL's
 * `utf8mb4_general_ci` collation, where they were equal. A desktop that refused a barcode the web
 * accepted would be a barcode that works on one machine and not the other, and the operator
 * cannot tell which is wrong. `NOCASE` compares ASCII only, which is every character a barcode
 * carries.
 *
 * Returns `null` for "no such code" rather than a 404: a scanner that fires on a product the
 * shop does not stock is a normal event, and the caller decides what to do about it.
 */
export function buscarPorCodigo(ctx, codigo) {
  requireTenant(ctx.negocioId)
  const cod = textoOpcional(codigo)
  if (!cod) return null
  const row = ctx.db
    .prepare(
      `SELECT * FROM productos
        WHERE codigo = ? COLLATE NOCASE AND negocio_id = ? AND deleted_at IS NULL`
    )
    .get(cod, ctx.negocioId)
  return mapProducto(row)
}

/**
 * The catalogue, filtered. This is the POS grid's one query.
 *
 * `search` matches the name OR the barcode, case-insensitively, and `LIKE` is used with an
 * ESCAPE for `%` and `_` so a product called "100% cacao" is findable by typing "100%" instead
 * of matching every row in the shop.
 *
 * `soloActivos` defaults to true because a soft-deleted product must not be sellable, and the
 * filter lives HERE rather than in the renderer so a caller cannot forget it.
 */
export function listar(ctx, { search = '', categoriaId = null, limit = 100, offset = 0, soloActivos = true } = {}) {
  requireTenant(ctx.negocioId)
  const cond = ['negocio_id = ?', 'deleted_at IS NULL']
  const args = [ctx.negocioId]
  if (soloActivos) cond.push('activo = 1')
  if (categoriaId !== null && categoriaId !== undefined && categoriaId !== '') {
    cond.push('categoria_id = ?')
    args.push(Number(categoriaId))
  }
  const q = textoOpcional(search)
  if (q) {
    cond.push("(nombre LIKE ? ESCAPE '\\' OR (codigo IS NOT NULL AND codigo LIKE ? ESCAPE '\\'))")
    const patron = `%${escaparLike(q.toLowerCase())}%`
    args.push(patron, patron)
  }
  const where = cond.join(' AND ')

  const total = ctx.db.prepare(`SELECT COUNT(*) AS n FROM productos WHERE ${where}`).get(...args).n
  // Alphabetical, because a POS grid is read by looking, and `id` breaks the tie so the order is
  // STABLE across calls — an unstable order makes the grid jump when two products share a name.
  const filas = ctx.db
    .prepare(`SELECT * FROM productos WHERE ${where} ORDER BY nombre COLLATE NOCASE ASC, id ASC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset)
  return { filas: filas.map(mapProducto), total }
}

/** `LIKE` wildcards typed by an operator are literal characters, not patterns. */
function escaparLike(texto) {
  return texto.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** Every active category, alphabetical. The POS filter row and the product form's select. */
export function listarCategorias(ctx) {
  requireTenant(ctx.negocioId)
  return ctx.db
    .prepare(
      `SELECT * FROM categorias
        WHERE negocio_id = ? AND deleted_at IS NULL AND activo = 1
        ORDER BY nombre COLLATE NOCASE ASC, id ASC`
    )
    .all(ctx.negocioId)
    .map(mapCategoria)
}

/**
 * Create a category. The POS's "fraccionar" flow needs somewhere to put a derived product, and a
 * catalogue with no categories at all is a catalogue whose filter row is permanently "Todas".
 *
 * The duplicate-name refusal is the same index-name check as the barcode: `ux_categorias_nombre_negocio`
 * is scoped to the business, so "Bebidas" can exist in two different shops and not twice in one.
 */
export function crearCategoria(ctx, body) {
  requireTenant(ctx.negocioId)
  if (!ctx.actorId) {
    throw new IpcError('ACTOR_REQUERIDO', 401, 'La operación necesita un usuario en sesión')
  }
  const nombre = textoOpcional(body?.nombre)
  if (!nombre) {
    throw new IpcError('CATEGORIA_NOMBRE_REQUERIDO', 400, 'La categoría necesita un nombre')
  }
  const descripcion = textoOpcional(body?.descripcion)
  // Same measured reason as the barcode: `ux_categorias_nombre_negocio` compares with BINARY, so
  // "Bebidas" and "bebidas" would both exist in one shop — two filter rows an operator reads as
  // one, and a category list that sorts itself into two places. The web's `utf8mb4_general_ci`
  // refused the pair; the desktop has to say so too, or the two disagree.
  const repetida = ctx.db
    .prepare('SELECT id FROM categorias WHERE nombre = ? COLLATE NOCASE AND negocio_id = ?')
    .get(nombre, ctx.negocioId)
  if (repetida) {
    throw new IpcError('CATEGORIA_NOMBRE_DUPLICADO', 400, `La categoría "${nombre}" ya existe en esta tienda`)
  }
  const ts = new Date().toISOString()

  return ctx.tx(() => {
    let info
    try {
      info = ctx.db
        .prepare(
          `INSERT INTO categorias (nombre, descripcion, user_id, negocio_id, activo, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`
        )
        .run(nombre, descripcion, ctx.actorId, ctx.negocioId, ts, ts)
    } catch (err) {
      // The index is `ux_categorias_nombre_negocio` over `(nombre, negocio_id)`.
      //
      // THIS USED TO MATCH THE INDEX NAME, and matched nothing: SQLite names the columns a
      // UNIQUE index covers and never the index itself, so `ux_categorias_nombre_negocio` is not
      // in the message. The guard was unreachable, and the duplicate escaped as a raw SQLite
      // error. Its test still passed, because the pre-check `SELECT` above catches the duplicate
      // first — the guard is only reachable when two writers both pass the pre-check, and nothing
      // tested that.
      if (esViolacionUnicaEn(err, 'categorias.nombre', 'categorias.negocio_id')) {
        throw new IpcError('CATEGORIA_NOMBRE_DUPLICADO', 400, `La categoría "${nombre}" ya existe en esta tienda`)
      }
      throw err
    }
    const id = Number(info.lastInsertRowid)
    ctx.db
      .prepare(
        `INSERT INTO auditoria (tabla, registro_id, accion, valores_anteriores, valores_nuevos, user_id, negocio_id, created_at, updated_at)
         VALUES ('categorias', ?, 'CREATE', NULL, ?, ?, ?, ?, ?)`
      )
      .run(id, JSON.stringify({ nombre }), ctx.actorId, ctx.negocioId, ts, ts)
    return mapCategoria(ctx.db.prepare('SELECT * FROM categorias WHERE id = ?').get(id))
  })
}

// =============================================================================
// product update / remove, and the category CRUD the contract always named
// =============================================================================

/**
 * Update a product. PATCH semantics: a field the form did not send keeps its current value.
 *
 * WHY `!== undefined` AND NOT TRUTHINESS. `activo: false` and `stock: 0` are VALUES an operator
 * deliberately set, not absences. `if (body.activo)` would switch a deactivated product back on;
 * `body.stock || actual.stock` would ignore a stock of zero. So every field is tested against
 * `undefined` — the one thing a JSON payload cannot carry — and an explicit `null`/`''` means
 * "clear this", which is what an emptied text field means.
 *
 * The amount/stock fields arrive in the RENDERER's language (`precio` in pesos, `stock` in decimal
 * units, `iva`/`margen` as percentages), exactly like `crear`, so the form that creates a product
 * and the form that edits one speak the same dialect. `es_pesable` is never written: it is a
 * GENERATED column that follows `unidad_medida`.
 */
export function actualizar(ctx, id, body) {
  requireTenant(ctx.negocioId)
  if (!ctx.actorId) {
    throw new IpcError('ACTOR_REQUERIDO', 401, 'La operación necesita un usuario en sesión')
  }
  const productoId = Number(id)
  if (!Number.isSafeInteger(productoId) || productoId < 1) {
    throw new IpcError('PRODUCTO_ID_INVALIDO', 400, `Id de producto inválido: ${id}`)
  }
  const actual = ctx.db
    .prepare('SELECT * FROM productos WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL')
    .get(productoId, ctx.negocioId)
  if (!actual) {
    throw new IpcError('PRODUCTO_NO_ENCONTRADO', 404, 'Producto no encontrado')
  }

  const b = body ?? {}
  const nombre = b.nombre === undefined ? actual.nombre : textoOpcional(b.nombre)
  if (!nombre) {
    throw new IpcError('PRODUCTO_NOMBRE_REQUERIDO', 400, 'El producto necesita un nombre')
  }
  const unidadCruda = b.unidadMedida === undefined ? actual.unidad_medida : textoOpcional(b.unidadMedida)
  const unidadMedida = (unidadCruda ?? 'unidad').toLowerCase()
  if (!UNIDADES.includes(unidadMedida)) {
    throw new IpcError(
      'PRODUCTO_UNIDAD_INVALIDA',
      400,
      `Unidad de medida inválida: ${unidadMedida}. Permitidas: ${UNIDADES.join(', ')}`
    )
  }
  const precioCentavos = b.precio === undefined
    ? actual.precio_centavos
    : assertNoNegativo(assertCents(toCents(b.precio, 'precio'), 'precio'), 'precio')
  const precioCompraCentavos = b.precioCompra === undefined
    ? actual.precio_compra_centavos
    : assertNoNegativo(assertCents(toCents(b.precioCompra, 'precio de compra'), 'precio de compra'), 'precio de compra')
  const stockMilli = b.stock === undefined
    ? actual.stock_milli
    : assertNoNegativo(assertMilli(toMilli(b.stock, 'stock'), 'stock'), 'stock')
  const stockMinimoMilli = b.stockMinimo === undefined
    ? actual.stock_minimo_milli
    : assertNoNegativo(assertMilli(toMilli(b.stockMinimo, 'stock mínimo'), 'stock mínimo'), 'stock mínimo')
  const codigo = b.codigo === undefined ? actual.codigo : textoOpcional(b.codigo)
  // The category is only re-resolved when the form named one. An UNCHANGED category is kept even
  // if it was soft-deleted later: re-validating it would make editing an unrelated field fail on a
  // category the product already belongs to, which is not a rule anyone set.
  const categoria = b.categoriaId === undefined
    ? actual.categoria_id
    : exigirCategoria(ctx, b.categoriaId === null || b.categoriaId === '' ? null : Number(b.categoriaId))
  const tieneIva = b.tieneIva === undefined ? actual.tiene_iva : b.tieneIva ? 1 : 0
  const ivaCruda = b.iva !== undefined ? b.iva : b.ivaPorcentaje
  const ivaPorcentaje = ivaCruda === undefined
    ? actual.iva_porcentaje
    : ivaCruda === null || ivaCruda === ''
      ? null
      : toRate(ivaCruda, 'IVA')
  const margen = b.margen === undefined
    ? actual.margen
    : b.margen === null || b.margen === ''
      ? null
      : toRate(b.margen, 'margen')
  const activo = b.activo === undefined ? actual.activo : b.activo ? 1 : 0

  if (codigo && codigo !== actual.codigo) {
    const repetido = ctx.db
      .prepare('SELECT id FROM productos WHERE codigo = ? COLLATE NOCASE AND negocio_id = ? AND id != ?')
      .get(codigo, ctx.negocioId, productoId)
    if (repetido) {
      throw new IpcError('PRODUCTO_CODIGO_DUPLICADO', 400, `El código "${codigo}" ya existe en esta tienda`)
    }
  }
  const ts = new Date().toISOString()

  return ctx.tx(() => {
    try {
      ctx.db
        .prepare(
          `UPDATE productos
              SET nombre = ?, descripcion = ?, codigo = ?, precio_centavos = ?, precio_compra_centavos = ?,
                  stock_milli = ?, stock_minimo_milli = ?, categoria_id = ?, activo = ?, imagen = ?,
                  tiene_iva = ?, iva_porcentaje = ?, margen = ?, unidad_medida = ?, updated_at = ?
            WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL`
        )
        .run(
          nombre,
          b.descripcion === undefined ? actual.descripcion : textoOpcional(b.descripcion),
          codigo,
          precioCentavos,
          precioCompraCentavos,
          stockMilli,
          stockMinimoMilli,
          categoria,
          activo,
          b.imagen === undefined ? actual.imagen : textoOpcional(b.imagen),
          tieneIva,
          ivaPorcentaje,
          margen,
          unidadMedida,
          ts,
          productoId,
          ctx.negocioId
        )
    } catch (err) {
      if (esViolacionUnicaEn(err, 'productos.codigo', 'productos.negocio_id')) {
        throw new IpcError('PRODUCTO_CODIGO_DUPLICADO', 400, `El código "${codigo}" ya existe en esta tienda`)
      }
      throw err
    }
    ctx.db
      .prepare(
        `INSERT INTO auditoria (tabla, registro_id, accion, valores_anteriores, valores_nuevos, user_id, negocio_id, created_at, updated_at)
         VALUES ('productos', ?, 'UPDATE', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        productoId,
        JSON.stringify({ nombre: actual.nombre, codigo: actual.codigo, precioCentavos: actual.precio_centavos, stockMilli: actual.stock_milli }),
        JSON.stringify({ nombre, codigo, precioCentavos, stockMilli }),
        ctx.actorId,
        ctx.negocioId,
        ts,
        ts
      )
    return mapProducto(ctx.db.prepare('SELECT * FROM productos WHERE id = ?').get(productoId))
  })
}

/**
 * Remove a product from the catalogue WITHOUT destroying what it sold.
 *
 * TWO PATHS, AND THE DIFFERENCE IS HISTORY. A product with no sales has no history to protect, so
 * it is soft-deleted (`deleted_at` set, every read filters it out). A product that HAS sales is
 * only DEACTIVATED (`activo = 0`), never deleted. `ventas_detalles` keeps its own copy of the name
 * and the unit price, so a historical ticket still prints — but the PRODUCT row is what a later
 * report joins to for its current price and stock. Deleting it would make that join dangle: the
 * product would vanish from every catalogue read and the report would have to say "unknown product"
 * about something the shop demonstrably sold.
 *
 * THE WEB REFUSES INSTEAD. `producto.controller.js` answers 400 when a product has sales (outside
 * development, where it deactivates silently). Deactivation is the same safety with a usable UI:
 * the operator's "eliminar" removes it from the grid either way, and nothing ever sold changes.
 * This is a deliberate divergence; `DIVERGENCES.md` records it.
 */
export function eliminar(ctx, id) {
  requireTenant(ctx.negocioId)
  if (!ctx.actorId) {
    throw new IpcError('ACTOR_REQUERIDO', 401, 'La operación necesita un usuario en sesión')
  }
  const productoId = Number(id)
  if (!Number.isSafeInteger(productoId) || productoId < 1) {
    throw new IpcError('PRODUCTO_ID_INVALIDO', 400, `Id de producto inválido: ${id}`)
  }
  const actual = ctx.db
    .prepare('SELECT * FROM productos WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL')
    .get(productoId, ctx.negocioId)
  if (!actual) {
    throw new IpcError('PRODUCTO_NO_ENCONTRADO', 404, 'Producto no encontrado')
  }
  // `ventas_detalles` has NO `negocio_id`; the product id is already tenant-scoped by the read
  // above, so the count cannot reach another shop's lines.
  const ventas = ctx.db
    .prepare('SELECT COUNT(*) AS n FROM ventas_detalles WHERE producto_id = ?')
    .get(productoId).n
  const ts = new Date().toISOString()

  return ctx.tx(() => {
    if (ventas > 0) {
      ctx.db
        .prepare('UPDATE productos SET activo = 0, updated_at = ? WHERE id = ? AND negocio_id = ?')
        .run(ts, productoId, ctx.negocioId)
      ctx.db
        .prepare(
          `INSERT INTO auditoria (tabla, registro_id, accion, valores_anteriores, valores_nuevos, user_id, negocio_id, created_at, updated_at)
           VALUES ('productos', ?, 'UPDATE', ?, ?, ?, ?, ?, ?)`
        )
        .run(productoId, JSON.stringify({ activo: 1 }), JSON.stringify({ activo: 0, motivo: 'ventas_asociadas' }), ctx.actorId, ctx.negocioId, ts, ts)
      return { id: productoId, desactivado: true }
    }
    ctx.db
      .prepare('UPDATE productos SET deleted_at = ?, updated_at = ? WHERE id = ? AND negocio_id = ?')
      .run(ts, ts, productoId, ctx.negocioId)
    ctx.db
      .prepare(
        `INSERT INTO auditoria (tabla, registro_id, accion, valores_anteriores, valores_nuevos, user_id, negocio_id, created_at, updated_at)
         VALUES ('productos', ?, 'DELETE', ?, NULL, ?, ?, ?, ?)`
      )
      .run(productoId, JSON.stringify({ nombre: actual.nombre }), ctx.actorId, ctx.negocioId, ts, ts)
    return { id: productoId, desactivado: false }
  })
}

/** One category, scoped by business: another tenant's id is a 404, not a 200. */
export function obtenerCategoria(ctx, id) {
  requireTenant(ctx.negocioId)
  const categoriaId = Number(id)
  if (!Number.isSafeInteger(categoriaId) || categoriaId < 1) {
    throw new IpcError('CATEGORIA_ID_INVALIDO', 400, `Id de categoría inválido: ${id}`)
  }
  const row = ctx.db
    .prepare('SELECT * FROM categorias WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL')
    .get(categoriaId, ctx.negocioId)
  if (!row) {
    throw new IpcError('CATEGORIA_NO_ENCONTRADA', 404, 'Categoría no encontrada')
  }
  return mapCategoria(row)
}

/**
 * Update a category. Same PATCH semantics and the same case-insensitive duplicate refusal as
 * `crearCategoria`: `ux_categorias_nombre_negocio` compares with BINARY, so "Bebidas" and
 * "bebidas" would otherwise coexist in one shop and split the filter row in two.
 */
export function actualizarCategoria(ctx, id, body) {
  requireTenant(ctx.negocioId)
  if (!ctx.actorId) {
    throw new IpcError('ACTOR_REQUERIDO', 401, 'La operación necesita un usuario en sesión')
  }
  const categoriaId = Number(id)
  if (!Number.isSafeInteger(categoriaId) || categoriaId < 1) {
    throw new IpcError('CATEGORIA_ID_INVALIDO', 400, `Id de categoría inválido: ${id}`)
  }
  const actual = ctx.db
    .prepare('SELECT * FROM categorias WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL')
    .get(categoriaId, ctx.negocioId)
  if (!actual) {
    throw new IpcError('CATEGORIA_NO_ENCONTRADA', 404, 'Categoría no encontrada')
  }
  const b = body ?? {}
  const nombre = b.nombre === undefined ? actual.nombre : textoOpcional(b.nombre)
  if (!nombre) {
    throw new IpcError('CATEGORIA_NOMBRE_REQUERIDO', 400, 'La categoría necesita un nombre')
  }
  const descripcion = b.descripcion === undefined ? actual.descripcion : textoOpcional(b.descripcion)
  const activo = b.activo === undefined ? actual.activo : b.activo ? 1 : 0
  if (nombre !== actual.nombre) {
    const repetida = ctx.db
      .prepare('SELECT id FROM categorias WHERE nombre = ? COLLATE NOCASE AND negocio_id = ? AND id != ?')
      .get(nombre, ctx.negocioId, categoriaId)
    if (repetida) {
      throw new IpcError('CATEGORIA_NOMBRE_DUPLICADO', 400, `La categoría "${nombre}" ya existe en esta tienda`)
    }
  }
  const ts = new Date().toISOString()

  return ctx.tx(() => {
    try {
      ctx.db
        .prepare('UPDATE categorias SET nombre = ?, descripcion = ?, activo = ?, updated_at = ? WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL')
        .run(nombre, descripcion, activo, ts, categoriaId, ctx.negocioId)
    } catch (err) {
      if (esViolacionUnicaEn(err, 'categorias.nombre', 'categorias.negocio_id')) {
        throw new IpcError('CATEGORIA_NOMBRE_DUPLICADO', 400, `La categoría "${nombre}" ya existe en esta tienda`)
      }
      throw err
    }
    ctx.db
      .prepare(
        `INSERT INTO auditoria (tabla, registro_id, accion, valores_anteriores, valores_nuevos, user_id, negocio_id, created_at, updated_at)
         VALUES ('categorias', ?, 'UPDATE', ?, ?, ?, ?, ?, ?)`
      )
      .run(categoriaId, JSON.stringify({ nombre: actual.nombre, descripcion: actual.descripcion }), JSON.stringify({ nombre, descripcion }), ctx.actorId, ctx.negocioId, ts, ts)
    return mapCategoria(ctx.db.prepare('SELECT * FROM categorias WHERE id = ?').get(categoriaId))
  })
}

/**
 * Remove a category. REFUSED while it still groups an active product.
 *
 * A category is not a history-bearing row the way a product is — it has no sales — so the danger
 * here is different: deleting it would leave its products pointing at a category that no longer
 * resolves, and the POS filter row would show a category whose count is permanently zero. The web
 * refuses for exactly this reason in production (`categoria.controller.js` answers 400 when active
 * products reference it), and this build matches that rule rather than inventing a softer one.
 */
export function eliminarCategoria(ctx, id) {
  requireTenant(ctx.negocioId)
  if (!ctx.actorId) {
    throw new IpcError('ACTOR_REQUERIDO', 401, 'La operación necesita un usuario en sesión')
  }
  const categoriaId = Number(id)
  if (!Number.isSafeInteger(categoriaId) || categoriaId < 1) {
    throw new IpcError('CATEGORIA_ID_INVALIDO', 400, `Id de categoría inválido: ${id}`)
  }
  const actual = ctx.db
    .prepare('SELECT * FROM categorias WHERE id = ? AND negocio_id = ? AND deleted_at IS NULL')
    .get(categoriaId, ctx.negocioId)
  if (!actual) {
    throw new IpcError('CATEGORIA_NO_ENCONTRADA', 404, 'Categoría no encontrada')
  }
  const productos = ctx.db
    .prepare('SELECT COUNT(*) AS n FROM productos WHERE categoria_id = ? AND negocio_id = ? AND deleted_at IS NULL AND activo = 1')
    .get(categoriaId, ctx.negocioId).n
  if (productos > 0) {
    throw new IpcError('CATEGORIA_CON_PRODUCTOS', 400, 'No se puede eliminar la categoría porque tiene productos activos asociados')
  }
  const ts = new Date().toISOString()

  return ctx.tx(() => {
    ctx.db
      .prepare('UPDATE categorias SET deleted_at = ?, updated_at = ? WHERE id = ? AND negocio_id = ?')
      .run(ts, ts, categoriaId, ctx.negocioId)
    ctx.db
      .prepare(
        `INSERT INTO auditoria (tabla, registro_id, accion, valores_anteriores, valores_nuevos, user_id, negocio_id, created_at, updated_at)
         VALUES ('categorias', ?, 'DELETE', ?, NULL, ?, ?, ?, ?)`
      )
      .run(categoriaId, JSON.stringify({ nombre: actual.nombre }), ctx.actorId, ctx.negocioId, ts, ts)
    return { id: categoriaId }
  })
}
