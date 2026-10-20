# Informe V1.1 — MiniMarck Desktop

> Auditoría honesta del estado real del proyecto y qué falta para una versión 1.1.
> Medido sobre `HEAD = d1bbcbb` con el árbol de trabajo sucio (WIP de auth + rename CSS sin commitear).
> Este informe **actualiza** `INFORME-PROYECTO.md`, que quedó anclado a `e7bd363` y ya no refleja el código.

---

## Veredicto de una línea

Es una aplicación **mucho más madura de lo que su propia documentación dice** —pero **no está en "solo pulir para 1.1"**. Hay 4 o 5 defectos que un dueño de almacén toca el primer día, y el árbol de trabajo tiene una feature a medio hacer que **hoy deja la suite de tests en rojo**.

---

## 1. Dónde está parada HOY (medido, no estimado)

| Dato | Valor real |
|---|---|
| Contrato IPC | 89 ops → **82 implementadas, 7 en 501** |
| Tests | **904 pasan / 1 falla** (la falla es del árbol sucio, no del código commiteado) |
| Pantallas montadas | 14 reales (POS, Ventas, Cierre de caja, Deudores, Panel, Reportes ×11, Productos, Categorías, Proveedores, Compras, Contabilidad ×4, Respaldos, Usuarios, Acceso) |
| Stack | Electron 44 + `node:sqlite` directo (sin módulos nativos) + React 18 + Tailwind |
| Documentación | `INFORME-PROYECTO.md` desactualizado (dice 62/89, escrito en `e7bd363`) |

Las 7 operaciones que todavía responden 501:

- `notificaciones.list`
- `platform.export.xlsx`
- `platform.export.pdf`
- `platform.print`
- `platform.shell.showItemInFolder`
- `db.reconcile`
- `importer.status`

**Atención:** 3 de esas (`export.xlsx`, `print`, `showItemInFolder`) las publica el preload como si funcionaran (`src/preload/index.js:31-33`). Es una promesa falsa del bridge: cualquier código que las invoque recibe un rechazo, no un resultado.

---

## 2. Lo que está GENUINAMENTE bien

No es cortesía; es lo que hace que el proyecto valga la pena y es raro encontrarlo:

1. **El dinero es aritmética entera de punta a punta**, con un test de *censo* que lo prohíbe (no una foto). `src/shared/money.js` y `src/shared/qty.js` son la mejor pieza del repo: redondeo propio (*half-away-from-zero*), parseo por dígitos, `BigInt` para el costo promedio.
2. **El runner de migraciones es de primera**: checksum SHA-256 por archivo, DDL + ledger + versión en UNA transacción, rechazo de migración editada.
3. **La frontera de seguridad está resuelta y probada**: preload de 4 miembros congelados, allowlist de 89 ops, origen real `app://`, **cero llamadas de red** verificadas en 6 transportes (con auto-comprobación del contador).
4. **El harness de prueba es serio**: 18 specs de `tests/db/` corren contra SQLite real, sin mocks, con cifras derivadas a mano. Hay un script de *mutación* que exige que romper el código ponga el test en rojo.
5. **La idempotencia de la venta y el manejo de sesión** están bien resueltos — la clase de bug que casi siempre está mal en un POS.

Esto es base de producto, no prototipo.

---

## 3. Lo que le falta para "completarla"

### 3.a El resto de las operaciones (lo superficial)

| Falta | ¿Importa para un almacén? |
|---|---|
| `platform.print` | **Sí, y hoy está peor que faltar** (ver §4) |
| `platform.export.xlsx/pdf` | Sí — el dueño quiere llevarse reportes a Excel |
| `notificaciones.list` | No — el subsistema está muerto por diseño |
| `db.reconcile` | No — nicety de diagnóstico |
| `importer.status` | Depende — importar una lista de productos de un proveedor |

### 3.b Huecos de producto que un almacén SÍ espera

- **No se puede imprimir una boleta** (el botón existe y no hace nada).
- **No hay exportación** en ningún reporte (11 pestañas, cero botón de exportar).
- **No se puede editar un empleado** (nombre / rol / activo) — solo crear y resetear contraseña. El contrato **no tiene grupo `usuarios`**, y el schema tiene `users.activo` sin ninguna operación que lo toque.
- **No se puede editar un deudor** — se crea y se cobra, pero un nombre mal tipeado no se corrige.
- **El plan de cuentas es de solo lectura** en la UI (las operaciones existen, pero está escondido a propósito).

---

## 4. Riesgos a cerrar ANTES de decir "1.1"

Ordenados por lo que le duele al dueño:

| # | Riesgo | Estado | Evidencia |
|---|---|---|---|
| **P0** | El harness de QA viaja en el instalador (ahora **7** drives + contraseña literal `clave-de-probeta`) | **ABIERTO, y empeoró** | `src/main/index.js:29-35,221`; solo se limpia el renderer |
| **P0** | Feature de auth a medio hacer rompe `npm test`: la migración `005_auth_force_change.sql` (sin commitear) colisiona con el fixture, y su columna `must_change_password` **no tiene una sola línea de código** | **ABIERTO (árbol sucio)** | `tests/db/backup.spec.js:515-518` |
| **P1** | "Imprimir Boleta" no hace NADA, en silencio: usa `window.open` que `security.js` deniega → `null` → retorna mudo. El operador cree que imprimió. | **ABIERTO** | `BoletaPago.jsx:43-44`, `src/main/security.js:101` |
| **P1** | Dos pantallas dan cifras distintas del mismo gasto (una filtra por `created_at`, el libro por `asientos.fecha`) | **ABIERTO** | `src/main/db/repositories/reportes.repo.js:231,1069` vs `:577` |
| **P1** | Un fallo de lectura se muestra como "no hay datos" y ofrece una acción destructiva (sembrar productos ficticios / abrir una 2ª caja). Además `CajaGuard` sigue haciendo `parseFloat` sobre plata | **PARCIAL** | `puntoDeVenta.jsx:576,704`, `CajaGuard.jsx:16,18` |
| **P1** | El `code` de error nunca cruza el IPC → todo cae a `IPC_ERROR` y el operador ve texto crudo | **ABIERTO** | `src/main/bridge/errors.js:1-5`, `src/renderer/app/api/ipc.js:89` |
| **P2** | FKs rotas (`users.negocio_id ON DELETE SET NULL`; `user_identidades.user_id` sin `REFERENCES`); BOM en 3 archivos; `resetPassword()` muerto con contraseña hardcodeada | **ABIERTO** | `001_init.sql:246`, `002_identidades.sql:34`, `auth.service.js:454` |

**Ya arreglados desde el informe viejo** (para que no generen ruido): la variable de entorno que podía borrar la base real (**FIXED**), los 16 iconos en blanco (**FIXED**, con test), las tablas muertas (**ahora en uso**).

---

## 5. Una 1.1 REALISTA (scope propuesto)

Si "1.1" significa "una versión que el dueño usa todos los días sin sorpresas", el orden debería ser:

1. **Cerrar el árbol sucio primero** — commitear o descartar la feature de auth a medias. Hoy la suite está roja por eso; nada más importa hasta que vuelva a verde.
2. **Arreglar Imprimir** (una de dos: implementar `platform.print` de verdad, o borrar el botón). Bajo costo, mata una mentira visible.
3. **Sacar el harness del instalador** + gate de release que verifique su ausencia. Es seguridad y peso.
4. **Unificar la semántica de fecha de gastos** (P1 de corrección contable).
5. **Exportar reportes a Excel/CSV** — el hueco de producto más pedido y el más barato de cerrar.
6. **Endurecer el camino de error** (D3 + D7): un fallo de lectura nunca debe ofrecer una acción destructiva.
7. **(Opcional 1.1.x)** editar empleado y deudor — requiere ampliar el contrato a un grupo `usuarios`, es decisión de producto.

**Fuera de 1.1:** notificaciones, `db.reconcile`, importer, y el plan de cuentas editable. No aportan al uso diario.

---

## 6. Cierre honesto

Hay una base de ingeniería **por encima de la media** — dinero entero, transacciones atómicas, frontera de seguridad probada. Lo que falta no es rediseño: son **cabos sueltos de acabado** (print, export, fecha de gastos) más **una deuda que no es de código sino de higiene**: el árbol de trabajo tiene trabajo a medio hacer que rompe la suite, y la documentación del repo se contradice sola.

La aplicación **ya es usable** para vender, cobrar y reportar. Para llamarla "1.1 completa" le falta cerrar esos P0/P1 y decidir producto sobre usuarios y deudores editables.

---

*Generado a partir de: `npm run verify:contract` (82/89), `npm test` (904/905), y dos auditorías de código sobre `d1bbcbb`.*
