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

## 7. Credit-limit warning cannot see what the debtor already owes

**Web**: the limit check reads `deudaPendiente` (a running balance) and warns when
`nuevaDeuda = deudaPendiente + total > limiteCredito`
(`venta.controller.js:289-292`).

**Desktop**: `clientes_deudores` deliberately has NO balance column — the schema's own note
rejects cached balances as a source of drift — so the warning compares `total > limite` alone.

**Status**: willed, with fidelity loss. A debtor who owes 90% of his limit gets no warning until
a sale crosses the whole limit on its own. The ledger is the balance (sum of `1.3.01` entries),
so the faithful reading is a SUM over receivables, not a column; that query is the owner's move.

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

## 10. `verify:offline` allows three hosts, but only where it can prove they are inert

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