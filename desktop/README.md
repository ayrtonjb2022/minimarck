# MiniMarck Desktop — S0 runtime, S1 data layer, S2 schema

The offline Electron + SQLite shell for MiniMarck. **S0** proved the runtime and the security
model: a real window, a real `app://` origin, a real `node:sqlite`, and the trust boundary every
later slice builds on. **S1** added the data layer — a real open database, a versioned migration
runner, and a first-run seed. **S2** added the schema itself: the 20 tables the backend models
declare, every money column an integer number of centavos, and the packaging that gets the SQL
into the build.

The contract is 89 operations, of which **27 are implemented** and **62 honestly answer a structured
`NOT_IMPLEMENTED` (501)**, so the renderer never mistakes "not built yet" for "succeeded". A shop
can open a till, sell, take cash with the change calculated by the database, print a debtor's
receipt, and cancel a sale.

## Quick path

```bash
npm install
npm run verify:s0        # spike + tests + build + preload-format + migrations-packaged + offline + launch probe + payment drive
npm run probe:launch     # just the launch probe (also runs inside verify:s0)
npm run drive:payment    # just the payment drive (also runs inside verify:s0)
```

Expected: `verify:s0` green. The Node version is pinned in `package.json` `engines`
(`>=24.18.0 <25`) because the app ships Electron 44.4.5's Node **24.21.0** and the S0 spike
exists precisely to pin that runtime rather than drift with whatever the machine has.

## First run: the empty catalogue

A brand-new install has **no products** — MiniMarck does not ship a shop's stock. Opening the point
of sale with an empty catalogue used to show an empty grid with no way forward, which reads as
"broken" rather than "new". It now distinguishes three different empties, because they need three
different answers:

| State | What the user sees |
|---|---|
| First run, nothing in the catalogue | A panel explaining the shelf is empty, with a button to load the **fictional demo catalogue** |
| A search or category filter that matches nothing | "No products match", keeping the search box and the filters in view |
| Products exist but all are out of stock | The out-of-stock list, marked as such |

The demo catalogue is **opt-in and fictional** (six generic grocery items: pan, leche, aceite, fideos,
gaseosa, queso). It is created through the ordinary `productos.create` IPC operation — the same path
the app uses for a real product — so loading it exercises real code rather than a back door. The
same list is available from the command line:

```bash
npm run db:demo     # seeds the CURRENT profile's database
```

Both write through `src/shared/demo-catalogo.js`, so the button and the CLI can never disagree about
what the demo data is. The IPC contract is still **89 operations**; nothing was added for this.

## What S0 proves

| Claim | How it is proven | Evidence |
|-------|------------------|----------|
| Electron 44.4.5 ships working `node:sqlite` | `npm run spike` — real DB file, table, insert, read, WAL, second handle, `backup()` | `9/9 passed` |
| No native module, no rebuild, no ABI lock | The spike asserts the stack is `node:sqlite` only | `ABORT CRITERION CLEARED` |
| The app makes **zero** network calls | `verify:offline` fails the build on any external origin in any build output; the renderer probe instruments fetch, XHR, WebSocket, EventSource, sendBeacon and off-origin elements | `0 outbound attempts to any real origin`, with the recorder proven live on all 6 |
| The renderer gets a narrow bridge, not `ipcRenderer` | Preload exposes exactly `call`, `on`, `platform`, `env` and nothing else | `SEC-1 bridge exposes exactly 4 members` |
| The renderer cannot reach SQL or the filesystem | `sandbox:true` + a 89-op allowlist registry; unknown group/op is rejected in main | `Unknown group: evil` |
| The origin is real, so storage and routing work | `app://bundle` is privileged + standard, so `localStorage` and `BrowserRouter` behave | `origin is a real origin — app://bundle` |
| Only the trusted origin can reach IPC | `SEC-4` compares the **parsed** origin, so `http://localhost:5173@evil.com/x` is rejected | `REJECT(403)` on all 4 prefix-collision shapes |

### What "zero network calls" does and does not prove

The probe counts outbound attempts on **six** transports, not just `fetch` — `XMLHttpRequest`,
`WebSocket` and `EventSource` all leave the machine without ever touching `window.fetch`, and an
app that only counted `fetch` would look clean while streaming telemetry over a socket.

A counter that reports zero is worth nothing unless the counter works, so the probe fires a
**self-check** first: it deliberately attempts each transport against `*.invalid` (RFC 2606,
reserved, never resolvable, blocked by the CSP) and asserts the recorder caught it. A PASS
therefore means *the counter is live AND saw nothing*.

That distinction is not theoretical. Disabling the `WebSocket` wrapper leaves
`0 outbound attempts to any real origin` still **PASSING** while the probe exits non-zero on
`recorder is live on WebSocket` — a broken recorder and a clean app report the same zero. That
is exactly why the self-check exists.

### What the offline gate catches, and what it cannot

`verify:offline` is a **text scan** over the build output. It makes the *accidental* case
impossible; it cannot see the deliberate one. Measured, not assumed:

| Source form | Gate |
|---|---|
| `<script src="//cdn.example.com/x.js">` in the built JS | **FAILS** — `tag-protocol-relative` |
| `new WebSocket("wss://telemetry.example.com/s")` | **FAILS** — `socket-origin` |
| `fetch("HTTPS://API.EXAMPLE.COM/x")` | **FAILS** — `external-origin` |
| `createElement("script").src = "//cdn.example.com/x.js"` | **passes the scan** |
| `fetch("https://" + host + "/x")`, base64, `eval` | **passes the scan** |
| `import(runtimeAssembledUrl)` | **passes the scan** — unwrappable in JS |

The last three are the gate's stated limit, not an oversight. What stops them is the CSP, and
that is now **proved at runtime rather than asserted in a comment**: the launch probe injects an
inline script and asserts it does *not* execute, because `script-src 'self'` carries no
`'unsafe-inline'`. The check is not vacuous — adding `'unsafe-inline'` back to `script-src`
makes the probe report `24/25` and exit 1.

An inline script is used rather than an external one deliberately. Pointing at
`cdn.example.com` and asserting the script did not run would also pass when the script simply
failed to resolve — a DNS failure is indistinguishable from a policy block, so the check would
prove nothing. An inline script has no network dependency, so there is no third explanation.

`frame-src 'none'`, `object-src 'none'`, `form-action 'none'` and `base-uri 'none'` complete the
policy; `sandbox:true` is the outer boundary. See `VENDORED.md`.

## Runtime facts (measured, not assumed)

| Fact | Value |
|------|-------|
| Electron | `44.4.5` |
| Node inside Electron | `24.21.0` |
| Chromium | `152.0.7977.130` |
| SQLite | `3.53.4` |

`node:sqlite` is used **directly** — no `better-sqlite3`, no `node-gyp`, no prebuilt binary, so
there is no native ABI to break on an Electron upgrade.

## Building and shipping the installer

```bash
npm run dist          # production build -> NSIS installer at release/MiniMarck Setup.exe
npm run pack:dir      # same build, no installer — the unpacked app only
```

`dist` produces `release\MiniMarck Setup.exe` (about 96 MB) and records the build in
`release\LATEST.txt`. **Double-click it.** It installs per-user under
`%LOCALAPPDATA%\Programs\MiniMarck` with **no administrator prompt**, creates a desktop and
Start-menu shortcut, and appears in Programs and Features as *MiniMarck 1.0.0*.

- **The installer is UNSIGNED.** Windows SmartScreen will show "Windows protected your PC" on
  first run; the user clicks *More info* → *Run anyway*. This is expected for a build that is not
  bought from a certificate authority, and it is a one-time warning per machine, not a defect.
- **Language.** The wizard is Spanish (`nsis.installerLanguages: [es_ES]`). Proven by running it —
  see `verify:installer-ui` below — not by grepping the binary.
- **Uninstalling keeps the data.** `deleteAppDataOnUninstall: false` means the shop's database
  survives, so reinstalling brings the catalogue, the sales ledger and the till history back. See
  `## Uninstall keeps the data` for the proof.

### Why the build stages into a timestamped directory

`npm run dist` writes to `release\build-<timestamp>\`, then copies the installer up to
`release\MiniMarck Setup.exe`. It does not build into `release\` directly because a leftover
`release\win-unpacked\` from an earlier run can be **locked by a security scanner** (Avast and the
Windows Search indexer were both observed holding memory-mapped handles to `app.asar` on this
machine). `electron-builder` then fails with `EBUSY: resource busy or locked, unlink ... app.asar`
even though no build process is running. Staging means every build writes somewhere new and never
touches the locked directory. Deleting the old `release\` is still fine to attempt, but it is not
required and may fail.

### Verifying a build

```bash
npm run verify:package        # the staged release/: asar contents, no probe, installer is a PE
npm run verify:installer-ui   # RUNS the installer and reads the Spanish captions off the window
npm run verify:installed      # install -> migrate -> seed -> sell -> uninstall -> prove data survived
npm run verify:migrations     # migrations in out/ AND inside the packaged app.asar
```

`verify:installer-ui` opens the wizard, enumerates its Win32 controls, asserts the captions are
Spanish, and closes it **without installing** — so it is safe to run on a machine that already has
MiniMarck. The assertion is on the real window rather than on the .exe because NSIS **compresses**
its data section: the wizard's strings are not present as plaintext in the file, and a grep for
`Siguiente` cannot succeed on a perfectly Spanish installer.

`verify:installed` is the end-to-end proof and it **does** modify the machine: it moves any
existing profile aside into `%LOCALAPPDATA%\Temp\opencode\`, installs, drives a real sale through the
installed app, uninstalls, and checks the database is still intact afterwards. The uninstaller runs
asynchronously, so the script polls until the program directory and the `HKCU` uninstall key are
actually gone rather than assuming the uninstaller had finished when it exited.

## Uninstall keeps the data

A shop's stock, prices and sales history are worth more than the program, so the uninstaller is
configured **not** to touch `%APPDATA%\MiniMarck`. This is verified rather than assumed:

```
the program was removed                        — after 10.6s
it is gone from Programs and Features          — HKCU Uninstall key
the data directory was NOT deleted             — %APPDATA%\MiniMarck\data\minimarck.db
the database is still valid after uninstall    — integrity_check: ok
the sale ledger SURVIVED the uninstall, unchanged
the catalogue survived the uninstall           — 6 products
the drawer movements survived                  — 3 movimiento(s)
```

## Build layout

```
out/main/index.js       Electron main (ESM; resolves paths via import.meta.dirname)
out/preload/index.cjs   sandboxed preload (CommonJS — sandboxed preloads cannot be ESM)
out/renderer/           the app:// bundle
```

**Recorded deviation from design §B.1/§A.1:** the design assumed an unbundled main at
`src/main` and therefore wrote the renderer root as `../../dist/renderer`. electron-vite emits
`out/main`, so the equivalent root is `../renderer`. The shape from main to preload (one `..`)
is unchanged.

**Why the preload is `.cjs`:** SEC-3 requires `sandbox: true`, and Electron only supports
CommonJS sandboxed preloads. Because the package is `"type": "module"`, electron-vite's default
preload output would be `index.mjs` — which would fail to load and leave the renderer with **no
bridge and no error**. `build` does **not** catch this: it emits `index.mjs` and exits 0. What
catches it is `npm run verify:preload`, which reads the build config and the emitted file, and
`npm run probe:launch`, which launches the real window and asserts the bridge at runtime. Both
run inside `verify:s0`, and `tests/security.spec.js` fails if the config stops declaring the
CommonJS output.

## Data location (PLAT-2)

Data lives under the app's own Electron profile, `%APPDATA%\MiniMarck\` (or
`~/Library/Application Support/MiniMarck` on macOS):

```
…\AppData\Roaming\MiniMarck\data\minimarck.db     # the database
…\AppData\Roaming\MiniMarck\backups\              # .db-backup archives
```

`app.setName('MiniMarck')` in `main` is what puts it there. Unpackaged, Electron derives
`userData` from the package name, so the app was resolving to the **shared**
`…\AppData\Roaming\Electron\` profile that every other Electron app on the machine also
uses — two of them would have collided on the same `data\minimarck.db`. The name is set
from a constant rather than from `package.json`, so a rename cannot silently relocate a
user's database.

The `data` and `backups` directories are **created on first run**, so the
"Abrir carpeta de datos" menu item always has something to open and S1's first open is not
an `ENOENT` on a path the app had just reported as valid.

`MINIMARCK_DATA_DIR` relocates only the data base; the Electron profile path is left
untouched. Useful for tests and for a portable install. `Settings > Diagnóstico` shows the
resolved location and whether the override is active.

```bash
MINIMARCK_DATA_DIR=/tmp/mm npx electron out/main/index.js
```

### When a migration you already ran changes: `npm run db:reset`

The migration runner records a SHA-256 checksum per applied file and **refuses to start** when an
applied file no longer matches:

```
IpcError: Migration 1 (001_init.sql) was already applied with a different checksum.
```

That refusal is correct and not a bug to work around. SQLite stores no DDL history, so nothing
else would notice an edited migration — the app would simply run a different schema over an
existing database. Better a startup failure than silent divergence.

But editing `001_init.sql` in place is completely normal while the app is unreleased, and the
checksum guard cannot tell that case from the dangerous one. So `db:reset` exists:

```bash
npm run db:reset          # refuses if the app has shipped
npm run db:reset:force    # deletes anyway, loudly
```

It deletes `%APPDATA%\MiniMarck\data\minimarck.db` **and both SQLite sidecars**
(`-wal`, `-shm`). All three, because a leftover WAL is reattached on the next open — deleting
only the `.db` leaves the stale rows. It prints a line per file, `DELETED` or `absent`, so
"what did it not delete" is as visible as what it did, and it touches nothing else in the
directory.

**The guard is the point.** If `package.json` says `1.0.0` or later, a `v1.0.0`-or-later git tag
exists, or the `private: true` flag has been removed, the script refuses and explains which of
those it found. Deleting a shipped app's database is deleting someone's sales, and a bare
`rm`/`del` one-liner makes that a thing you either remember or you don't. `db:reset:force` exists
so that overriding the guard is always a deliberate, visible act.

Those signals are read from the real `package.json` and real `git tag` output, never hardcoded —
a guard that inverts the day somebody bumps the version is worse than no guard. The
"currently unreleased" case is a test against the actual `package.json`, so it will start failing
on the day the app ships, which is the right moment for a human to look at it.

The logic is in `src/main/db/reset.js` and the CLI shell is `scripts/db-reset.mjs`, so the guard
is unit-tested (`tests/db/reset.spec.js`) rather than only reachable by hand.

## Testing

| Command | Proves |
|---------|--------|
| `npm run spike` | The `node:sqlite` runtime claim, inside Electron |
| `npm test` | 254 tests: contract, registry, preload surface, security, offline gate, and the real `node:sqlite` data layer (connection, transactions, authorizer, migrations, lifecycle, bootstrap, **schema invariants**, **reset guard**) |
| `npm run db:reset` | Deletes the dev database and its WAL sidecars, and **refuses** if the app has shipped |
| `npm run build` | All three targets **build**, and `001_init.sql` is emitted to `out/main/migrations/` — it does not check the preload format or the emitted SQL |
| `npm run verify:preload` | The preload is declared CommonJS **and** emitted as `index.cjs` |
| `npm run verify:migrations` | The emitted migrations are byte-for-byte identical to source, and the bundled main would resolve them. S2 |
| `npm run verify:offline` | No external origin, CDN, raw-content host, socket.io or ScannerSync in **any** of the three build outputs |
| `npm run probe:launch` | The **real** window passes its in-window checks, with the real preload |
| `npm run drive:payment` | The **real** app can actually take money: open a till, `F2`, type the tender, confirm, and read the sale, the stock, the drawer and the change back out of the **real** database file |
| `npm run verify:s0` | All of the above, in order. This is the gate that must be green |

`probe:launch` and `drive:payment` are the two that matter most: they open an actual window and
assert from inside the running application. A preload that fails to load, a sandbox that leaks,
or an opaque origin all turn into a non-zero exit code. `probe:launch` used to sit **outside**
`verify:s0`, which meant the single command a developer was told to run could not catch a broken
bridge — that gap is why it is in the gate now.

`drive:payment` exists because 371 passing tests still shipped an app that opened on a "screen
does not exist" placeholder, and a point of sale with no way back to the sales list. Every test
mounted a component or rendered at `/`; none of them asked what URL the app really launches with,
or whether the till screen could be left. Both bugs are fixed, and both now have a check that
fails if they come back. It runs against a throwaway data directory, so it can never touch a real
shop's database.

### Read the test COUNT, not just the exit code

A file that fails to **collect** is not a red test. It is an absent one, and the rest of the suite
still reports green. S1 shipped exactly that: `wal-durability.spec.js` declared an `await` inside a
non-`async` callback, Rollup threw a parse error, and all four PLAT-6 tests — the repo's most
valuable proof — silently never ran. The suite read `117 passed`.

That mattered because the same tree also had a `Object.freeze`-then-assign in the first statement
of startup, which made the app unable to launch. It shipped for the same reason: `paths.js` and
`bootstrap.js` had zero tests, and the gate that would have caught it (`probe:launch`) was
disabled by the red test that stopped the `&&` chain at step 2. **A safety net that another
failure switches off is not a safety net.** Compare the collected test count against the number of
`it(` blocks you wrote, not against zero.

## What S1 proves

S1 owns the data layer. It ships the *runner*, not the schema, and nothing else.

| Claim | How it is proven | Evidence |
|-------|------------------|----------|
| Committed sales survive the process | `runBeforeQuit` checkpoints and closes; a **second process** handed a `.db` with no sidecars still counts every row | `the .db is self-contained: a bare copy with NO sidecars still has every row` |
| The checkpoint is what saves the data, not luck | A **negative control**: hard-kill a child, copy only the `.db`, and the rows are gone | `CONTROL: after a hard kill, copying only the .db LOSES EVERYTHING` |
| Foreign keys are enforced, not merely set | A violating insert is rejected | `tests/db/connection.spec.js` |
| A write to an undeclared table is refused | Deny-by-default authorizer; business tables are allowlisted per slice | `CREATE TABLE sneaky` throws |
| The `ALTER TABLE` and index paths are actually gated | Arg positions differ per action (`ALTER` puts the table at arg **2**); a naive `arg1` gate passes every one of them | `tests/db/connection.spec.js` |
| An applied migration can never be edited | SHA-256 checksum per file, compared before every run | `MIGRATION_CHECKSUM_MISMATCH` |
| DDL, ledger row and `user_version` cannot diverge | All three move in one `BEGIN IMMEDIATE` | `tests/db/migrate.spec.js` |
| A domain error is never masked by a rollback failure | The domain code wins; a failed ROLLBACK is recorded on it | `SALE-1` |
| `after quitting, copy the file, open it elsewhere` | Migrations run **before** the seed, which is also what allowlists the tables the seed writes | `MIGRATES BEFORE SEEDING` |
| No credential is ever invented | `users.password` is checked **before** the insert, not after | `SEED_PASSWORD_COLUMN_BLOCKS` |

Two of those deserve a note.

**The WAL control was wrong before it was fixed.** It asserted that a hard-killed database copied
without sidecars would read *zero rows*. It does not: `CREATE TABLE` had not been checkpointed
either, so the copy has no `ventas` table at all and the reader fails with `no such table`. The
loss is total, not row-level. The test now asserts what actually happens.

**`users.password` is a live contradiction.** Decision #275 removed auth from the desktop, but
design §D.3 still declares `users.password TEXT NOT NULL`. The first draft reported this *after* a
successful insert — unreachable dead code, because a `NOT NULL` column makes the insert fail
first, surfacing as a raw `NOT NULL constraint failed`. The seeder now detects the blocking shape
before writing and refuses with a named error that says S2 owns the decision. It will not invent
a placeholder hash that would look like a real credential in the user's database.

## What S2 proves

S2 owns the schema. `001_init.sql` creates the 20 tables the Sequelize models declare, and every
money column is an integer number of centavos.

| Claim | How it is proven | Evidence |
|-------|------------------|----------|
| The schema is the models', not a guess | The census was counted from the 20 model files; `schema.spec.js` asserts SQLite reports exactly that set and nothing else | `creates exactly the 20 tables` |
| A half-kilo sale can be recorded | `cantidad_milli` stores 500, stock is in the same unit, and `es_pesable` is generated and unwritable | `fractional quantities: the web cannot store these at all` |
| Two registers cannot open at once | A partial `UNIQUE` index replaces the web's `SELECT ... FOR UPDATE`, which SQLite has no equivalent of | `at most one register may be open per business` |
| A till balance can go negative | The removed `>= 0` bound is asserted absent, and a negative balance is inserted successfully | `bounds the model does not have are not invented` |
| Money cannot drift | Every `DECIMAL`/money column is `INTEGER`, and no business column is `REAL` | `no business column is REAL` |
| Money rounds the way money rounds | `toCents` is string-based; `19.99`, `1.10` and `0.29` are the reproductions. Half away from zero, because `Math.round(-x)` rounds *toward* zero on negatives | `tests/shared/money.spec.js` |
| The database enforces what the app assumes | FKs, ENUM `CHECK`s, rate bounds and partial uniques are asserted by trying to violate them | `schema.spec.js` |
| Debt is derived, never stored | `v_clientes_deudores` computes total and pending from sales and payments; cancelling a paid sale clamps pending at 0 instead of going negative | `schema.spec.js` |
| No credential is invented | `users` has no `password` column at all, so there is no `NOT NULL` shape to work around | `the seeder no longer reports the password column as unresolved` |
| The schema survives packaging | The emitted SQL is byte-identical to source, and the bundled main would resolve it | `npm run verify:migrations` |
| A stale database is never silently overwritten | `db:reset` refuses when the app has shipped, and the decision is unit-tested against real signals | `tests/db/reset.spec.js` |

**These tests were checked by deliberately breaking the code.** A green suite proves nothing on
its own, so each headline claim was mutated to be wrong and required to turn red: reverting
`cantidad_milli` to `cantidad` (3 failures), downgrading the one-open-register index to
non-unique (1), replacing symmetric half-away-from-zero rounding with `Math.round` (1), swapping
digit-wise parsing for `parseFloat(x) * 100` (1), neutering the shipped-app guard (3), and
pointing the WAL target back at the database file (4). Every mutation was reverted and
byte-verified by hash.

**The census was 20, not 22.** Earlier comments in `bootstrap.js` and `seed.js` said 22. They
counted `index.js` and `relations.js` as tables; they are not tables. Those comments are corrected,
and `schema.spec.js` now asserts the count so a wrong number cannot survive in a comment again.

**`users.password` is resolved, not worked around.** Decision #275 removed auth from the desktop
while design §D.3 still declared `users.password TEXT NOT NULL`. S1 refused to invent a hash and
named the contradiction. S2 resolves it in the schema: the column is absent, so there is no
`NOT NULL` constraint to violate and nothing to fake. The seeder's `SEED_PASSWORD_COLUMN_BLOCKS`
guard stays — it still refuses a schema that reintroduces a blocking `NOT NULL` password column.

**The money representation is integers, and that was not a free choice.** `DECIMAL` in SQLite is
`NUMERIC`, which stores reals. `19.99 * 100` is `1998.9999999999998`, so every total would drift
by a centavo. Rates stay `REAL` because they are not money; they are bounded by a `CHECK`.

**Fractional quantities are now storable, which the web app cannot do.** `venta.detalle.js`
declares `cantidad: { type: INTEGER, min: 1 }` while `producto.js` allows `unidadMedida` of
`kg`/`g`/`l`/`ml`. A 0.5 kg line cannot be stored at all, and 1.5 is truncated to 1. The web POS
states the consequence in its own source: *"stock es INT, así que cantidad queda en 1 (una unidad)
y solo se corrige el costo, no el decremento"* — a half-kilo sale decrements stock by a whole
unit. `cantidad_milli` (×1000) fixes the mechanism, and `stock`/`stock_minimo` were rescaled to
`stock_milli`/`stock_minimo_milli` **for the same reason**: the insufficient-stock guard compares
them, so leaving stock in whole units while a line is in thousandths would compare 10 against 500
and refuse every weight sale. `es_pesable` is a generated column, so the "can be weighed" answer
has one definition instead of several.

**Bounds the models do not have were removed, because inventing one refuses real data.** Seven
`CHECK`s asserted minimums no Sequelize model declares. The important one:
`movimientos_caja.saldo_anterior_centavos`/`saldo_nuevo_centavos` had `>= 0`, so a till that spent
more cash than it held — a real state for a shop — could never be recorded, leaving that register
permanently unable to close. The rest were on `asientos_contables`, `detalles_asientos`,
`cuentas_corrientes_deudas` and `pagos_deuda_contabilidad`. Bounds the models *do* declare were
kept (`>= 1` on payments and movements, where `min: 0.01` exists). Header §7 of
`001_init.sql` lists every addition and removal, and §7i states the two things deliberately **not**
done rather than hiding them: `length()` checks on every `STRING(n)`, and rate columns staying
`REAL` against the frozen design's `_pct` integer — a known disagreement flagged for a decision.

**Debt is a view.** The alternative was `deuda_total`/`deuda_pendiente` columns on
`clientes_deudores`, maintained on every sale, cancellation and payment. Three write paths would
have to agree forever, and they would not — a partial failure leaves a stale balance that reads as
real money owed. A view cannot drift, because it has no state to drift from. It is also
unindexable in a way that matters at small scale, which is a real cost to revisit in S3+.

**Two things this slice got wrong first.** `formatCents(..., { decimals: 0 })` multiplied by 100
instead of truncating, and `pagos_deuda_contabilidad.metodo_pago` was tested with an absent parent
row, so it failed on the FK and never reached the assertion it was written for. Both were caught by
asserting behaviour rather than by reading the code.

**One thing it got structurally wrong.** `schema.spec.js` originally ran a real
`bootstrapDatabase()` per test — 32 migrate-and-seed cycles. It passed, and it made the suite
*flaky*: on one run in three, `node-sqlite.smoke` and `lifecycle.spec.js` failed, neither of which
imports anything from that file. That is resource exhaustion, not logic — 32 full migrate + WAL +
checkpoint + close cycles running in parallel on Windows, which has a far lower file-handle ceiling
than the platform this was originally reasoned about. The suite now migrates and seeds **once** into
a template file and copies it per test: same coverage, 6.4s instead of 30.7s, and stable across
eight consecutive runs. A flaky test is worse than a slow one, because it teaches you to re-run
instead of read.

## Reliability finding: a startup failure used to hang instead of reporting

`main()` is async, so a throw anywhere inside it — a migration refusing to run, a database that
will not open, a path that cannot be resolved — became an **unhandled promise rejection**. Electron
had already reached `whenReady`, so its event loop stayed alive with no window and nothing
scheduled to quit. The process simply **hung, silently, forever**.

Found by `npm run probe:launch` during a migration-checksum refusal: 900+ seconds and zero output
where a one-line diagnosis was the correct answer. Two failures at once:

- **The gate proved nothing.** A check that can only hang reports no verdict, so `verify:s0` could
  not distinguish "passed" from "wedged".
- **A real user got an invisible app.** A database that would not open produced a windowless
  process with no dialog, no exit code, and nothing in a log a user would ever read — a task in
  Task Manager that refuses to die.

The fix is `main().catch(onStartupFailure)` in `src/main/index.js`, which logs the stack and
terminates with exit 1. `app.exit` is used rather than `app.quit` **on purpose**: `quit` runs the
`before-quit` handlers, and the lifecycle WAL checkpoint assumes a cleanly opened database — running
it against a half-initialised one could obscure the real failure. Before `app.isReady()`,
`app.exit` is unreliable, so that path falls back to `process.exit`.

Measured on the same failing startup: **900+ s and no exit → 1 s and exit 1** with the exact
`IpcError` and stack. A gate that cannot report failure has to be fixed before its verdict is worth
reading.

## Deliberately out of scope

No packaging (`electron-builder`, `verify:packaged`) — S18. No backup engine — S15. No repositories
on top of `ctx.js` — S3+. No business operations: every contract op outside
`db.info`/`db.schemaVersion` resolves to a structured `NOT_IMPLEMENTED` (501) rather than a silent
no-op. `db.reconcile` is deliberately left *unregistered* for the same reason — with a real
database open, a synthetic "nothing to reconcile" would be worse than useless.

The renderer is still the S0 probe page, not the POS. The React frontend is not mounted here.

**S2's own migrations are packaged, but the app is not.** `emitMigrations()` in
`electron.vite.config.js` puts `001_init.sql` at `out/main/migrations/`, where
`defaultMigrationsDir()` looks, and `verify:migrations` asserts it. That closed the gap S1 flagged
as unowned. `electron-builder` itself, and a packaged-app launch probe, are still S18 — so
"packaged" here means "the build output is correct", not "an installed app has been launched".

**Why `verify:migrations` exists at all.** The failure mode of getting packaging wrong is not a
crash. The app launches, the window renders, and the database sits at `user_version = 0` with no
tables; every screen then fails later with a confusing `no such table`. Nothing about the failure
points at packaging. Its first draft also had a check that imported the *source* `paths.js`, which
resolves into `src/` and would have passed even if the build emitted nothing — so it now asserts
the geometry the bundler actually produces. A verifier that cannot fail is worse than none.
