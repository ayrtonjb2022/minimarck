# Informe de proyecto — MiniMarck Desktop

**Qué es:** aplicación de escritorio *offline* para punto de venta (POS) de un almacén minorista.
Electron 44.4.5 + `node:sqlite` + React 18, empaquetada como instalador NSIS para Windows.

**Revisado:** los 107 archivos de `src/`, los 40 de `tests/`, los 33 de `scripts/` y la
documentación del repositorio. Todas las afirmaciones de este informe están ancladas a archivo y
línea, y las verifiqué leyendo el código.

**Fecha del análisis:** sobre el árbol de trabajo en el commit `e7bd363`
(*"test(desktop): drive the panel and the ten reports by hand"*).

---

## 1. Resumen ejecutivo

El proyecto está **mucho más avanzado de lo que su propia documentación dice**, y la calidad de su
ingeniería es **muy superior a la media**. No es un prototipo: es una aplicación con 62 de 89
operaciones implementadas, 20 tablas con restricciones reales, autenticación con `scrypt`,
contabilidad de doble partida y una suite de 665 pruebas que corre contra SQLite de verdad.

Sus tres fortalezas son poco comunes:

1. **El dinero es aritmética entera de punta a punta**, con pruebas que lo prohíben por censo y no
   por foto. Nunca encontré un `float` en una columna de dinero.
2. **La falsabilidad está institucionalizada**: hay scripts que *exigen* que la suite se ponga roja,
   controles negativos de los verificadores, y comentarios que documentan verificadores que antes
   *no podían fallar* y cómo se arreglaron.
3. **Los comentarios son un registro de ingeniería**: casi cada decisión lleva la causa raíz medida,
   el bug que la motivó y el archivo:línea del original.

Sus tres riesgos reales, en orden:

1. **El harness de pruebas se empaqueta en el instalador** (206 KB, 3.363 líneas y una contraseña
   literal) y una variable de entorno puede **borrar la base de datos real**.
2. **La documentación se autodescribe mal**: el README dice "27 de 89 implementadas" cuando son 62,
   y afirma que el renderer es una página de prueba cuando hay 9 pantallas React montadas.
3. **Defectos visibles para el usuario**: un botón de imprimir que no hace nada, 16 iconos en
   blanco, y fallos de lectura que la interfaz muestra como "no hay datos" ofreciendo después una
   acción destructiva.

**Veredicto:** base sólida, sin deuda estructural grave. Lo que falta es cerrar los P0 de
experiencia, sacar el harness de producción y sincronizar la documentación.

---

## 2. Inventario del proyecto

### 2.1 Tamaño (medido, no estimado)

| Área | Archivos | Líneas | Observación |
|---|---|---|---|
| `src/main/` | 54 | **13.757** | incluye **3.363 líneas de harness de QA** |
| `src/renderer/` | 48 | 9.089 | `puntoDeVenta.jsx` solo = 1.426 |
| `src/shared/` | 4 | 710 | la mejor pieza del repositorio |
| `src/preload/` | 1 | 38 | ejemplar |
| `tests/` | 40 | 11.526 | **37 specs, 665 `it()`** |
| `scripts/` | 33 | 4.099 | 30 `.mjs` + 2 `.ps1` |
| **Total código** | **107** | **23.594** | |

Artefactos: `out/renderer/assets/*.js` = 952 KB (bundle único, sin división de código).
`release/` = **3,25 GB** en disco (9 directorios `build-*` acumulados).

### 2.2 Mapa de directorios

```
desktop/
├─ Electron main (13.757 líneas)
│  ├─ index.js (612) ................ entry + probe de arranque + despacho de 5 drives
│  ├─ ipc/*.js (12 archivos) ........ auth cajas categorias compras contexto db deudores
│  │                                  negocio productos proveedores reportes ventas
│  ├─ bridge/{registry,errors}.js ... allowlist de 89 operaciones + IpcError
│  ├─ db/
│  │  ├─ connection.js (286) ........ authorizer deny-by-default, TxRunner, checkpoint WAL
│  │  ├─ migrate.js (227) ........... runner versionado con checksum SHA-256
│  │  ├─ migrations/001_init.sql .... 868 líneas · 20 tablas · 1 vista · ~50 índices
│  │  ├─ migrations/002_identidades.sql
│  │  ├─ repositories/*.js (9) ...... 3.900 líneas ← LA LÓGICA DE NEGOCIO
│  │  ├─ reportes/{fechas,metricas}.js
│  │  └─ {bootstrap,seed,ctx,paths,identity,reset,errores-sqlite}.js
│  ├─ auth/*.js ..................... passwords(scrypt) session identities.repo auth.service
│  ├─ security.js protocol.js window.js lifecycle.js dataDir.js
│  └─ ⚠ {payment,deudores,compras,reportes,handover}-drive.js + drive-primitives.js
├─ Preload (38 líneas) .............. bridge congelado de exactamente 4 miembros
├─ Renderer (React 18 + Router + react-query + Tailwind)
│  ├─ app/pages/*.jsx (9) ........... POS(1.426) Reportes(729) Deudores(674) Compras(615)
│  │                                  Ventas(436) Proveedores(353) Panel(237) Acceso/Usuarios(131)
│  ├─ app/api/*.js (11) ............. única frontera con window.minimarck (ipc.js)
│  ├─ app/components/common/*.jsx ... 14 componentes, 7 de ellos MUERTOS
│  ├─ app/context/*.jsx (4) ......... Auth, Caja, Theme, Notificacion (muerto)
│  ├─ app/styles/index.css (1.487) + icons.css (247)
│  └─ probe.js (337) ................ instrumentación del gate de seguridad
├─ tests/ (37 specs) ................ db(18) ui(4) shared(2) reportes(2) auth security ipc packaging
├─ scripts/ (30) .................... 11 críticos, 5 drives, 3 de mutación, ~8 desechables
└─ docs: README(496) DIVERGENCES(530) VENDORED(122) + electron-builder.yml(152)
```

### 2.3 Arquitectura y flujo de una llamada

```
renderer (.jsx)  →  api/*.js  →  window.minimarck.call(group, op, payload)
                                        ↓ (preload: 4 miembros congelados)
                     ipcMain.handle → assertTrustedSender → registry.resolve
                                        ↓
                     ipc/<grupo>.js  →  db/repositories/*.js  →  SQLite (node:sqlite)
                                        ↑
                              ctx = { negocioId, actorId }  ← se arma en main, NUNCA desde el payload
```

**El diseño de la frontera es correcto y está probado.** Los problemas están *dentro* de las capas,
no *entre* ellas.

---

## 3. Estado funcional real

### 3.1 Contrato de 89 operaciones: 62 implementadas, 27 pendientes

El README afirma lo contrario ("27 implementadas, 62 answer 501"). Conté el registro real,
handler por handler:

| Grupo | Implementadas | Total | Faltan |
|---|---|---|---|
| `reportes` | 10 | 10 | — |
| `cajas` + `cajaMovimientos` | 10 | 10 | — |
| `auth` | 5 | 5 | — |
| `compras` | 5 | 5 | — |
| `proveedores` | 5 | 5 | — |
| `ventas` | 4 | 4 | — |
| `deudores` | 4 | 7 | `get`, `update`, `remove` |
| `productos` | 4 | 6 | `update`, `remove` |
| `categorias` | 2 | 5 | `get`, `update`, `remove` |
| `negocio` | 1 | 2 | `actualizar` |
| `db` | 2 | 3 | `reconcile` |
| `dashboard` | 1 | 1 | — |
| `contabilidad` | 0 | **15** | todas |
| `backup` | 0 | **5** | todas |
| `platform` | 0 | **4** | todas |
| `notificaciones` / `importer` | 0 | 2 | todas |
| **Total** | **62** | **89** | **27** |

**Detalle importante:** 4 de las operaciones sin handler (`platform.export.xlsx`, `platform.print`,
`platform.shell.showItemInFolder`) **se publican al renderer desde el preload**
(`src/preload/index.js:31-33`) como si funcionaran. Son una promesa falsa del bridge, no una
operación honestamente pendiente.

### 3.2 Qué puede hacer un usuario hoy

- Abrir y cerrar la caja, con arqueo y desglose por método de pago.
- Vender: catálogo, búsqueda, fraccionados por peso, venta libre, F2 para cobrar, cambio calculado.
- Anular una venta en dos pasos, con motivo.
- Fiar a un cliente y cobrar la deuda (efectivo, tarjeta o transferencia).
- Comprar a proveedores, con costo promedio ponderado y anulación.
- Ver el panel y **10 reportes**.
- Gestionar usuarios y relevar el turno con contraseña.

### 3.3 Qué no puede hacer

- **Imprimir** (el botón existe y no hace nada — ver 4.1).
- Editar o borrar productos y categorías desde la interfaz (las operaciones no están).
- Tocar contabilidad (15 operaciones ausentes), respaldos (5) o exportar.
- Recibir notificaciones (el subsistema está muerto por diseño).

---

## 4. Defectos, por severidad

### 4.1 🔴 P0 — Visibles para el usuario final

**D1 · "Imprimir Boleta" no hace absolutamente nada**

`src/renderer/app/components/common/BoletaPago.jsx:39-47` usa `window.open("", "_blank")`, pero
`src/main/security.js:101` hace `setWindowOpenHandler(() => ({ action: 'deny' }))`. Entonces
`ventana` es `null` y la función **retorna en la línea 44, en silencio**. El botón es visible
(`BoletaPago.jsx:98`). El camino sancionado, `platform.print`, está en el contrato
(`src/shared/ipc-contract.js:40`) pero no tiene handler, y `src/renderer/probe.js:278-286`
*afirma explícitamente* que responde 501.

→ Implementar `platform.print` o borrar el botón. Hoy el operador cree que imprimió.

**D2 · 16 iconos se renderizan como cajas en blanco**

`styles/icons.css` dibuja cada glifo como `mask-image` con un SVG inline. Comparé las clases usadas
en el JSX contra las definidas en el CSS:

| Clase usada sin glifo | Dónde aparece |
|---|---|
| `fa-hand-holding-dollar` | nav "Deudores" (`App.jsx:99`), `Deudores.jsx:216` |
| `fa-truck-field` | nav "Proveedores" (`App.jsx:102`) |
| `fa-cart-plus` | nav "Compras" (`App.jsx:105`) + 3 botones de alta |
| `fa-user-plus` | "Nuevo empleado", "Nuevo cliente" |
| `fa-magnifying-glass` | botón **Buscar** (`Deudores.jsx:139`) |
| `fa-crown`, `fa-coins`, `fa-truck-ramp-box`, `fa-file-invoice-dollar`, `fa-scale-balanced`, `fa-money-bill-trend-up` | **6 de las 10 pestañas de Reportes** (`Reportes.jsx:82-91`) |
| `fa-ban`, `fa-circle-check`, `fa-box-open`, `fa-wand-magic-sparkles`, `fa-user-clock` | cancelar venta, catálogo vacío, etc. |

Y en el sentido inverso: **27 glifos definidos en el CSS que nadie usa**.

**Causa raíz:** hay dos fuentes de verdad sin guardián. El JSX escribe el nombre de Font Awesome,
el CSS lo implementa a mano, y ningún test compara los dos.
→ **Falta un test de una línea** que extraiga las clases `fa-*` del JSX y verifique que cada una
tiene `mask-image` en `icons.css`.

**D3 · Un fallo de lectura se muestra como "no hay datos" y ofrece una acción destructiva**

- `puntoDeVenta.jsx:577-590` desestructura solo `{ data }` de `useQuery`, ignorando
  `isLoading`/`isError`. Si `productos.list` falla, la lista queda vacía y la rama
  `1191-1229` **invita a sembrar 6 productos ficticios en una tienda real**.
- `src/renderer/app/context/CajaContext.jsx:44-52`: el `finally` pone `loadingCaja=false` con
  `cajaActiva=null`, y `CajaGuard.jsx:16` interpreta eso como "no hay caja" y **ofrece abrir una
  segunda caja** sobre una ya abierta. El comentario dice que existe un estado "desconocido"; ese
  estado no existe en el código.

**D4 · El escáner de códigos de barras es invendible fuera de los primeros 500 productos**

`puntoDeVenta.jsx:579` carga el catálogo con `limit: 500`; el "escaneo" es
`manejarEnterBusqueda` (`puntoDeVenta.jsx:801-815`) filtrando **en memoria**. El método correcto
existe — `productosAPI.buscarPorCodigo` → `productos.findByCode` — y está documentado como *"the
read a USB scanner makes"* (`api/productos.js:16-21`), pero **nunca se llama**.

**D5 · Comentarios que mienten sobre el propio código**

| Ubicación | Dice | La realidad |
|---|---|---|
| `Proveedores.jsx:63-69` | *"the box is debounced rather than fired on every keystroke"* | el `setTimeout` solo retrasa `setPagina(0)`; el effect consulta por tecla |
| `Ventas.jsx:359-360` | el formateador imprime medio kilo | llama `formatCantidad(cantidadMilli)` sin unidad → el recibo dice "500 unidad" |
| `README.md:10` | "27 implementadas, 62 answer 501" | son **62 / 27** |
| `README.md:483` | *"The renderer is still the S0 probe page… The React frontend is not mounted here"* | hay 9 pantallas React montadas |
| `puntoDeVenta.jsx:1221` | *"esta build no tiene login"* | sí lo tiene (`App.jsx:220`, `Acceso`, handover) |
| `src/main/db/identity.js:12-17` | *"Decision #275 removed authentication from the desktop"* | `auth/*` implementa scrypt, sesión y relevo |
| `Reportes.jsx:2` | "THE ELEVEN SCREENS" | `TABS` tiene **10** entradas |

### 4.2 🟠 P1 — Riesgos de corrección y de datos

**D6 · Dos pantallas dan cifras distintas para el mismo gasto**

Los gastos se filtran por `created_at` (`reportes.repo.js:231` y `:1069`) mientras
ventas/compras/pagos usan la columna `fecha`. Y `registrarMovimiento` **acepta un parámetro `fecha`
y lo ignora** (`cajas.repo.js:71-73` frente al INSERT de `:88-95`, que solo escribe `ts`). El estado
de resultados sí lee `asientos.fecha` (`reportes.repo.js:577`). Resultado: `reportes.expenses` y
`reportes.incomeStatement` **se contradicen** para un gasto cargado con fecha anterior o después de
medianoche.

**D7 · El `code` de error nunca cruza el IPC**

`src/main/bridge/errors.js:1-5` documenta que solo `{code,message,status}` cruza. El propio harness
lo desmiente: `handover-drive.js:481-488` dice *"code is null over the real channel"*. El regex del
renderer (`api/ipc.js:89`) exige `/IpcError:\s*([A-Z_]+)/`, que no matchea cuando el mensaje es la
frase humana → **todo error cae a `IPC_ERROR` y el operador ve texto crudo de Electron**.
Verifiqué además que **ningún archivo del renderer ramifica por `.code`**: hoy toda la maquinaria de
códigos es decorativa.

**D8 · Guard de tenant inconsistente y una consulta sin `negocio_id`**

`requireTenant` se llama 41 veces en `ipc/*.js` y también 28 veces en los repositorios, de forma
**arbitraria**: `ventas.list` valida (`ipc/ventas.js:26`) pero `ventas.create` no
(`ipc/ventas.js:49`). Y `cajaMovimientos.listByCaja` (`ipc/cajas.js:131-138`) llega a
`movimientos()` (`cajas.repo.js:411-415`), que filtra **solo por `caja_id`**, sin `negocio_id`. Con
el seed actual (un negocio) es latente, pero es la única lectura del repositorio sin filtro de tenant.

**D9 · Índices que no sirven a las consultas que existen**

`ix_ventas_fecha` es de una sola columna (`001_init.sql:634`), pero **todos** los reportes filtran
`(negocio_id, estado='completada', deleted_at, fecha>=, fecha<)`: `reportes.repo.js:142, 220, 675,
802, 1119` y `dashboard.repo.js:59, 68, 83, 122`. Falta el compuesto.

Y `cajas.repo.js:461` usa `substr(fecha,1,10) = substr(?,1,10)` — **no-sargable**, escanea todas
las ventas del negocio: exactamente el antipatrón que `reportes.repo.js:38-41` atribuye a la web.

**D10 · `asegurarPlan()` viaja en todos los caminos calientes**

`cuentas.repo.js:127-139` ejecuta **24 INSERT + 1 SELECT** en cada venta, compra, pago de deuda,
movimiento manual de caja y apertura con fondo (`ventas.repo.js:513,721`, `compras.repo.js:311,485`,
`cajas.repo.js:147,282`, `deudores.repo.js:440`). Es idempotente, sí, pero paga 25 sentencias por
operación para siempre.

**D11 · N+1 duplicado literalmente**

`proveedores.repo.js:92-100` y `:125-133` son **el mismo bloque de 3 subconsultas** sobre `compras`
por fila, y solo existe `ix_compras_proveedor(proveedor_id)`. `compras.repo.js:249-251` hace un
SELECT de producto dentro del loop de líneas.

**D12 · El harness de QA se empaqueta en el instalador**

`electron.vite.config.js:104-140` solo elimina la probe del **renderer**. Para el main no hay
equivalente: los 5 drives se importan estáticamente en `index.js:27-31`. **Medido**:
`out/main/index.js` = 365,6 KB y contiene `HANDOVER_DRIVE`, `PAYMENT_DRIVE` y la contraseña literal
`clave-de-probeta` (`index.js:196`). `scripts/build-release.mjs` **solo verifica el renderer**.

**D13 · Una variable de entorno borra la base de datos de la tienda**

`index.js:53-57`: si `MINIMARCK_S0_PROBE` está seteada, hace
`fs.rmSync(perfil, {recursive:true, force:true})` sobre el `userData` **real** y solo después lo
redirige a un temporal. Los `MINIMARCK_*_DRIVE` abren cajas, insertan productos y registran ventas
sobre el `userData` real (`payment-drive.js:274-291`). Nada sanea esas variables en la app
empaquetada.

**D14 · El plan de recuperación de renderer se calcula y se tira**

`index.js:415-418` hace `console.error(JSON.stringify(plan))` y nada más. `reopen_window`
(`lifecycle.js:50`) y `reread_state` (`lifecycle.js:46`) **nunca se ejecutan**, contra lo que
promete el doc de `lifecycle.js:28-41`. Un renderer que se cae deja una ventana muerta y una línea
de log.

**D15 · Defectos de la capa de datos**

- **2 tablas muertas**: `cuentas_corrientes_deudas` y `pagos_deuda_contabilidad`
  (`001_init.sql:484-548`) tienen **0 lecturas/escrituras** en todo `src/` fuera del DDL — y
  `ventas.repo.js:423` las nombra como si fueran el destino real de la deuda.
- **FK rota**: `users.negocio_id ... ON DELETE SET NULL` (`001_init.sql:246`) es la única tabla que
  no es `NOT NULL ... CASCADE`; con `ux_users_email` parcial, borrar un negocio deja usuarios
  huérfanos con email reutilizable. Y `user_identidades.user_id` (`002_identidades.sql:34`) es
  `INTEGER NOT NULL` **sin `REFERENCES`**, en un esquema con `foreign_keys=ON` global.
- **`limite_credito_centavos` se guarda y nunca bloquea**: `ventas.repo.js:470` solo emite una
  advertencia.
- **`IN` sin límite**: `reportes.repo.js:152-167` arma una marca `?` por *cada* venta del período.
- **Cero tests de semántica de borrado**: `pragma_foreign_key_list` no aparece en ningún spec. Es el
  único agujero estructural de la suite.
- **`users`/`suscripciones`/`auditoria`**: columnas que nunca se leen (`negocios.website`,
  `auditoria.direccion_ip`, `suscripciones.*`, `productos.imagen`).

### 4.3 🟡 P2 — Problemas de arquitectura

**D16 · El entry point de Electron es el archivo más grande de lógica de producto… y contiene el harness**

`src/main/index.js` (612 líneas): ~210 son la probe de arranque y ~160 el despacho de **6 bloques
casi idénticos** con 6 flags `let xStarted = false` (`431-447`), su watchdog y su `.then/.catch` con
`app.exit`. Se reemplaza por una tabla `{ env, timeout, run, etiqueta }` + un `for` de 15 líneas.

**D17 · SQL de negocio dentro del handler de Electron**

`index.js:600-603` escribe `SELECT COUNT(*) FROM cajas WHERE estado='abierta'…` a mano, aunque
`cajas.repo.js` **ya tiene esa consulta** (`cajaActiva`). Es la violación más clara de la propia
arquitectura del proyecto.

**D18 · Los repositorios de reportes mezclan SQL, métricas y presentación**

`reportes.repo.js` = 1.257 líneas con umbrales de semáforo y **colores** dentro (`:793`
`{margenVerdePct:25, margenAmarilloPct:15}`, `:865-867, 888-916, 937-947`). El "top productos" está
escrito **tres veces con tres GROUP BY distintos**: `:369-383`, `:688-698` y
`dashboard.repo.js:115-126`. `resumenPeriodo` se calcula 2× por reporte (`:212` y `:268-282`).

**D19 · Nueve copias de la misma línea de cableado**

`const ctx = (reqCtx) => createCtx(conn, reqCtx ?? {})` aparece 9 veces. Con el guard de tenant en
dos capas y de forma arbitraria, el cableado se puede colapsar en un `wrap(group, table)`.

**D20 · Matemática de negocio duplicada en la interfaz**

- `Compras.jsx:141-142`: `Math.round(precio * cantidad)` en floats, mientras su propio comentario
  (`:25-27`) afirma usar la misma aritmética que el repositorio (`lineTotalCentavos`, `qty.js:167-179`).
- `CalculadoraPeso.jsx:3-22`: **quinta** copia de `escalaUnidad`, y acepta `lt`/`litro` (línea 8) —
  unidades que `qty.js:207-219` no conoce y que el CHECK del esquema no permite: exactamente la
  discrepancia que `puntoDeVenta.jsx:45-47` dice haber eliminado.
- `Deudores.jsx:311,383,449` convierte centavos con `x/100` (float) cuando `formatCents`/`toCents`
  son la norma.

**D21 · Dos paradigmas de datos en el renderer**

`QueryClientProvider` envuelve toda la app (`main.jsx:55`) y `queryClient.js:12-15` define
`mutations: { retry: 2 }` — **no hay una sola mutación en el repositorio** (configuración muerta y
peligrosa si alguien agrega una: reintentaría una venta). Las otras 8 páginas hacen fetch manual con
`useState/useEffect/useCallback` (`Deudores.jsx:67-92`, `Ventas.jsx:70-96`, `Compras.jsx:69-88`,
`Proveedores.jsx:48-69`, `Reportes.jsx:656-687`, `Panel.jsx:68-80`). Y `retry: 2` sin clasificar
reintenta 3 veces un `PRODUCTO_NO_ENCONTRADO` o un `NOT_IMPLEMENTED`.

**D22 · Efectos sin limpieza ni secuenciación**

Listados sin `AbortController` ni token de secuencia en 4 páginas → una respuesta lenta anterior
**sobrescribe** la nueva. `Modal.jsx:7-20` con dependencias `[isOpen, onClose]` y `onClose` inline
se re-registra en cada render, y su limpieza escribe `overflow = "unset"` pisando el valor previo.
`puntoDeVenta.jsx:627`: `setTimeout` de notificación sin limpiar → un aviso nuevo lo borra el timer
viejo.

**D23 · Accesibilidad en un POS que se opera con teclado**

El POS presume de `Ctrl+F`/`F2`/`Esc` (`puntoDeVenta.jsx:606-657`), pero las tarjetas de producto
son `<div onClick>` sin `tabIndex`/`role` (`puntoDeVenta.jsx:1270`): **el catálogo no se puede
recorrer con teclado**. Además: botones solo-icono sin `aria-label`, `<label>` sin `htmlFor`, tabs
ARIA sin navegación por flechas, y colores hex fijos fuera del tema (`CajaGuard.jsx:33-38`) que
dejan pantallas oscuras con tema claro.

**D24 · Cinco mapas de "método de pago" con deriva ortográfica**

`puntoDeVenta.jsx:26-33`, `Ventas.jsx:41-46` ("Credito"), `Deudores.jsx:48-54` ("Crédito"),
`Compras.jsx:52-54`, `Reportes.jsx:99`. Sin i18n ni constantes compartidas.

**D25 · Validación de entrada incompleta en la frontera**

`limit`/`offset` del renderer llegan **sin validar** a `LIMIT ?`. SQLite interpreta **`LIMIT`
negativo como ilimitado**; un `limit` no numérico termina en 500 `INTERNAL`. El contraste está en
reportes, que sí valida (`reportes.repo.js:362-364`): la regla existe en el proyecto, aplicada en un
solo grupo.

**D26 · Errores de formato 400 vs 500**

`auth/passwords.js:74-80` valida el máximo con `throw new Error()` pelado → `toIpcError` lo etiqueta
**`INTERNAL` 500** en vez de 400, mientras `auth.service.js:73-81` valida el mínimo con
`IpcError(…, 400)`.

**D27 · `scryptSync` bloquea el proceso que atiende el IPC, sin limitación de intentos**

`passwords.js:83` corre en el main con `maxmem: 256 MB`, y `ipc/auth.js:38` no tiene rate limit.
Como extra, `autenticar` **no ejecuta scrypt cuando el usuario no existe**
(`identities.repo.js:176-181`), así que el tiempo de respuesta distingue "usuario inexistente" de
"contraseña incorrecta" — pese a que el doc promete respuestas idénticas.

**D28 · Listener acumulado por cada `webContents`**

`security.js:113-122` registra `session.webRequest.onHeadersReceived(...)` dentro de
`app.on('web-contents-created')` (`index.js:354-356`): cada creación (incluido devtools) **agrega
otro listener sobre la MISMA sesión** y ninguno se remueve. Además `security.js:97` pasa
`isPackaged = true` hardcodeado, contradiciendo el resto del archivo.

**D29 · `win.loadURL` sin `.catch`**

`window.js:53-54`: sin manejo de rechazo, un fallo de carga no entra en el
`main().catch(onStartupFailure)` de `index.js:644` cuya razón de existir documentada es *"una app
invisible colgada 900 s"*. Mismo patrón en `activate` (`index.js:612-616`).

---

## 5. Código irrelevante, muerto o sobre-ingeniería

Todo verificado con búsqueda en `src/`, `tests/` y `scripts/`.

### 5.1 Muerto, con 0 importadores y 0 pruebas

**Renderer — 7 componentes, 534 líneas:**

| Archivo | Líneas | Nota |
|---|---|---|
| `components/common/Navbar.jsx` | 103 | `App.jsx` tiene su propio `TopBar`; `puntoDeVenta.jsx:1171` ya lo admite en un comentario |
| `components/common/HelpModal.jsx` | 134 | solo lo usa `Navbar` (muerto) |
| `components/common/Sidebar.jsx` | 97 | |
| `components/common/Table.jsx` | 92 | Panel y Reportes hicieron sus tablas a mano |
| `components/common/StatsCard.jsx` | 55 | |
| `components/common/ConfirmDialog.jsx` | 33 | las confirmaciones usan `Modal` |
| `components/common/ProtectedRoute.jsx` | 20 | el gate real está inline en `App.jsx:220` |

- **`app/context/NotificacionContext.jsx`** completo: su único consumidor era el `Navbar` muerto.
  Expone `count: 0` fijo (`:28`) y la campana solo podía mostrar "No hay notificaciones".
  `notificaciones.list` no tiene handler y no lo va a tener.
- **`app/index.css`** (74 líneas): nadie lo importa y **redefine** `@import "tailwindcss"` y
  `@layer components` con `.btn-*`/`.card` que ya están en `styles/index.css:439-461`.
- **`api/negocio.js`** completo + métodos muertos: `categorias.crear`, `cajas.listar`,
  `proveedores.obtener`, `compras.actualizar`, `auth.changePassword`, `productos.obtener`,
  `productos.buscarPorCodigo` (este último, además, *debería* usarse).
- **Exports muertos**: `formatters.js` → `formatCurrency`, `capitalizeWords`, `getStatusColor`,
  `getRolColor` (`:31,94,101,120`); `AuthContext.jsx:105-111` → `isAdmin`/`isSupervisor`/
  `isVendedor`/`hasRole`.
- **Main**: `ROLES_SQL` y `usuarioPorId` (`identities.repo.js:26,67`), `withActor`
  (`ctx.js:28`), `readShippedSignals` (`reset.js:65`), el re-export `{ ROLES, sesionPublica }`
  (`auth.service.js:339`), y `actorId`/`operadorNombre`/`rol` de `resolveLocalIdentity`
  (`identity.js:87-94`) que ya no lee nadie.
- **CSS muerto en `styles/index.css`**: `.page{display:none}`/`.page.active` (`:304-305`, mina real
  documentada en `Compras.jsx:241-244`), todo el bloque `.sidebar*` (`:83-247, 953-990, 1011-1034`),
  media queries duplicadas casi línea por línea, y **17 selectores** que no aparecen en ningún JSX.
- **~150 líneas de POS inalcanzables**: `/pos` está envuelto en `CajaGuard` (`App.jsx:256-263`), así
  que la rama `!cajaActiva` del POS (`1037-1062`) y su `ModalAperturaCaja` (`312-361`) nunca se
  montan. Peor: `CajaGuard.jsx:18` usa `parseFloat` sobre un `<input type="number" step="0.01">` —
  **exactamente el antipatrón** que `shared/money.js:32-37` documenta como "cómo una caja cobra $10
  en una venta de $1.000" — mientras el modal muerto del POS sí manda el string y deja parsear a
  `toCents`. **Hay que quedarse con el bueno y borrar el otro.**
- **`framer-motion`** (~53 KB en el bundle) se usa solo para animar el `Modal`
  (`Modal.jsx:2,28,30`); sus otros dos consumidores están muertos. Un `@keyframes` lo reemplaza.

### 5.2 Duplicación estructural que se puede colapsar

- **Los 5 drives: 3.363 líneas / 206 KB que deberían estar fuera de `src/main/`.**
  `drive-primitives.js:1-27` declara ser *"the one definition"* pero **solo lo importan 2 de 5
  drives**: payment/deudores/compras llevan ~450 líneas de copias que ya **divergieron** (`buscar`
  devuelve `true/false` en unos y `{ok,via}` en otros; `recargar` espera `did-finish-load` en uno y
  duerme 2,5 s fijos en el primitivo). → `scripts/drives/` + `import()` dinámico condicionado por env.
- **4 scripts `drive-*.mjs` idénticos**: el mismo archivo de ~1.940 B con 2 strings distintos. →
  `drive.mjs <nombre>`. Solo `drive-handover.mjs` se justifica (2 procesos, 2 fases).
- **Scripts desechables**: `check-assertions-discriminate.mjs`, `repro-authz-second-launch.mjs` (el
  bug ya está fijado en `tests/db/migrate.spec.js:277-331`), `inspect-bytes.mjs`, `preview-icon.mjs`,
  `sweep-english-copy.mjs` (140 líneas que **no están en ningún script npm ni en `verify:s0`**),
  `check-commit-bom.mjs` (sin script npm: un gate que nadie puede invocar por nombre).
- **6 de los 11 verificadores no tienen spec**: `verify-package`, `assert-bundle-selfcontained`,
  `assert-migrations-packaged`, `verify-encoding`, `check-contract`, `verify-installer-ui`.
- **3,25 GB en `release/`**: 9 directorios `build-*` acumulados. El staging timestamped es correcto
  y está bien justificado; lo que falta es un `prune` de los viejos.
- **`OPS` mantiene 27 operaciones sin handler**, y 4 de ellas se publican al renderer desde el
  preload como si funcionaran.

### 5.3 El modelo de datos arrastra peso muerto

Dos tablas con 11 líneas de justificación en el encabezado de `001_init.sql` y **cero rutas de
código**; columnas que nunca se leen; un límite de crédito que se guarda y nunca bloquea. Son 20
tablas porque los modelos las declaran, y `schema.spec.js` **exige** el censo, así que sacarlas es
una decisión de producto, no de código. Pero conviene **decidir y registrarlo**, en lugar de
mantener DDL que ningún flujo usa.

### 5.4 Una mina silenciosa en el empaquetado

`package.json:52-73` tiene **todas las dependencias de runtime en `devDependencies`** con
`"dependencies": {}`. Hoy funciona porque todo se bundlea y no hay módulos nativos. Pero
`electron-builder` **poda devDependencies**: el día que alguien agregue un módulo nativo, se romperá
en el instalador y no en `npm test`. Merece una nota explícita en `electron-builder.yml`, que hoy
explica 152 líneas de decisiones y no menciona esta.

---

## 6. Calidad de las pruebas

**Cobertura real.** 37 archivos, 665 `it()`, 2.341 `expect()`. Los 18 specs de `tests/db/` corren
contra SQLite real y la fixture `tests/db/fixtures/tienda.js:68-106` bootea una vez y copia por
test — **sin mocks**. En todo el suite hay **14 usos de `vi.fn`**, todos en `tests/lifecycle.spec.js`
y allí son legítimos (funciones puras de planificación).

**Lo valioso:**

- `tests/db/reportes.spec.js` (37 KB, 44 pruebas) deriva cada cifra a mano en comentarios
  (`28-47, 158-172, 241-250`) y **cruza dos caminos independientes**: `:352` exige que
  `reporteEstadoResultados().resultadoCentavos === reporteVentas().gananciaBrutaCentavos`, leídos de
  tablas distintas. También camina el JSON real buscando `NaN` y floats (`:128-152`).
- `tests/db/schema.spec.js` (38 KB, 46 pruebas): censo de tablas derivado, prohibición de `REAL`
  fuera de 3 columnas, doble partida exacta en enteros, clamp de la vista, `es_pesable` no escribible.
- `tests/db/ventas.spec.js:23-26` inyecta un trigger real que aborta la última escritura para probar
  atomicidad, en vez de un mock.
- `tests/ui/*.spec.jsx` (102 KB) montan React real, registry real y SQLite real; la única costura es
  el transporte de Electron.

**Lo débil:**

- **Cero pruebas de semántica de borrado.** Ningún spec ejercita `ON DELETE CASCADE/RESTRICT/SET
  NULL` ni consulta `pragma_foreign_key_list`. El único agujero estructural.
- `tests/lifecycle.spec.js` prueba funciones puras con objetos literales, no el cableado de
  `index.js`.
- `tests/integration/demo-catalogue.spec.js:60-70` **transcribe** el cuerpo de `installIpc` desde
  `index.js:61-92` en vez de importarlo. El propio archivo lo admite: un refactor de `index.js`
  rompe producción sin romper la prueba.
- `tests/security/offline-inert-hosts.spec.js`: 2 `expect` en todo el archivo.

**No encontré tautologías.** Los casos históricos están explícitamente corregidos y documentados
como tales (`migrate.js:179-193`, `mutate-attribution.mjs:26-35`,
`assert-migrations-packaged.mjs:50-57`).

---

## 7. Lo que está genuinamente bien

Esto no es cortesía: es lo que hace que el proyecto merezca la pena.

1. **`src/shared/money.js` + `qty.js` son la mejor pieza del repositorio.** Aritmética entera
   documentada y probada: redondeo *half-away-from-zero* propio porque `Math.round(-x)` redondea
   hacia cero en negativos, parseo por dígitos en vez de `parseFloat*100`, colapso de `-0`, y
   `costoPromedioCentavos` en **BigInt** con el desbordamiento explicado. El esquema hace cumplir lo
   mismo con un **test de censo** (`schema.spec.js:209-223`), no una foto.
2. **El runner de migraciones es de primera.** Una sola fuente de verdad (`user_version`), ledger +
   DDL + versión en **una** transacción, rechazo por checksum de archivo editado, detección de
   huecos y de divergencia, y el bug del allowlist de segundo arranque resuelto con reproducción.
3. **`connection.js`: defensa en profundidad real.** Authorizer deny-by-default con la tabla de "qué
   argumento lleva el nombre de tabla" **medida** contra SQLite 3.53.1 (`ALTER TABLE` → arg **2**, el
   caso que un gate ingenuo sobre `arg1` deja pasar), `ATTACH`/`DETACH` denegados, y `tx()` que
   **rechaza un cuerpo `async`** en vez de confirmar a medias. En el rollback, la excepción de
   dominio siempre gana.
4. **La frontera de seguridad está resuelta correctamente y probada como función pura.**
   `canonicalOrigin` compara `protocol//host` en vez de `.origin` (inmune al origen opaco de `app:`),
   con 4 formas de colisión de prefijo rechazadas. El preload son **38 líneas** con 4 miembros
   congelados y topics validados.
5. **La idempotencia de la venta está bien resuelta** — la clase de bug que casi siempre está mal en
   un POS: clave congelada + huella de los campos persistidos + rotación de clave cuando el ticket se
   editó tras un fallo, leyendo `duplicado`/`totalCentavos` de la respuesta.
6. **La sesión es una frontera real, no un decorado**: se re-lee la fila en cada uso (un empleado
   desactivado deja de operar en la siguiente llamada), `actorId` se lee por llamada (el relevo
   aplica al instante) y **el payload del renderer nunca se mezcla en el ctx** — con un script de
   mutación que lo pincha si alguien lo agrega.
7. **La cultura de falsabilidad está institucionalizada.** Scripts de mutación que *exigen* que la
   suite se ponga roja; control negativo del verificador ASAR; el probe con autocomprobación en 6
   transportes (porque *"un contador que reporta cero no vale nada si el contador no funciona"*); y
   comentarios que documentan **verificadores que antes no podían fallar** y cómo se arreglaron.
8. **`api/ipc.js` como frontera única y real**: ningún `.jsx` toca el bridge, no se emula el sobre de
   axios y se explica por qué, y `limpiar()` conserva `false`/`0` pero descarta `""`.
9. **El dinero nunca lo dicta la interfaz**: `api/compras.js:6-11`, `Deudores.jsx:27-32`,
   `Reportes.jsx:171-176` y `puntoDeVenta.jsx:145-150` documentan y respetan que el número que se
   guarda lo calcula el repositorio.
10. **El teclado del POS está bien pensado**: `Ctrl+F`, `F2`, `Esc` con el patrón de refs para no
    re-registrar el listener ni cerrar sobre estado viejo (`puntoDeVenta.jsx:606-657`).

---

## 8. Plan de acción priorizado

| # | Acción | Impacto | Esfuerzo |
|---|---|---|---|
| 1 | Implementar `platform.print` **o** borrar el botón de imprimir | El operador hoy cree que imprimió | Bajo |
| 2 | Test que compare clases `fa-*` del JSX contra `icons.css` + agregar los 16 glifos | 16 iconos en blanco, incluida la nav principal | Bajo |
| 3 | Sembrar el catálogo demo solo en "vacío confirmado", nunca en error | Un fallo de IPC hoy mete productos ficticios o abre una segunda caja | Bajo |
| 4 | Unificar la semántica de fecha de gastos con la del libro | Dos pantallas dan cifras distintas del mismo gasto | Medio |
| 5 | Sacar los drives de `src/main/` + gate de release que verifique su ausencia | 206 KB y una contraseña de prueba en cada instalador | Medio |
| 6 | Proteger `MINIMARCK_S0_PROBE` (que no borre un `userData` real) | Una variable de entorno borra la base de una tienda | Bajo |
| 7 | Índice `(negocio_id, estado, fecha)` + quitar `substr()` de `desglose` | Los reportes escanean la tabla entera | Bajo |
| 8 | Actualizar el README al estado real (62/89; el renderer no es la probe) | Enseña mal al próximo que llegue | Bajo |
| 9 | Borrar los 7 componentes muertos + `app/index.css` + `.page`/`.sidebar*` | ~600 líneas y 3 minas de CSS | Bajo |
| 10 | Un solo paradigma de datos en el renderer | Dos formas de cargar, invalidar y fallar | Medio |
| 11 | Sacar `asegurarPlan()` del camino caliente (una vez por proceso) | 25 sentencias por operación | Medio |
| 12 | Cerrar la cobertura de `ON DELETE` y arreglar las 2 FK | Único agujero estructural de la suite | Medio |
| 13 | Unificar los 5 mapas de método de pago y los formateos de fecha | Deriva ortográfica y de marca visible | Bajo |
| 14 | `limit`/`offset` validados en la frontera (clamp + 400) | `LIMIT -1` es "sin límite" en SQLite | Bajo |
| 15 | Accesibilidad del catálogo (tarjetas navegables con teclado) | Un POS que presume de teclado | Medio |

---

## 9. Conclusión

MiniMarck Desktop es un proyecto **bien construido y mal documentado**, no lo contrario. La
disciplina de ingeniería —dinero entero, transacciones atómicas, frontera de seguridad probada,
falsabilidad institucionalizada— está por encima de lo que se ve habitualmente en software de
gestión. Los defectos encontrados son, en su mayoría, **de acabado**: un botón que no funciona, 16
iconos sin glifo, dos pantallas que discrepan sobre una fecha, y un harness de pruebas que no
debería viajar en el instalador.

Ninguno de los hallazgos exige un rediseño. Los quince puntos del plan de acción son locales y
verificables, y los cinco primeros eliminan la mayor parte del riesgo percibido por un usuario.

**La recomendación principal es cultural, no técnica:** el proyecto ya sabe cómo escribir
verificadores que pueden fallar; lo que falta es **aplicar ese mismo rigor a la documentación**.
Hoy el README, cuatro comentarios y una constante de la interfaz afirman cosas que el código
contradice, y en un repositorio cuyo principal activo son los comentarios, eso es el defecto más
caro de todos.
