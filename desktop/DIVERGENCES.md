# DIVERGENCES — the desktop port against the web, and both against the spec

Every deviation this port makes from `backend/` behavior is recorded here, with the reasoning and
the owner of the fix, so that none of them can be mistaken for an oversight. Entries that are
spec-vs-both are marked as such: when a delta spec promises more than the web delivers, the port
follows **the web**, because the web is the behavior the business already trusts.

Legend:
- **Port vs web** — the desktop deliberately does something else.
- **Spec vs both** — the spec (SALE-*, CAJA-*) asks for something neither implementation does.
- **Owner** — who reconciles the difference. `schema` = whoever owns `001_init.sql` / migrations.

---

## 1. `mixto` payments — SPEC vs BOTH (not a port divergence)

**Spec**: SALE-7 enumerates `mixto` as a payment method and the renderer displays it.

**Web**: refuses it outright — `if (metodoPago === "mixto")` → 400
"Método mixto requiere desglose efectivo/crédito, aún no soportado"
(`venta.controller.js:66-73`). The POS never collects the cash/credit split it would need.

**Desktop**: refuses the same way, with the same reason in the message field and the port's
`VENTA_METODO_INVALIDO` code. `METODOS_PAGO` is frozen to
`['efectivo', 'tarjeta', 'transferencia', 'credito']`.

**Status**: parity. The divergence sits between the spec and reality; the product decides whether
the POS will ever collect a split, and only that unlocks `mixto` on either side.

---

## 2. Sale cancellation - RESOLVED, this is no longer a gap

**Web**: `PATCH /ventas/:id/cancelar` exists; a cancelled sale returns its stock and posts the
reversal.

**Desktop**: was the single largest port gap - the frozen contract had `OPS.ventas = ['list',
'get', 'create']`, so no renderer path could cancel a sale, even though `ventas.repo.js#cancelar`
existed in full. `ventas.cancel` is now in the contract (89 ops, up from 88), registered in
`src/main/ipc/ventas.js`, and the sales list has a two-step cancel with a required confirmation.

**Status**: RESOLVED. `npm run drive:payment` proves it in the real app: it takes a sale through
the till, cancels it from the list, and reads back that the stock returned to its original value
and the drawer recorded the egress.

---

## 3. `montoRecibido` / `cambio` — cash received is response-only on the desktop

**Web**: the sale record has no received-amount field at all — the ticket's "change" is derived
at print time from the tendered amount the operator types then.

**Desktop**: the POS sends `montoRecibido`; `crear` validates it against the total
(`VENTA_MONTO_INSUFICIENTE` when it falls short), returns `cambio`, and stores nothing on the
sale row — the sale is complete even with no `montoRecibido` (zero/blank means *absent*, not
"paid nothing", and no amount is assumed).

**Status**: extension, not contradiction: the money recorded is the web's money; the tendered
amount is UX the renderer exchanges with the data layer and no schema column claims it.

---

## 4. Opening with no float writes no APERTURA movement

**Web**: `abrirCaja` writes the opening movement unconditionally with
`monto: saldoInicial || 0` — a zero-centavo row on every float-less opening.

**Desktop**: the schema's `movimientos_caja CHECK (monto_centavos >= 1)` refuses a zero row, so
`abrir` records nothing when the float is zero.

**Why**: a drawer opened with no cash in it has had no cash event; the movement adds no
information the drawer's totals do not already carry. Same truth, fewer rows.

**Status**: willed. The web's zero row is arguably the artifact of an eager writer, and the
schema (which this port may not change) already picked the other side of that argument.

---

## 4b. The opening float is in the drawer but not in `1.1.01`

**The defect (both)**: `cajas.abrir` records the opening float as a `movimientos_caja` row (`origen =
'caja_apertura'`) and posted NO journal entry for it. So the till a cashier counts at close
(`saldo_inicial + ingresos - egresos`) was systematically `saldo_inicial` HIGHER than the balance
of the cash account in the ledger, and the two numbers — which exist to check each other — differed
by exactly the float. `backend/src/controllers/caja.controller.js:40-62` has the same gap: the
`APERTURA DE CAJA` movement, no entry.

**The accounting decision**: the float is an **owner contribution**, not revenue. The owner put
their own money into the drawer to open the till; until the books say so, that money has no origin.
It is not a sale (nothing was sold), and it is not a transfer between two accounts this app owns
(there is no bank account standing behind the drawer until the owner funds one). So the opening is:

```
1.1.01 Caja       debe   el float
3.1.01 Capital    haber  el float
```

`3.1.01 Capital Social` was ALREADY in the seeded chart (`cuentas.repo.js`, tipo `capital`,
"Capital aportado"), so this recorded where the money came from without inventing an account. No
migration was needed and none was added.

**Desktop — resolved.** `cajas.abrir` posts the entry through `asentar` with `tipo = 'apertura'` and
`referencia = 'caja:<id>'`, inside the SAME `ctx.tx` that creates the till and its APERTURA movement.
Atomicity is the point: a float sitting in the drawer with its journal entry rolled back is WORSE
than the gap it fixes — the drawer total would look right, the books would not explain it, and the
failure would stay invisible until someone reconciled. Either the till, its movement and its entry
all exist, or none of them do. A **zero float posts nothing** and stays legal: no cash event
happened, so no entry is written and the chart of accounts is not even grown to record a zero.

**The tests that were hiding it**: `tests/db/deudores.spec.js` asserted a DELTA across a cash
payment, and the reasoning recorded here was that an equality assertion "would have passed only by
folding the float into the expected value". That was the wrong conclusion — it was the DELTA that
could not see the gap, because a payment moves both the drawer and the ledger by the same amount and
never touches the difference the float opened. The assertion is now a direct equality of
`saldoCaja(caja)` against the `1.1.01` balance, before and after. Verified by mutation: commenting
out the `asentar` call turns 10 tests red across `cajas.spec.js`, `deudores.spec.js` and
`ventas.spec.js`; restoring it returns them to green, byte-identical (SHA-256 verified).

**Web — still open.** The same defect remains in `backend/src/controllers/caja.controller.js`. It is
not fixed here: this build owns the desktop path, and the web is the port's reference, not its
target. Whoever ports the opening back must post the same entry in the same transaction.

**Status**: desktop resolved; web still open, identical gap.

---

## 5. A negative register cannot be closed — the schema contradicts itself

**Schema**: `cajas CHECK (saldo_final_centavos >= 0)` forbids storing a negative close, while the
SAME file's note on `movimientos_caja` (header §7 of `001_init.sql`) states that a till which
spent more than it held "is a real state a shop can reach" and that a refusal "would leave the
register permanently unable to close".

**Web**: can't short-circuit into a decision, because it stores the negative happily and only the
reports look odd afterwards.

**Desktop**: `cerrar` computes the web's own formula
(`saldo_inicial + total_ingresos - total_egresos`, `caja.controller.js:107-110`), and when the
result is negative it refuses with `CAJA_SALDO_NEGATIVO` (409) and names the fix
(`cajaMovimientos.create` — register the missing income first).

**Status**: owned by `schema`. The reconciliation is a migration decision (drop the CHECK, or
make the deficit an explicit note type); the desktop must not quietly change schema law, so it
reports the number and stops.

---

## 6. Thousandths of a unit — finer quantity than the web can carry

**Web**: sale lines store `cantidad` as INTEGER grams; selling a quarter kilo is impossible and
nothing enforces that the decimal places are meaningful.

**Desktop**: `ventas_detalles.cantidad_milli` is an INTEGER thousandth (`0.001` = 1 milli =
1 gram for a 1 kg unit); `qty.js` parses at most 3 decimals, one separator, and rejects the
fourth decimal. A half kilo is `'0.5'` → 500 milli; the POS's `0.500` keypad literal means the
same.

**Status**: schema extension behind the same columns the web stores; the web's own units are the
integer subset. No web query changes meaning.

---

## 7. Credit-limit warning — RESOLVED, the limit is a ceiling on the resulting debt

**Web**: the limit check reads `deudaPendiente` (a running balance) and warns when
`nuevaDeuda = deudaPendiente + total > limiteCredito`
(`venta.controller.js:289-292`).

**Desktop**: was a willed fidelity loss. `clientes_deudores` deliberately has NO balance column —
the schema's own note rejects cached balances as a source of drift — so the warning compared
`total > limite` alone, and a debtor already 90% deep on his limit got nothing until one ticket
crossed the whole limit by itself. `v_clientes_deudores` (header §4) is the answer that was
already there: it derives both balances from the credit sales and the payments, so
`ventas.repo.js` now reads `deuda_pendiente_centavos` inside the sale's own transaction and warns
when the RESULTING debt is over the limit.

**Where the arithmetic is decided, and why it is not `pendiente + total`**: the check runs after
`INSERT INTO ventas`, and the view sums `ventas WHERE metodo_pago = 'credito' AND estado <>
'cancelada'`, so the row just inserted is already inside the number the read returns. That figure
IS the resulting debt. Adding `total` to it counts the ticket twice. The check is therefore
`proyectado > limite`, with the previous debt reported as `proyectado - total` — the same
comparison the POS draws on screen (`deudaPendienteCentavos + totalCentavos > limite`) and the
same one the web makes, reached from the other side of the INSERT.

**Status**: RESOLVED. The warning on the POS and the warning in the response read one number
between them, and neither can be right while the other is wrong.

---

## 7b. `mixto` on a DEBTOR PAYMENT — port vs web

**Web**: `deudor.controller.js:291-296` accepts `mixto` on `registrarPago`, because the web
writes no journal entry and no drawer movement for a payment. The money's destination is never
stated, so there is nothing to be wrong about.

**Desktop**: refuses it, with `PAGO_METODO_INVALIDO` and the same sentence `ventas.repo.js` uses
for a mixed SALE. A payment here is three facts that must agree — the debt shrank, the money is
somewhere, and the ledger says both — and `mixto` cannot answer the second one: the cash/credit
split is not collected by any screen and has no column in `pagos_deuda`. Posting one entry would
claim the whole amount arrived in a single account, which is the same lie `asentar` refuses when
one line is non-zero on both sides. The renderer never offers the method, so this refuses a
hand-written payload, not a button.

**Status**: willed, pending the same product decision as §1. Owner: product, for both.

---

## 8. The auditoría table records CREATEs and state flips — never edited money

**Web**: `auditoria` logs every mutation of a sale, including edits to its money fields — the
web treats the past as mutable.

**Desktop**: a sale's money fields are immutable by construction (the port never re-writes them),
so the only non-CREATE auditoría row the port can write is `cancelar`'s `UPDATE` with the
before/after `estado` (web-shaped: same columns, same accion vocabulary).

**Status**: willed. Fewer audit rows, none of them lies; the difference is the web's ability to
change history, which the desktop refuses.

---

## 9. The desktop adds `db:demo`; the web has no equivalent

**Web**: the app is served for a shop that already has its data, and its demo fixtures live in
seeding scripts that no production install runs.

**Desktop**: the first-run seed is the default business and one `admin` operator, nothing else
(PLAT-1), because a startup routine that invented stock would put fictitious kilos on a real
shelf. That is the right call and it is unchanged here. It also means a fresh profile opens the
POS onto «No se encontraron productos», where the sale flow cannot be evaluated by hand at all.

So the catalog is a separate, opt-in command (`npm run db:demo`) instead of a second seed. It
goes in through `productos.crear` — the same function the app calls — so a demo product cannot
differ from a real one in a column a hand-written INSERT would have forgotten. It is idempotent
by barcode, and `db:reset` removes it. The weighed product in the catalog is deliberate: the
scale is where the two silent bugs lived (see Internal notes), and a catalog without one would let
them come straight back.

**Status**: willed. Deliberate action installs fictitious data; a first launch must not.

---

## 10. A purchase posts a balanced entry, a moving average and an audit line — the web does none of the three

**Web**: `compra.controller.js` inserts the header, the lines and a `MovimientoCaja` row, and
stops. There is no journal entry, so the purchase never reaches `asientos_contables` and never
touches `1.2.01 Mercaderías`; the goods arrive and the balance sheet is not told. It does not
update `productos.precio_compra_centavos` either, so the cost a shop sells at afterwards is
whatever the catalogue was seeded with. And a credit purchase — the one where nobody has paid —
posts nothing at all to a payable, so the amount the shop owes its supplier exists only as an
undelivered order. The web's cash test is a boolean field on the line, not a drawer movement.

**Desktop**: `compras.repo.js` writes the stock, the weighted average, the `auditoria` line, the
balanced entry and the drawer movement in ONE transaction, or none of them. `1.2.01` is debited,
`1.1.01`/`1.1.02`/`2.1.01` credited by method, and the drawer moves only for cash — the split that
`1.1.02` was added for in the first place. A sale made afterwards is measured against the cost this
purchase actually set, and `ventas_detalles.costo_unitario_centavos` freezes that cost so the
margin reported is the margin earned.

Two consequences worth stating plainly rather than hiding:

- **A credit purchase is a payable that cannot be settled.** There is no `compras.pagar` in the
  frozen 89-op contract and none was invented, so a purchase bought on credit stays `pendiente`
  and `2.1.01` keeps growing. The supplier screen shows what is owed; there is no screen yet that
  pays it. This is a real gap in the product, not a rounding of the port.
- **Cancelling gives cash back only into an OPEN till**, and refuses otherwise with
  `CAJA_ABIERTA_REQUERIDA`. A closed drawer cannot prove it is holding anything, the same argument
  `deudores.addPayment` makes. The alternative — posting the reversal entry and skipping the
  movement — was written, tested away, and left a ledger that said the money returned while the
  drawer said it did not.

**Status**: willed. The web's purchase is an order form; this one is an accounting event.

---

## 11. A purchase is reversible, and only while it still is

**Web**: `compra.controller.js` `destroy()` sets `estado = 'cancelada'` and stops. The stock stays
on the shelf, the cost stays folded into the average, the journal entry this port writes stays
posted, and the cash stays out of the drawer. The purchase reads as cancelled in every list while
the goods are still being sold.

**Desktop**: `compras.cancelar` reads the per-line `auditoria` snapshot this purchase wrote, puts
the stock and the cost back, mirrors the entry on the other side, returns the cash to the till, and
records a `DELETE` line. The cost it can restore is EXACT only while no later live purchase folded
its lot into the same product's average, so a purchase with a successor is refused with
`COMPRA_NO_REVERSIBLE` and the message says to cancel in reverse order. It also refuses if the
stock or the cost has since been corrected by hand (`COMPRA_STOCK_MOVIDO`, `COMPRA_COSTO_MOVIDO`)
rather than restoring a snapshot over a correction the operator made deliberately.

The supplier is a separate story: `proveedores.remove` refuses with a 409 while a purchase points
at them, and the answer offered is to deactivate. The web calls `proveedor.destroy()` with no such
check, leaving purchases naming a counterparty that no longer appears in any list.

**Status**: willed. Reversibility is bounded, and the bounds are named instead of being papered
over with a status flip.

---

## 12. `verify:offline` allows three hosts, but only where it can prove they are inert

**Web**: the offline guarantee is "the bundle contains no reference to a CDN" — a property of how
the assets were produced, checked by a human reading the build output.

**Desktop**: it is a gate, and a gate that cannot tell a comment from a `fetch()` is either
useless or a blanket allowlist. The vendored renderer is minified `react-dom` and `tailwindcss`,
which carry three absolute URLs that are text rather than requests: the Tailwind MIT banner, a
React `error-decoder` message the runtime throws, and a `// TODO` copied from React DOM source.

**Status**: willed, and narrower than it looks. These three hosts are exempt only at an occurrence
where `isFetchableUse()` finds no `url()`, `@import`, tag `src`/`href` or transport call within
reach of the match. Putting `reactjs.org` in the flat `ALLOWED_EXTERNAL_HOSTS` set would have been
the shortcut, and it would have let a future `fetch("https://reactjs.org/...")` pass — the exact
bug the gate exists to catch. That was checked rather than assumed: injecting a real
`fetch("https://reactjs.org/malicious.js")` into the built bundle still fails the gate with
`external-origin`. The runtime half of the claim is the launch probe's OFFL-1 check, which arms
fetch, XHR, WebSocket, EventSource, sendBeacon and `img` on the real app and requires zero
attempts at any real origin.

---

## 13. Local user management is four `auth` operations, and there is no `usuarios` module — port vs web

**Web**: `UserForm` plus a `usuarios` controller. It creates a person, EDITS one (name, role,
active flag) and deactivates one. The role a person holds is something the shop can change later,
because the web is a multi-user system with an administrator sitting in front of a form.

**Desktop**: the frozen contract is 89 operations in 18 groups, and **no `usuarios` group exists
in it.** Creating an employee therefore reuses `auth.register` with a session open — the same
operation the first launch uses with no session, taking a different branch — instead of inventing
a `usuarios.crear` that the packaging and contract gates would then have to accept. Editing and
deactivating have no authorized operation at all, so `Usuarios.jsx` does not offer them and a
hand-written payload could not perform them either.

**The interesting half is what still exists.** `session.exigir()` re-reads the row on EVERY
operation with `WHERE u.id = ? AND u.activo = 1 AND u.deleted_at IS NULL`, so a person who stops
being an employee loses their authority on the next call, mid-session, with no re-login. The
mechanism is real, exercised by tests, and there is simply no operation that flips `activo` to
call it. That is a hole in the product, and it is named here instead of being papered over with an
operation the contract does not authorize.

**Status**: gap, owner `contract`. Adding `usuarios.update` / `usuarios.deactivate` is a
contract decision with a schema question attached (`users.activo` exists; the audit story for a
role change does not), not something this build may settle on its own.

---

## 14. Roles are enforced in the main process; the renderer gate is a courtesy — port vs web

**Web**: Express middleware checks the role per route, and the router hides the link. Two separate
places, and the server one is the one that counts.

**Desktop**: the route table is frozen, so there is no server-side route guard to hang a check on
— and the renderer is not a boundary. The authority is therefore re-checked where the work
happens, in `crearEmpleado`: `session.exigir()` (a session is open), then
`exigirAdministradorDeUsuarios(actual.rol)` (`admin` or `supervisor`), then the escalation rule —
a supervisor may run the users module but may NOT create an `admin` (`SIN_PERMISO`, 403, "Sólo el
dueño puede crear otro dueño"). A `vendedor` calling `auth.register` by hand gets the same 403
that the missing button implies.

**Why this is written down**: a renderer-only gate is a comment that costs a rebuild. Anyone
simplifying `Usuarios.jsx` later will find `puedeAdministrarUsuarios` sitting there looking like
the check, and deleting it would change nothing about what a signed-in seller can do — which is
exactly the shape of a control that looks armed and is not. The check belongs in the main process
even when the UI also hides the door.

**Status**: parity, with the enforcement point moved. The web checks in middleware and the desktop
checks in the handler; both are server-side, and the renderer is not trusted in either.

---

## 15. The sign-in HANDLE is not `users.email`, and the seed's own row proves it — port vs web

**Web**: `users.email` IS the login identifier. One field, one meaning.

**Desktop**: `nombreAcceso` is the handle, and it is deliberately NOT assumed to be the email. The
first-run seed gave its operator `admin@minimarck.local` as an email, and that row is ADOPTED
rather than replaced, so a person whose handle is `dueno` legitimately carries an email that is
not their handle. `usuarioPublico()` therefore returns both (`nombreAcceso` and `email`) and never
makes a caller guess which one signs in.

**Why it is a divergence and not a nicety**: the handover picker lists people and asks for a
password. Had it fed `email` back into `auth.login`, the list would have looked perfectly correct
and **every handover would have failed** — the owner adopts the seeded row, whose email is not the
name they type. This is the same class of bug as the seed trap in the internal notes below: a
field that is right in one place and wrong in the next, where nothing complains.

**Status**: willed, and it changes nothing a user can observe except that signing in works with
the name they chose.

---

## 16. An owner-typed expense posts to the ledger, against `5.4.01 Otros Gastos` — a real account the web does not have

**Web**: `POST /api/movimientos-caja` writes the movement row and updates the till's totals. It
posts **nothing** to the accounting ledger — `backend/src/models/MovimientoCaja.js` has no ledger
side at all, and `backend/src/controllers/movimiento.controller.js` never calls an `asentar`. A
sale or a purchase posts because the SALE and the PURCHASE own their entries; a manual movement in
the web is a drawer with no journal behind it.

**Desktop**: `cajaMovimientos.crear` now posts, in the same `ctx.tx()` as the movement row and the
till total:

- `tipo: 'egreso'` → **debit** `5.4.01 Otros Gastos`, **credit** `1.1.01 Caja`
- `tipo: 'ingreso'` → **debit** `1.1.01 Caja`, **credit** `4.2.01 Otros Ingresos`

**Why this had to be a divergence and not a port.** In the desktop the gap is not a missing feature,
it is a broken invariant that the reports themselves assert. `reportes.cash` compares the drawer to
`1.1.01` and publishes the answer as `coincide`; an unposted movement makes that field lie, and
every report built on the same account inherits the lie. The `cerrar` failure made it worse by
pointing the operator at `cajaMovimientos.crear` to record the money they forgot to ring up —
following the app's own advice walked the shop straight into the divergence it was trying to
prevent.

**Why `5.4.01` is a NEW account, and why it is not a migration.** The instruction was "use a code
that already exists; if there is none, add it through a new versioned migration, never by editing
`001_init.sql`". Neither half was available, for a structural reason:

- **There is no seeded chart to use.** Every gasto in `PLAN_CONTABLE` names something specific
  (`5.2.02 Alquiler`, `5.2.03 Servicios`, `5.2.01 Sueldos`, `5.3.01 Gastos Bancarios`). An
  owner-typed expense carries a free-text `concepto` and an amount, so the app genuinely cannot tell
  a bag of packaging from a light bill. Imputing one to `5.2.03` would not be an approximation, it
  would be a confident and false claim in the ledger — a mistake that survives a year and then
  makes a real report wrong. `5.1.01 CMV` is worse: it is cost of goods sold, booked per sale from
  the recorded line cost, so an owner expense there double-counts stock and corrupts the margin.
  A catch-all is the only account that says only what is true.
- **A migration cannot add it, because it has no business to attach it to.** `001_init.sql` contains
  **no account INSERTs at all** — the chart is not in SQL. `cuentas_contables.negocio_id` is
  `NOT NULL REFERENCES negocios(id)`, and `bootstrap.js` runs `migrate()` then `seed()` with no
  business existing yet, so a global `INSERT INTO cuentas_contables` would violate NOT NULL on every
  database in the world. The chart   is created per tenant, on demand, by `asegurarPlan()` from the
  `PLAN_CONTABLE` array with `ON CONFLICT DO NOTHING` (`ux_cuentas_contables_codigo_negocio` is the
  arbiter). **Appending a row to that array is this project's add-only account mechanism**: an
  existing shop gains the account the next time anything calls `asegurarPlan` — in practice its
  first till opening with a float, or its first sale, whichever comes first — an existing account is
  never rewritten, and the account and the entry that needs it are created in the same transaction.
  Writing the tests is what corrected the order here: the first draft assumed the account appeared
  with the first expense, and a test that deleted the row to imitate an older database showed it
  already exists beforehand, which is the better order — the account is there before the first
  expense that could need it, rather than on the same request. `3.1.01 Capital Social` and `2.1.01
  Proveedores (Acreedores)` are precedent — both are in the web's chart and neither needed a
  migration.
- `4.2.01 Otros Ingresos` already existed, so the `ingreso` direction needed no addition at all.

**Why the post lives in `registrarMovimiento` and is gated on `origen === 'manual'`.** Five other
callers reach that function and each already posts its own entry, at a different moment and against
different accounts: a sale posts revenue AND the CMV, a purchase posts inventory against a payment
method, a debtor payment posts the receivable, a till closing posts nothing because it moves no
money. A debtor payment is `origen: 'manual'` too — no ticket brought the money in — so it is the
one caller that must opt out explicitly, and it does, with `libro: false`, on the line above the
entry it already posts. The polarity is deliberate: the default is "post", because a caller that
forgets is the bug being fixed. A default of "do not post" would put the correct behaviour behind a
flag nobody thinks to set.

**Proven, not asserted.** `npm run mutate:expense` breaks the behaviour three ways and requires a
red test each time, comparing the file's SHA-256 before and after every revert:

- the post removed — **6 tests red**, and `reportes.cash` publishes `coincide: false` again, which is
  the divergence the report was built to catch;
- the account swapped for `5.1.01 CMV` — **3 tests red**. This is the one worth reading twice: the
  entry stays balanced, the drawer still equals `1.1.01`, and `coincide` stays **true** through the
  whole thing. A report can be perfectly self-consistent and still impute a light bill to cost of
  goods sold, which is why the tests name the account instead of asserting the total;
- the `manual` guard removed — **14 tests red** across the till, the sales, the purchases and the
  debtor payments. A double-post drifts the drawer and `1.1.01` by the same amount together, so
  `coincide` stays true through that one too; only counting entries sees it.

**Status**: willed. The web's behaviour is a defect the desktop does not inherit, and a shop that
reads a report where the drawer and the ledger disagree has been told a number that is not true.

---

## Internal notes (not user-visible, kept for the reviewer)


- **Timestamps** are ISO-8601 UTC strings (`2026-01-01T00:00:00.000Z`), lexicographically
  sortable the way the web's `DATETIME` is; `substr(fecha, 1, 10)` in desglose equals the web's
  `DATE(fecha)` extraction.
- **Constraint identity**: better-sqlite3 reports `code = 'ERR_SQLITE_ERROR'` with the SQLite
  extended code in `errcode` (2067 for UNIQUE); SQLite names the offending COLUMN
  (`UNIQUE constraint failed: cajas.negocio_id`) and never the index. Port matchers and tests
  key off the column + code family, not index names.
- **IVÁ per line** is derived, not carried: the web prices include IVA and split it forward; the
  desktop computes the line total first (gross) and extracts the exact IVA
  (`base * pct / (100 + pct)`, half-away rounding). The user-visible numbers are identical;
  only the arithmetic order differs.
- **Two weighed-sale bugs, and what they cost.** The vendored `CalculadoraPeso` read
  `producto.precio`, a field the desktop does not have (it stores `precio_centavos`), so the
  confirm button was permanently disabled; and the handler multiplied the base quantity by 1000
  a second time before `toMilli`, so 500 g was stored as 500 **kg** and a $1.000,00 cheese
  became $1.000.000,00. Both were silent — no error, no crash, a wrong number on screen — and
  both survived the port because the vendored component had never been exercised against the
  desktop's own money and quantity contracts. The fix is asserted twice: `tests/ui/` now drives
  500 g / $1.000,00 / −500 milli through the real component, and that test was mutation-checked
  (SHA-256 `BA9E8233…` → `1AC8C58A…` → reverted) so it is known to fail when the conversion
  breaks, rather than merely passing.
- **`productos.crear` takes PESOS, the store keeps CENTAVOS.** Anything that calls the repository
  from outside the IPC layer has to convert, and forgetting it is a factor-of-100 bug that no
  type system here catches. The demo script above is the second caller; it is the reason the unit
  is stated in the function's own documentation.
- **The seed asked "is this file seeded?" using a NAME the user is about to change.** `seed()`
  looked for `negocios.nombre = 'Mi Negocio'`, in the outer check and again inside the
  transaction. The owner names their shop at the sign-in panel, which renames that row, so the row
  the seed is looking for by name no longer exists; the next launch reads "not seeded" and INSERTS
  a second business. Two active shops, `resolveLocalIdentity` correctly refuses to pick one, and
  **every business operation answers `TENANT_REQUIRED`** — the till is unusable and the only
  message points at nothing. It is now "does this file have a shop?" (`WHERE deleted_at IS NULL
  ORDER BY id LIMIT 1`), the same question `negocioUnico` asks, and it is asked by existence rather
  than by a value the user owns.
  - **Found by the handover drive's SECOND phase**, which relaunches the real app on the same data
    directory. 540 unit tests could not see it: every one of them opens a FRESH temporary
    database, and not one renames a business and then bootstraps again. A test that cannot fail is
    not a test, and neither is a suite that only ever sees a pristine file.
  - `tests/db/seed.spec.js` now covers it, and its own weight was checked by re-breaking the fix:
    reverting both lookups puts 2 of its 3 tests red, and reverting only the outer one still puts
    1 red, because the in-transaction re-read blocks the insert on its own. Half a fix looks like
    a covered bug.
  - **The red that was NOT a bug**: six `bootstrap.spec.js` tests failed with
    `no such column: deleted_at` on the new query. The real schema is `paranoid` on every table
    (`tests/db/schema.spec.js` asserts it), but that file's hand-written `MINIMAL_SCHEMA` had no
    `deleted_at` column, so it was testing a DIFFERENT PROGRAM — one where the query cannot run.
    The honest reading of that red was "the fixture lied", and the fixture was corrected rather
    than the query.
- **`mutate-attribution.mjs` proved its own restore for one file and not the other.** The check
  read `if (despues !== antes || despuesCtx !== sha(contexto))` — comparing the restored
  `contexto.js` against a hash taken FROM THE FILE AS IT IS AT THAT MOMENT, i.e. against itself.
  `x !== x` is false, so `RESTAURACIÓN INCORRECTA` was unreachable for the mutated file and the
  script printed `RESTAURADO OK` having verified only half its claim. Both hashes are now captured
  BEFORE the mutation and compared to those. A restore check that cannot fail is a comment — the
  same standard the mutation script exists to apply to everything else.
