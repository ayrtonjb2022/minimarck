-- =============================================================================
-- 001_init.sql — MiniMarck desktop, initial schema
-- =============================================================================
--
-- Ported from the 20 Sequelize models in `backend/src/models/`. NOT a mechanical
-- translation: four classes of change are deliberate and each one is a decision
-- that a reviewer has to be able to check.
--
-- ---------------------------------------------------------------------------
-- 1. MONEY IS INTEGER CENTAVOS (`*_centavos`), never REAL and never TEXT
-- ---------------------------------------------------------------------------
-- MySQL's `DECIMAL(10,2)` is exact base-10. SQLite has no decimal type at all:
-- `NUMERIC` affinity stores integers as INTEGER and everything else as REAL, so it
-- is `REAL` with a friendlier name. Storing money as TEXT would keep the digits but
-- break `SUM()`, because aggregating a cast falls back to float again — exact
-- storage, inexact arithmetic, the worst of both. Integer centavos is the only
-- representation exact in BOTH storage and arithmetic.
--
-- 32 columns change. `_centavos` is in the NAME on purpose: the unit is part of the
-- value, and a column called `total` that means 22061 instead of 220.61 is exactly
-- the bug this rename exists to make impossible to write by accident.
--
-- ---------------------------------------------------------------------------
-- 2. RATES ARE REAL, BOUNDED BY CHECK (`*_porcentaje`, `margen`, `tasa_interes`)
-- ---------------------------------------------------------------------------
-- Rates are not money: 21.00 means 21%, not $21.00. Integer centavos would leave
-- `2100` in a column someone will eventually read as twenty-one pesos. They stay
-- REAL because there is no integer answer to "21% of 1050,50" — see
-- `shared/money.js` `applyRate`, which is the only sanctioned bridge.
--
-- The CHECK is the real addition. An unbounded REAL column will happily store
-- `2100` in `iva_porcentaje`, and nothing about that number says "wrong".
--
-- ---------------------------------------------------------------------------
-- 3. ENUM BECOMES TEXT + CHECK
-- ---------------------------------------------------------------------------
-- Sequelize ENUMs are MySQL-native. A loose TEXT column would accept
-- `metodo_pago = 'tarjetaa'`, so the allowed set moves into the schema, where it is
-- one place to read and cannot be widened by a forgotten application validation.
--
-- ---------------------------------------------------------------------------
-- 4. `deuda_total` AND `deuda_pendiente` ARE DERIVED, NOT STORED
-- ---------------------------------------------------------------------------
-- They are the only denormalized balances in the original model, and the original
-- maintained them by hand: `venta.controller.js:288-305` adds to both on a credit
-- sale and `deudor.controller.js:321-338` subtracts from one on a payment. Every
-- write path that forgot a step left the balance lying with no error anywhere.
--
-- `v_clientes_deudores` computes them instead, so there is nothing to keep in sync.
-- Formula verified against both controllers, not assumed:
--   deuda_total      = SUM(ventas.total)       WHERE metodo_pago = 'credito'
--   deuda_pendiente  = deuda_total - SUM(pagos_deuda.monto)
--
-- `estado <> 'cancelada'` is a no-op today — nothing in the backend cancels a
-- `venta` (only `compras` are cancellable) — but a cancelled credit sale must not
-- leave a debt behind, and a view is the only place that can guarantee it.
--
-- ---------------------------------------------------------------------------
-- 5. FOUR FOREIGN KEYS THAT ONLY EXISTED IN `relations.js`
-- ---------------------------------------------------------------------------
-- `ventas.caja_id`, `ventas.deudor_id`, `movimientos_caja.venta_id` and
-- `pagos_deuda.venta_id` carry no `references` in the model; their constraint came
-- only from a `belongsTo` association. They are declared here, because a foreign key
-- nobody wrote down is a foreign key that never fires. `foreign_keys=ON` is set per
-- connection in `db/connection.js` and is OFF by default in SQLite, so these are
-- real only because that module turns it on.
--
-- ---------------------------------------------------------------------------
-- 6. `detalles_asientos.debe` / `.haber` ARE NOT NULL
-- ---------------------------------------------------------------------------
-- The model declares neither, and SQLite infers nullable. That is a live
-- double-entry defect: `SUM()` ignores NULL, so a row with `debe IS NULL` does not
-- break the trial balance, it VANISHES from it. A balance that quietly omits entries
-- is worse than one that errors.
--
-- ---------------------------------------------------------------------------
-- WHAT DID NOT COME ACROSS, ON PURPOSE
-- ---------------------------------------------------------------------------
-- * Sequelize model-level validators (`notEmpty`, `len`, `isEmail`, `min`) are not
--   expressible in SQLite DDL. They move to the validation layer in `main/db/`. The
--   two worth enforcing here as CHECKs are `monto >= 1` (the model's `min: 0.01`,
--   i.e. a real movement is never zero centavos) and `cantidad >= 1`.
-- * `updated_at` is NOT auto-updated by trigger. Every UPDATE must set it. 20
--   near-identical triggers would bury the schema in noise, and a trigger is the
--   wrong place to hide an invariant a reviewer needs to see. A later migration can
--   add them once an UPDATE path is actually missed.
-- * `auditoria.direccion_ip` is kept (45 chars = IPv6 max) for schema fidelity even
--   though an offline single-machine app has no client to record.
-- * `users.password` does NOT exist. See the note on that table.
--
-- ---------------------------------------------------------------------------
-- 7. WHAT IS ADDED, AND WHAT BOUNDS ARE REFUSED
-- ---------------------------------------------------------------------------
-- Everything above is a change of *representation*. This section is the other kind: columns
-- the Sequelize schema has no source for, and constraints removed because the model has no
-- validator behind them. Both directions are decisions a reviewer has to be able to check.
--
-- 7a. FRACTIONAL QUANTITIES — `cantidad` becomes `cantidad_milli` (×1000)
--
-- `backend/src/models/venta.detalle.js:12` declares `cantidad: { type: INTEGER, validate:
-- { min: 1 } }`, while `producto.js:112` allows `unidadMedida` of `kg, g, l, ml`. A 0.5 kg
-- line CANNOT be stored in the web app, and 1.5 is silently truncated to 1. The web POS does
-- not merely fail to model this — `PuntoVenta.jsx:615-616` states it outright: *"stock es
-- INT, así que cantidad queda en 1 (una unidad) y solo se corrige el costo, no el
-- decremento"*. A half-kilo sale stores `cantidad = 1` and decrements stock by a whole
-- unit. That is a live data-integrity bug, and this schema fixes the mechanism rather than
-- reproducing it.
--
-- `stock` and `stock_minimo` are scaled for the SAME reason and this is not optional: the
-- insufficient-stock guard compares them, so leaving stock in whole units while a line is in
-- thousandths would compare 10 against 500 and refuse every single weight sale. `stock_milli`
-- default `0`, `stock_minimo_milli` default `5000` — the model's `defaultValue: 5` in
-- thousandths, so the number is unchanged and the unit is not.
--
-- 7b. `productos.es_pesable` — GENERATED, therefore unwritable
--
-- `CASE WHEN unidad_medida IN ('kg','l') THEN 1 ELSE 0 END` STORED. This is the web POS's
-- own scale rule restricted to the ENUM's real members, so the "weighable" badge, the ±
-- button and the "cannot fraction" guard all read ONE column instead of each re-deriving
-- the answer. A derived product fact the application can set is a derived fact that rots.
--
-- 7c. `movimientos_caja.origen` — real column, tied to `venta_id` by a table CHECK
--
-- A generated column could only distinguish `'venta'` from everything else, which would have
-- mislabelled every purchase payment and every till opening as "manual". So `origen` is a
-- real 5-value column, and `CHECK ((origen = 'venta') = (venta_id IS NOT NULL))` makes it
-- impossible to record a sale movement without the sale, or a manual movement while pointing
-- at one.
--
-- 7d. `ventas.monto_recibido_centavos` / `monto_cambio_centavos`
--
-- Cash taken and change returned. Nullable on purpose: NULL is "no cash was involved" (a
-- credit or transfer sale), which is a different statement from zero, and a till report that
-- cannot tell those apart is a till report that miscounts.
--
-- 7e. `ux_cuentas_contables_codigo_negocio` — unique PER BUSINESS
--
-- The model declares `codigo: { unique: true }`, a GLOBAL unique. Two shops in one file
-- cannot both own account "1.1", so the global constraint is wrong the moment `negocio_id`
-- exists at all. Scoped per business instead: the strictly more permissive choice, and the
-- one that keeps a per-tenant chart of accounts expressible.
--
-- 7f. `ux_cajas_abierta` — at most ONE open register per business
--
-- The web serialises this with `SELECT ... FOR UPDATE`, a row lock MySQL has and SQLite does
-- not. A partial UNIQUE index plus `BEGIN IMMEDIATE` is the equivalent: the second
-- concurrent `cajas.open` loses on the index rather than opening a second drawer.
--
-- 7g. `users.rol` CHECK, and `json_valid` on the four JSON columns
--
-- `rol` is a free `STRING(20)` in the model, so `'Admin'` created a user with no permissions
-- and no error. The three members below are the complete set the app uses. The four
-- Sequelize `JSON` columns become TEXT with `json_valid`, which makes the encoding an
-- enforced contract instead of a convention.
--
-- 7h. CONSTRAINTS REMOVED, because the model has no validator behind them
--
-- Inventing a bound is not free: a bound the model does not have refuses data a shop can
-- legitimately produce. Removed here, each verified against the model file:
--
--   `movimientos_caja.saldo_anterior_centavos` / `saldo_nuevo_centavos` — `MovimientoCaja.js`
--     declares NO minimum on either. A till that has spent more cash than it held is a real
--     state; `>= 0` would leave that register permanently unable to close. This one was a
--     genuine defect, not a theoretical one.
--   `asientos_contables.monto_total_centavos` — `asientoContable.js` has no minimum.
--   `detalles_asientos.debe_centavos` / `haber_centavos` — `detalleAsiento.js` has no minimum.
--     NOT NULL is kept and is the real fix (header §6); the bound was invented.
--   `cuentas_corrientes_deudas.{monto_original,saldo_pendiente,monto_cuota}_centavos` and
--     `cuotas_pagadas` — `cuentaCorrienteDeuda.js` declares no minimum on any of them.
--   `pagos_deuda_contabilidad.monto_centavos` — `pagoDeudaContabilidad.js` has no minimum.
--
-- Kept, because the model DOES have the validator: `>= 1` on `pagos_deuda.monto_centavos`
-- and `movimientos_caja.monto_centavos` (both `min: 0.01`), and `>= 0` on the venta, compra
-- and caja money columns (`min: 0`).
--
-- 7i. NOT DONE, and stated rather than hidden
--
-- * `length(...) <= n` on every `STRING(n)` column. Design §D.2 asks for it and this file
--   does not do it. It is a large, purely additive change with no behavioural effect, and it
--   wants its own census test rather than being added unreviewed. NOT a hidden omission.
-- * Rate columns stay `REAL`, not the `_pct` scaled integer of design §D.1. Deliberate
--   departure, argued in `shared/money.js`, and it is the one place this file knowingly
--   disagrees with the frozen design. Flagged for a decision, not settled here.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- negocios — the tenant. Everything else hangs off negocio_id.
-- -----------------------------------------------------------------------------
CREATE TABLE negocios (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre         TEXT    NOT NULL,
  ruc            TEXT,
  direccion      TEXT,
  telefono       TEXT,
  email          TEXT,
  website        TEXT,
  logo           TEXT,
  tipo_comercio  TEXT    NOT NULL DEFAULT 'otro'
    CHECK (tipo_comercio IN ('despensa','kiosco','ferreteria','tienda_ropa',
                             'casa_electricidad','electrodomesticos','libreria',
                             'veterinaria','regaleria','otro')),
  -- Sequelize JSON. SQLite has no JSON type, so TEXT — but `json_valid` makes the encoding
  -- an enforced contract rather than a convention. A half-written config blob is then a
  -- startup error instead of an exception inside a report nobody can explain.
  configuracion  TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(configuracion)),
  activo         INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at     TEXT
);

-- `ruc` is unique in the model. Partial rather than plain so a soft-deleted
-- business releases its RUC for real reuse.
CREATE UNIQUE INDEX ux_negocios_ruc
  ON negocios (ruc) WHERE ruc IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX ix_negocios_activo ON negocios (activo);

-- -----------------------------------------------------------------------------
-- users — the operator. NOT an authentication table; see the note below.
-- -----------------------------------------------------------------------------
CREATE TABLE users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre          TEXT    NOT NULL,
  email           TEXT    NOT NULL,
  -- `password` IS DELIBERATELY ABSENT.
  --
  -- The Sequelize model has `password STRING(255) NOT NULL` with no default, and
  -- decision #275 removes authentication from the desktop entirely. Those two
  -- cannot both hold: a NOT NULL password column with no default means the
  -- first-run admin cannot be created without a credential, and inventing one
  -- writes a fake secret into the user's database that later looks real.
  --
  -- So the column is dropped rather than made nullable. `db/seed.js` still detects
  -- a blocking `password` column and refuses to seed, so if this file is ever
  -- reverted the failure is loud and named instead of a raw NOT NULL error.
  --
  -- The model types `rol` as a free `STRING(20)`, so `'Admin'` or `'vENDEDOR'` would create
  -- a user with no permissions and no error anywhere. These three are the complete set in use
  -- across the app, so the list belongs in the schema. See header §7.
  rol             TEXT    NOT NULL DEFAULT 'admin'
    CHECK (rol IN ('admin','supervisor','vendedor')),
  activo          INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  telefono        TEXT,
  direccion       TEXT,
  negocio_id      INTEGER REFERENCES negocios (id) ON DELETE SET NULL ON UPDATE CASCADE,
  ultimo_acceso   TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at      TEXT
);

CREATE UNIQUE INDEX ux_users_email ON users (email) WHERE deleted_at IS NULL;
CREATE INDEX ix_users_negocio ON users (negocio_id);

-- -----------------------------------------------------------------------------
-- suscripciones — Negocio.hasOne(Suscripcion)
-- -----------------------------------------------------------------------------
CREATE TABLE suscripciones (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  plan               TEXT    NOT NULL DEFAULT 'basico' CHECK (plan IN ('basico','premium')),
  max_usuarios       INTEGER NOT NULL DEFAULT 2,
  max_productos      INTEGER NOT NULL DEFAULT 14,
  features           TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(features)),
  activa             INTEGER NOT NULL DEFAULT 1 CHECK (activa IN (0, 1)),
  fecha_inicio       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  fecha_vencimiento  TEXT,
  negocio_id         INTEGER NOT NULL
    REFERENCES negocios (id) ON DELETE CASCADE ON UPDATE CASCADE,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The model declares NO unique here while `Negocio.hasOne` promises one row. The
-- unique index is what makes `hasOne` true rather than aspirational.
CREATE UNIQUE INDEX ux_suscripciones_negocio ON suscripciones (negocio_id);

-- -----------------------------------------------------------------------------
-- categorias
-- -----------------------------------------------------------------------------
CREATE TABLE categorias (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre       TEXT    NOT NULL,
  descripcion  TEXT,
  user_id      INTEGER NOT NULL
    REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE,
  negocio_id   INTEGER NOT NULL
    REFERENCES negocios (id) ON DELETE CASCADE ON UPDATE CASCADE,
  activo       INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at   TEXT
);

-- `where: { deletedAt: null }` in the model. A plain UNIQUE would stop a category
-- name being reused after a soft delete, which is the opposite of what soft delete
-- is for.
CREATE UNIQUE INDEX ux_categorias_nombre_negocio
  ON categorias (nombre, negocio_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_categorias_negocio ON categorias (negocio_id);

-- -----------------------------------------------------------------------------
-- proveedores
-- -----------------------------------------------------------------------------
CREATE TABLE proveedores (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre       TEXT    NOT NULL,
  ruc          TEXT,
  telefono     TEXT,
  email        TEXT,
  direccion    TEXT,
  contacto     TEXT,
  notas        TEXT,
  activo       INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  negocio_id   INTEGER NOT NULL
    REFERENCES negocios (id) ON DELETE CASCADE ON UPDATE CASCADE,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at   TEXT
);

CREATE INDEX ix_proveedores_negocio ON proveedores (negocio_id);

-- -----------------------------------------------------------------------------
-- productos
-- -----------------------------------------------------------------------------
CREATE TABLE productos (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre               TEXT    NOT NULL,
  descripcion          TEXT,
  codigo               TEXT,
  precio_centavos      INTEGER NOT NULL DEFAULT 0 CHECK (precio_centavos >= 0),
  precio_compra_centavos INTEGER NOT NULL DEFAULT 0 CHECK (precio_compra_centavos >= 0),
  -- QUANTITY, not money: ×1000. See header §7.
  stock_milli          INTEGER NOT NULL DEFAULT 0    CHECK (stock_milli >= 0),
  stock_minimo_milli   INTEGER NOT NULL DEFAULT 5000 CHECK (stock_minimo_milli >= 0), -- 5 units
  categoria_id         INTEGER REFERENCES categorias (id) ON DELETE SET NULL ON UPDATE CASCADE,
  user_id              INTEGER NOT NULL
    REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE,
  negocio_id           INTEGER NOT NULL
    REFERENCES negocios (id) ON DELETE CASCADE ON UPDATE CASCADE,
  activo               INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  imagen               TEXT,
  tiene_iva            INTEGER NOT NULL DEFAULT 0 CHECK (tiene_iva IN (0, 1)),
  -- RATE, not money. See header §2.
  iva_porcentaje       REAL
    CHECK (iva_porcentaje IS NULL OR (iva_porcentaje >= 0 AND iva_porcentaje <= 100)),
  margen               REAL
    CHECK (margen IS NULL OR (margen >= 0 AND margen <= 100)),
  unidad_medida        TEXT    NOT NULL DEFAULT 'unidad'
    CHECK (unidad_medida IN ('unidad','kg','g','l','ml','m','cm','par','caja','pack','docena')),
  -- Generated, and therefore unwritable. See header §7: this is the one place a derived
  -- product fact is allowed to live, precisely because the database cannot be lied to about it.
  es_pesable           INTEGER GENERATED ALWAYS AS
    (CASE WHEN unidad_medida IN ('kg','l') THEN 1 ELSE 0 END) STORED,
  created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at           TEXT
);

-- `where: { codigo: { [Op.not]: null }, deletedAt: null }`. A plain UNIQUE would
-- let one NULL code block every other product, which is why the `IS NOT NULL`
-- guard is load-bearing and not decoration.
CREATE UNIQUE INDEX ux_productos_codigo_negocio
  ON productos (codigo, negocio_id) WHERE codigo IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ix_productos_user_activo ON productos (user_id, activo);
CREATE INDEX ix_productos_categoria ON productos (categoria_id);
CREATE INDEX ix_productos_negocio ON productos (negocio_id);
-- Serves the low-stock report: one business, ordered by on-hand quantity.
CREATE INDEX ix_productos_stock ON productos (negocio_id, stock_milli);

-- -----------------------------------------------------------------------------
-- cuentas_contables — `paranoid: false`, so NO deleted_at
-- -----------------------------------------------------------------------------
CREATE TABLE cuentas_contables (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo       TEXT    NOT NULL,
  nombre       TEXT    NOT NULL,
  tipo         TEXT    NOT NULL
    CHECK (tipo IN ('activo','pasivo','capital','ingreso','gasto')),
  descripcion  TEXT,
  parent_id    INTEGER
    REFERENCES cuentas_contables (id) ON DELETE SET NULL ON UPDATE CASCADE,
  activo       INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  negocio_id   INTEGER NOT NULL
    REFERENCES negocios (id) ON DELETE CASCADE ON UPDATE CASCADE,
  user_id      INTEGER NOT NULL
    REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- `codigo` is `unique: true` in the model — a GLOBAL unique. That is wrong the moment a
-- second business shares the file: two shops cannot both own account "1.1". Scoped to the
-- business instead, which is the strictly more permissive choice and the one that keeps a
-- per-tenant chart of accounts expressible. Deliberate divergence; see header §7.
CREATE UNIQUE INDEX ux_cuentas_contables_codigo_negocio
  ON cuentas_contables (codigo, negocio_id);
CREATE INDEX ix_cuentas_contables_negocio ON cuentas_contables (negocio_id);
CREATE INDEX ix_cuentas_contables_codigo   ON cuentas_contables (codigo);
CREATE INDEX ix_cuentas_contables_tipo     ON cuentas_contables (tipo);

-- -----------------------------------------------------------------------------
-- asientos_contables — `paranoid: false`
-- -----------------------------------------------------------------------------
CREATE TABLE asientos_contables (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha          TEXT    NOT NULL,
  descripcion    TEXT    NOT NULL,
  tipo           TEXT    NOT NULL
    CHECK (tipo IN ('ingreso','egreso','ajuste','apertura')),
  referencia     TEXT,
  -- The model declares no minimum validator on `montoTotal`, so none is invented here.
  monto_total_centavos INTEGER NOT NULL,
  negocio_id     INTEGER NOT NULL
    REFERENCES negocios (id) ON DELETE CASCADE ON UPDATE CASCADE,
  user_id        INTEGER NOT NULL
    REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX ix_asientos_contables_negocio ON asientos_contables (negocio_id);
CREATE INDEX ix_asientos_contables_fecha   ON asientos_contables (fecha);
CREATE INDEX ix_asientos_contables_tipo    ON asientos_contables (tipo);

-- -----------------------------------------------------------------------------
-- detalles_asientos — the double-entry lines. `paranoid: false`
-- -----------------------------------------------------------------------------
CREATE TABLE detalles_asientos (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  asiento_contable_id  INTEGER NOT NULL
    REFERENCES asientos_contables (id) ON DELETE CASCADE ON UPDATE CASCADE,
  cuenta_contable_id   INTEGER NOT NULL
    REFERENCES cuentas_contables (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  -- NOT NULL, and see header §6: a NULL here makes the row vanish from SUM() rather
  -- than break the trial balance. `debe` and `haber` are centavo integers like
  -- every other money column, which is what makes `SUM(debe) = SUM(haber)` exact.
  -- No `>= 0` bound: the model declares no minimum on either, and a correction entry that
  -- reverses a side is expressed in double-entry by moving the OTHER column, not by a
  -- negative. See header §7.
  debe_centavos        INTEGER NOT NULL DEFAULT 0,
  haber_centavos       INTEGER NOT NULL DEFAULT 0,
  descripcion          TEXT,
  negocio_id           INTEGER NOT NULL
    REFERENCES negocios (id) ON DELETE CASCADE ON UPDATE CASCADE,
  created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX ix_detalles_asientos_asiento ON detalles_asientos (asiento_contable_id);
CREATE INDEX ix_detalles_asientos_cuenta  ON detalles_asientos (cuenta_contable_id);

-- -----------------------------------------------------------------------------
-- clientes_deudores — note: NO deuda_total / deuda_pendiente columns. See header §4.
-- -----------------------------------------------------------------------------
CREATE TABLE clientes_deudores (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre                 TEXT    NOT NULL,
  documento              TEXT,
  telefono               TEXT,
  email                  TEXT,
  direccion              TEXT,
  limite_credito_centavos INTEGER CHECK (limite_credito_centavos IS NULL OR limite_credito_centavos >= 0),
  notas                  TEXT,
  user_id                INTEGER NOT NULL
    REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE,
  negocio_id             INTEGER NOT NULL
    REFERENCES negocios (id) ON DELETE CASCADE ON UPDATE CASCADE,
  activo                 INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  created_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at             TEXT
);

CREATE UNIQUE INDEX ux_clientes_deudores_documento
  ON clientes_deudores (documento, negocio_id)
  WHERE documento IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ix_clientes_deudores_negocio ON clientes_deudores (negocio_id);

-- -----------------------------------------------------------------------------
-- cuentas_corrientes_deudas — the shop's OWN debt. `paranoid: false`
-- -----------------------------------------------------------------------------
CREATE TABLE cuentas_corrientes_deudas (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre                 TEXT    NOT NULL,
  tipo                   TEXT    NOT NULL
    CHECK (tipo IN ('prestamo_mp','prestamo_bancario','prestamo_personal','proveedor','otro')),
  -- No `>= 0` bounds: the model declares no minimum validator on any of these four. The
  -- balance the shop owes its own creditors is data, and a database that refuses a number it
  -- does not like is a database that lies by omission. See header §7.
  monto_original_centavos  INTEGER NOT NULL,
  saldo_pendiente_centavos INTEGER NOT NULL,
  -- RATE, not money. See header §2.
  tasa_interes           REAL
    CHECK (tasa_interes IS NULL OR (tasa_interes >= 0 AND tasa_interes <= 100)),
  cuotas_totales         INTEGER,
  cuotas_pagadas         INTEGER NOT NULL DEFAULT 0,
  monto_cuota_centavos   INTEGER,
  fecha_inicio           TEXT    NOT NULL,
  fecha_vencimiento      TEXT,
  estado                 TEXT    NOT NULL DEFAULT 'activo'
    CHECK (estado IN ('activo','pagado','vencido')),
  contacto_nombre        TEXT,
  contacto_telefono      TEXT,
  proveedor_id           INTEGER
    REFERENCES proveedores (id) ON DELETE SET NULL ON UPDATE CASCADE,
  notas                  TEXT,
  negocio_id             INTEGER NOT NULL
    REFERENCES negocios (id) ON DELETE CASCADE ON UPDATE CASCADE,
  user_id                INTEGER NOT NULL
    REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE,
  created_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX ix_cuentas_corrientes_deudas_negocio ON cuentas_corrientes_deudas (negocio_id);
CREATE INDEX ix_cuentas_corrientes_deudas_estado   ON cuentas_corrientes_deudas (estado);
CREATE INDEX ix_cuentas_corrientes_deudas_tipo     ON cuentas_corrientes_deudas (tipo);

-- -----------------------------------------------------------------------------
-- pagos_deuda_contabilidad — `paranoid: false`
-- NOTE `metodo_pago` is TEXT, not an ENUM here. That is faithful: the model uses
-- `STRING(30)` for this table while the other two payment tables use ENUMs, so it
-- is deliberately left unconstrained rather than "helpfully" given a CHECK it
-- never had.
-- -----------------------------------------------------------------------------
CREATE TABLE pagos_deuda_contabilidad (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  cuenta_corriente_deuda_id  INTEGER NOT NULL
    REFERENCES cuentas_corrientes_deudas (id) ON DELETE CASCADE ON UPDATE CASCADE,
  -- No `>= 1` bound: unlike `pagos_deuda` and `movimientos_caja`, this model declares no
  -- minimum on `monto`, so none is invented. Faithful is the rule here. See header §7.
  monto_centavos             INTEGER NOT NULL,
  fecha                      TEXT    NOT NULL,
  metodo_pago                TEXT    NOT NULL,
  numero_cuota               INTEGER,
  observaciones              TEXT,
  negocio_id                 INTEGER NOT NULL
    REFERENCES negocios (id) ON DELETE CASCADE ON UPDATE CASCADE,
  user_id                    INTEGER NOT NULL
    REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE,
  created_at                 TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                 TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX ix_pagos_deuda_contabilidad_deuda ON pagos_deuda_contabilidad (cuenta_corriente_deuda_id);
CREATE INDEX ix_pagos_deuda_contabilidad_fecha ON pagos_deuda_contabilidad (fecha);

-- -----------------------------------------------------------------------------
-- cajas — TWO foreign keys to `users`, faithfully preserved.
-- `user_id` is aliased "propietario" and `usuario_apertura` "usuarioQueAbre" in
-- the associations. They may well be the same person and may well be different;
-- the schema does not guess, and collapsing them would silently change what
-- "the owner" of a till means.
-- -----------------------------------------------------------------------------
CREATE TABLE cajas (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha_apertura         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  fecha_cierre           TEXT,
  saldo_inicial_centavos INTEGER NOT NULL DEFAULT 0 CHECK (saldo_inicial_centavos >= 0),
  saldo_final_centavos   INTEGER CHECK (saldo_final_centavos IS NULL OR saldo_final_centavos >= 0),
  total_ingresos_centavos INTEGER NOT NULL DEFAULT 0 CHECK (total_ingresos_centavos >= 0),
  total_egresos_centavos INTEGER NOT NULL DEFAULT 0 CHECK (total_egresos_centavos >= 0),
  estado                 TEXT    NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta','cerrada')),
  observaciones          TEXT,
  user_id                INTEGER NOT NULL
    REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  usuario_apertura       INTEGER NOT NULL
    REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  usuario_cierre         INTEGER
    REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  negocio_id             INTEGER NOT NULL
    REFERENCES negocios (id) ON DELETE CASCADE ON UPDATE CASCADE,
  created_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at             TEXT
);

-- At most ONE open register per business, enforced by the database.
--
-- The web serialises this in application code with `SELECT ... FOR UPDATE`, a row lock MySQL
-- has and SQLite does not. A partial UNIQUE index plus `BEGIN IMMEDIATE` is the SQLite
-- equivalent: the second concurrent `cajas.open` loses on the index instead of opening a
-- second drawer. This is an invariant that must hold, so it belongs where it cannot be
-- forgotten rather than in every caller. See header §7.
CREATE UNIQUE INDEX ux_cajas_abierta
  ON cajas (negocio_id) WHERE estado = 'abierta' AND deleted_at IS NULL;

CREATE INDEX ix_cajas_user  ON cajas (user_id);
CREATE INDEX ix_cajas_estado ON cajas (estado);
CREATE INDEX ix_cajas_fecha ON cajas (fecha_apertura);
CREATE INDEX ix_cajas_negocio ON cajas (negocio_id);

-- -----------------------------------------------------------------------------
-- ventas
-- -----------------------------------------------------------------------------
CREATE TABLE ventas (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  -- STRING(40), widened deliberately: the model's own comment records that
  -- `V-${crypto.randomUUID()}` is 38 chars and 20 overflowed in strict mode.
  folio            TEXT    NOT NULL,
  fecha            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  subtotal_centavos INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_centavos >= 0),
  iva_centavos     INTEGER NOT NULL DEFAULT 0 CHECK (iva_centavos >= 0),
  descuento_centavos INTEGER NOT NULL DEFAULT 0 CHECK (descuento_centavos >= 0),
  total_centavos   INTEGER NOT NULL DEFAULT 0 CHECK (total_centavos >= 0),
  metodo_pago      TEXT    NOT NULL DEFAULT 'efectivo'
    CHECK (metodo_pago IN ('efectivo','tarjeta','transferencia','credito','mixto')),
  estado           TEXT    NOT NULL DEFAULT 'completada'
    CHECK (estado IN ('completada','cancelada','pendiente')),
  cliente_nombre   TEXT,
  cliente_documento TEXT,
  observaciones    TEXT,
  user_id          INTEGER NOT NULL
    REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  negocio_id       INTEGER NOT NULL
    REFERENCES negocios (id) ON DELETE CASCADE ON UPDATE CASCADE,
  -- No `references` in the model; constraint came only from relations.js. See §5.
  caja_id          INTEGER
    REFERENCES cajas (id) ON DELETE SET NULL ON UPDATE CASCADE,
  deudor_id        INTEGER
    REFERENCES clientes_deudores (id) ON DELETE SET NULL ON UPDATE CASCADE,
  -- Cash actually taken and change handed back. NULL for a credit or transfer sale, which is
  -- what distinguishes "no cash involved" from "cash of zero". See header §7.
  monto_recibido_centavos INTEGER CHECK (monto_recibido_centavos IS NULL OR monto_recibido_centavos >= 0),
  monto_cambio_centavos    INTEGER CHECK (monto_cambio_centavos    IS NULL OR monto_cambio_centavos    >= 0),
  idempotency_key  TEXT,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at       TEXT
);

CREATE INDEX ix_ventas_fecha    ON ventas (fecha);
CREATE INDEX ix_ventas_user     ON ventas (user_id);
CREATE INDEX ix_ventas_caja     ON ventas (caja_id);
CREATE INDEX ix_ventas_deudor   ON ventas (deudor_id);
CREATE INDEX ix_ventas_negocio  ON ventas (negocio_id);

CREATE UNIQUE INDEX ux_ventas_folio_negocio
  ON ventas (folio, negocio_id) WHERE deleted_at IS NULL;

-- Deliberately NOT partial: SQLite treats NULLs as distinct in a unique index, so
-- unlimited rows with a NULL `idempotency_key` are allowed while a repeated
-- non-NULL key is refused. That is exactly the intent of an idempotency key.
CREATE UNIQUE INDEX ux_ventas_idempotencia
  ON ventas (negocio_id, idempotency_key);

-- -----------------------------------------------------------------------------
-- ventas_detalles
-- -----------------------------------------------------------------------------
CREATE TABLE ventas_detalles (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  -- QUANTITY ×1000, not money. See header §7 — the web cannot store 0.5 kg at all.
  cantidad_milli          INTEGER NOT NULL CHECK (cantidad_milli >= 1),
  precio_unitario_centavos INTEGER NOT NULL CHECK (precio_unitario_centavos >= 0),
  costo_unitario_centavos  INTEGER NOT NULL DEFAULT 0 CHECK (costo_unitario_centavos >= 0),
  nombre_producto         TEXT,
  descuento_centavos      INTEGER NOT NULL DEFAULT 0 CHECK (descuento_centavos >= 0),
  subtotal_centavos       INTEGER NOT NULL CHECK (subtotal_centavos >= 0),
  venta_id                INTEGER NOT NULL
    REFERENCES ventas (id) ON DELETE CASCADE ON UPDATE CASCADE,
  producto_id             INTEGER
    REFERENCES productos (id) ON DELETE SET NULL ON UPDATE CASCADE,
  created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX ix_ventas_detalles_venta    ON ventas_detalles (venta_id);
CREATE INDEX ix_ventas_detalles_producto ON ventas_detalles (producto_id);

-- -----------------------------------------------------------------------------
-- compras
-- -----------------------------------------------------------------------------
CREATE TABLE compras (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  folio             TEXT    NOT NULL,
  fecha             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  subtotal_centavos INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_centavos >= 0),
  iva_centavos      INTEGER NOT NULL DEFAULT 0 CHECK (iva_centavos >= 0),
  descuento_centavos INTEGER NOT NULL DEFAULT 0 CHECK (descuento_centavos >= 0),
  total_centavos    INTEGER NOT NULL DEFAULT 0 CHECK (total_centavos >= 0),
  estado            TEXT    NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente','completada','cancelada')),
  observaciones     TEXT,
  proveedor_id      INTEGER
    REFERENCES proveedores (id) ON DELETE SET NULL ON UPDATE CASCADE,
  user_id           INTEGER NOT NULL
    REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  negocio_id        INTEGER NOT NULL
    REFERENCES negocios (id) ON DELETE CASCADE ON UPDATE CASCADE,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at        TEXT
);

CREATE INDEX ix_compras_fecha     ON compras (fecha);
CREATE INDEX ix_compras_proveedor ON compras (proveedor_id);
CREATE INDEX ix_compras_user      ON compras (user_id);
CREATE INDEX ix_compras_negocio   ON compras (negocio_id);

-- -----------------------------------------------------------------------------
-- compras_detalles
-- -----------------------------------------------------------------------------
CREATE TABLE compras_detalles (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  -- QUANTITY ×1000, same as `ventas_detalles.cantidad_milli`. See header §7.
  cantidad_milli           INTEGER NOT NULL CHECK (cantidad_milli >= 1),
  precio_unitario_centavos INTEGER NOT NULL CHECK (precio_unitario_centavos >= 0),
  subtotal_centavos        INTEGER NOT NULL CHECK (subtotal_centavos >= 0),
  compra_id                INTEGER NOT NULL
    REFERENCES compras (id) ON DELETE CASCADE ON UPDATE CASCADE,
  producto_id              INTEGER NOT NULL
    REFERENCES productos (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX ix_compras_detalles_compra  ON compras_detalles (compra_id);
CREATE INDEX ix_compras_detalles_producto ON compras_detalles (producto_id);

-- -----------------------------------------------------------------------------
-- movimientos_caja — `paranoid: false`, so NO deleted_at
-- -----------------------------------------------------------------------------
CREATE TABLE movimientos_caja (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo              TEXT    NOT NULL CHECK (tipo IN ('ingreso','egreso')),
  concepto          TEXT    NOT NULL,
  -- The model's `min: 0.01` is 1 centavo. Enforced here because it is a money
  -- invariant, not a convenience: a zero-valued "movement" is a no-op row that
  -- still appears in the till history and still has to be balanced.
  monto_centavos    INTEGER NOT NULL CHECK (monto_centavos >= 1),
  -- Deliberately NOT `>= 0`. The model declares no minimum on either, and a till that has
  -- spent more cash than it held is a real state a shop can reach. Refusing to record it
  -- would leave the register permanently unable to close. See header §7.
  saldo_anterior_centavos INTEGER NOT NULL,
  saldo_nuevo_centavos    INTEGER NOT NULL,
  -- What caused the movement. A generated column could only say "sale" vs "manual", which
  -- would have mislabelled a purchase payment, so this is a real column — tied to `venta_id`
  -- by the table CHECK below so the two can never disagree. See header §7.
  origen            TEXT    NOT NULL
    CHECK (origen IN ('venta','compra','caja_apertura','caja_cierre','manual')),
  referencia        TEXT,
  caja_id           INTEGER NOT NULL
    REFERENCES cajas (id) ON DELETE CASCADE ON UPDATE CASCADE,
  user_id           INTEGER NOT NULL
    REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  negocio_id        INTEGER NOT NULL
    REFERENCES negocios (id) ON DELETE CASCADE ON UPDATE CASCADE,
  venta_id          INTEGER
    REFERENCES ventas (id) ON DELETE SET NULL ON UPDATE CASCADE,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- A movement is from a sale exactly when it carries a sale. One boolean identity, so
  -- `origen = 'venta'` with no `venta_id` — and the orphan that the FK cannot see — are both
  -- refused. This is the second of the two derived facts the database owns; see header §7.
  CHECK ((origen = 'venta') = (venta_id IS NOT NULL))
);

CREATE INDEX ix_movimientos_caja_caja    ON movimientos_caja (caja_id);
CREATE INDEX ix_movimientos_caja_user    ON movimientos_caja (user_id);
CREATE INDEX ix_movimientos_caja_tipo    ON movimientos_caja (tipo);
CREATE INDEX ix_movimientos_caja_negocio ON movimientos_caja (negocio_id);
CREATE INDEX ix_movimientos_caja_created ON movimientos_caja (created_at);

-- -----------------------------------------------------------------------------
-- pagos_deuda — `paranoid: false`
-- -----------------------------------------------------------------------------
CREATE TABLE pagos_deuda (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  monto_centavos    INTEGER NOT NULL CHECK (monto_centavos >= 1),
  fecha             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Note: no 'credito' here. `pagos_deuda` genuinely lacks it, unlike `ventas`.
  metodo_pago       TEXT    NOT NULL DEFAULT 'efectivo'
    CHECK (metodo_pago IN ('efectivo','tarjeta','transferencia','mixto')),
  referencia        TEXT,
  observaciones     TEXT,
  deudor_id         INTEGER NOT NULL
    REFERENCES clientes_deudores (id) ON DELETE CASCADE ON UPDATE CASCADE,
  user_id           INTEGER NOT NULL
    REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  negocio_id        INTEGER NOT NULL
    REFERENCES negocios (id) ON DELETE CASCADE ON UPDATE CASCADE,
  venta_id          INTEGER
    REFERENCES ventas (id) ON DELETE SET NULL ON UPDATE CASCADE,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX ix_pagos_deuda_deudor  ON pagos_deuda (deudor_id);
CREATE INDEX ix_pagos_deuda_user    ON pagos_deuda (user_id);
CREATE INDEX ix_pagos_deuda_negocio ON pagos_deuda (negocio_id);
CREATE INDEX ix_pagos_deuda_fecha   ON pagos_deuda (fecha);

-- -----------------------------------------------------------------------------
-- auditoria — `paranoid: false`. No FKs on user_id/negocio_id: the model declares
-- none, and an audit trail that a CASCADE can erase is not an audit trail. A user
-- or negocio that no longer exists leaves an entry pointing at a missing id, which
-- is the correct thing for an audit log to do.
-- -----------------------------------------------------------------------------
CREATE TABLE auditoria (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  tabla               TEXT    NOT NULL,
  registro_id         INTEGER,
  accion              TEXT    NOT NULL CHECK (accion IN ('CREATE','UPDATE','DELETE')),
  -- Sequelize JSON, same treatment as `negocios.configuracion`: TEXT plus `json_valid`, so a
  -- malformed audit payload is refused on the way in rather than discovered by whatever
  -- replays the trail months later.
  valores_anteriores  TEXT CHECK (valores_anteriores IS NULL OR json_valid(valores_anteriores)),
  valores_nuevos      TEXT CHECK (valores_nuevos      IS NULL OR json_valid(valores_nuevos)),
  user_id             INTEGER,
  negocio_id          INTEGER,
  direccion_ip        TEXT,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX ix_auditoria_tabla     ON auditoria (tabla);
CREATE INDEX ix_auditoria_registro  ON auditoria (registro_id);
CREATE INDEX ix_auditoria_user      ON auditoria (user_id);
CREATE INDEX ix_auditoria_negocio   ON auditoria (negocio_id);
CREATE INDEX ix_auditoria_created   ON auditoria (created_at);

-- =============================================================================
-- v_clientes_deudores — the derived balances. See header §4.
--
-- Read-only by construction: there is no trigger behind it, so nothing can write a
-- balance that disagrees with the rows it is computed from. The trade is a SUM per
-- read, which is free at this scale on a single-writer local database and is the
-- only way the number cannot rot.
-- =============================================================================
CREATE VIEW v_clientes_deudores AS
SELECT
  d.id,
  d.negocio_id,
  d.nombre,
  d.activo,
  d.deleted_at,
  d.limite_credito_centavos,
  COALESCE(creditos.deuda_total_centavos, 0) AS deuda_total_centavos,
  -- Clamped at zero, and the clamp is load-bearing.
  --
  -- Payments can outlive the sale that created the debt: cancel the only credit sale of a
  -- debtor who has already paid, and the raw subtraction goes NEGATIVE. Measured on this
  -- schema: a 100,00 credit sale plus a 25,00 payment, then cancelling the sale, yields
  -- `deuda_total = 0` and an unclamped `deuda_pendiente = -2500`.
  --
  -- A negative debt is not a state a debtor can be in, and the backend already refuses
  -- overpayment (`deudor.controller.js:282`), so a negative here is always an
  -- inconsistency rather than a real number. `MAX(..., 0)` reports the least misleading
  -- value instead of a negative balance on an invoice. `deuda_total_centavos` is left
  -- UNclamped on purpose: it is the audit figure, and hiding it would hide the anomaly.
  MAX(COALESCE(creditos.deuda_total_centavos, 0) - COALESCE(pagos.pagado_centavos, 0), 0)
    AS deuda_pendiente_centavos
FROM clientes_deudores AS d
LEFT JOIN (
  SELECT deudor_id, SUM(total_centavos) AS deuda_total_centavos
  FROM ventas
  WHERE metodo_pago = 'credito'
    AND estado <> 'cancelada'
    AND deleted_at IS NULL
  GROUP BY deudor_id
) AS creditos ON creditos.deudor_id = d.id
LEFT JOIN (
  SELECT deudor_id, SUM(monto_centavos) AS pagado_centavos
  FROM pagos_deuda
  GROUP BY deudor_id
) AS pagos ON pagos.deudor_id = d.id;
