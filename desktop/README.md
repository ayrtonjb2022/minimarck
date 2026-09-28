# MiniMarck Desktop — S0 runtime foundation

The offline Electron + SQLite shell for MiniMarck, at the **S0** slice: a real window, a real
`app://` origin, a real `node:sqlite`, and the trust boundary that every later slice builds on.
No business logic yet — S0 exists to prove the runtime and the security model, so S1+ can be
written without re-litigating them.

## Quick path

```bash
npm install
npm run verify:s0        # spike + tests + build + preload-format gate + offline gate + launch probe
npm run probe:launch     # just the launch probe (also runs inside verify:s0)
```

Expected: `verify:s0` green. The Node version is pinned in `package.json` `engines`
(`>=24.18.0 <25`) because the app ships Electron 44.4.5's Node **24.21.0** and the S0 spike
exists precisely to pin that runtime rather than drift with whatever the machine has.

## What S0 proves

| Claim | How it is proven | Evidence |
|-------|------------------|----------|
| Electron 44.4.5 ships working `node:sqlite` | `npm run spike` — real DB file, table, insert, read, WAL, second handle, `backup()` | `9/9 passed` |
| No native module, no rebuild, no ABI lock | The spike asserts the stack is `node:sqlite` only | `ABORT CRITERION CLEARED` |
| The app makes **zero** network calls | `verify:offline` fails the build on any external origin in any build output; the renderer probe instruments fetch, XHR, WebSocket, EventSource, sendBeacon and off-origin elements | `0 outbound attempts to any real origin`, with the recorder proven live on all 6 |
| The renderer gets a narrow bridge, not `ipcRenderer` | Preload exposes exactly `call`, `on`, `platform`, `env` and nothing else | `SEC-1 bridge exposes exactly 4 members` |
| The renderer cannot reach SQL or the filesystem | `sandbox:true` + an 88-op allowlist registry; unknown group/op is rejected in main | `Unknown group: evil` |
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

**Remaining blind spot, stated rather than hidden:** a dynamic `import()` of a
runtime-assembled URL cannot be wrapped in JavaScript at all. The CSP covers it
(`script-src 'self'`, `connect-src 'self'`). `verify:offline` is likewise a *text scan* and
cannot see string concatenation or base64; it makes the accidental case impossible, and the CSP
plus `sandbox:true` is what blocks the deliberate one. See `VENDORED.md`.

## Runtime facts (measured, not assumed)

| Fact | Value |
|------|-------|
| Electron | `44.4.5` |
| Node inside Electron | `24.21.0` |
| Chromium | `152.0.7977.130` |
| SQLite | `3.53.4` |

`node:sqlite` is used **directly** — no `better-sqlite3`, no `node-gyp`, no prebuilt binary, so
there is no native ABI to break on an Electron upgrade.

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

## Testing

| Command | Proves |
|---------|--------|
| `npm run spike` | The `node:sqlite` runtime claim, inside Electron |
| `npm test` | 69 pure/unit tests: contract, registry, preload surface, security, offline gate |
| `npm run build` | All three targets **build** — it does not check the preload format |
| `npm run verify:preload` | The preload is declared CommonJS **and** emitted as `index.cjs` |
| `npm run verify:offline` | No external origin, CDN, raw-content host, socket.io or ScannerSync in **any** of the three build outputs |
| `npm run probe:launch` | The **real** window passes its in-window checks, with the real preload |
| `npm run verify:s0` | All of the above, in order. This is the gate that must be green |

`probe:launch` is the one that matters most: it opens an actual window and asserts from inside
the renderer. A preload that fails to load, a sandbox that leaks, or an opaque origin all turn
into a non-zero exit code. It used to sit **outside** `verify:s0`, which meant the single command
a developer was told to run could not catch a broken bridge — that gap is why it is in the gate
now.

## Deliberately out of scope for S0

No packaging (`electron-builder`, `verify:packaged`) — that is S18. No backup engine — S15.
No database open/migrate — S1. No business operations: every contract op outside the read-only
`db.*` set resolves to a structured `NOT_IMPLEMENTED` (501) rather than a silent no-op, so the
renderer never mistakes "not built yet" for "succeeded".
