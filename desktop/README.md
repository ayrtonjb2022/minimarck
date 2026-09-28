# MiniMarck Desktop — S0 runtime foundation

The offline Electron + SQLite shell for MiniMarck, at the **S0** slice: a real window, a real
`app://` origin, a real `node:sqlite`, and the trust boundary that every later slice builds on.
No business logic yet — S0 exists to prove the runtime and the security model, so S1+ can be
written without re-litigating them.

## Quick path

```bash
npm install
npm run verify:s0        # spike + tests + build + offline gate
MINIMARCK_S0_PROBE=1 npm run probe:launch   # launches the real window, prints 18 checks
```

Expected: `verify:s0` green, and `probe:launch` printing
`=== 18/18 launch probe checks passed ===` with exit code 0.

## What S0 proves

| Claim | How it is proven | Evidence |
|-------|------------------|----------|
| Electron 44.4.5 ships working `node:sqlite` | `npm run spike` — real DB file, table, insert, read, WAL, second handle, `backup()` | `9/9 passed` |
| No native module, no rebuild, no ABI lock | The spike asserts the stack is `node:sqlite` only | `ABORT CRITERION CLEARED` |
| The app makes **zero** network calls | `verify:offline` fails the build on any external origin; the renderer probe counts outbound fetches | `0 attempt(s)` |
| The renderer gets a narrow bridge, not `ipcRenderer` | Preload exposes exactly `call`, `on`, `platform`, `env` and nothing else | `SEC-1 bridge exposes exactly 4 members` |
| The renderer cannot reach SQL or the filesystem | `sandbox:true` + an 88-op allowlist registry; unknown group/op is rejected in main | `Unknown group: evil` |
| The origin is real, so storage and routing work | `app://bundle` is privileged + standard, so `localStorage` and `BrowserRouter` behave | `origin is a real origin — app://bundle` |

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
bridge and no error**. `tests/security.spec.js` and `npm run probe:launch` both guard this.

## Data location (PLAT-2)

Data lives under Electron's `userData` by default. `MINIMARCK_DATA_DIR` relocates only the data
base; the Electron profile path is left untouched. Useful for tests and for a portable install.

```bash
MINIMARCK_DATA_DIR=/tmp/mm npx electron out/main/index.js
```

## Testing

| Command | Proves |
|---------|--------|
| `npm run spike` | The `node:sqlite` runtime claim, inside Electron |
| `npm test` | 46 pure/unit tests: contract, registry, preload surface, security, offline gate |
| `npm run build` | All three targets build (also the preload-format gate) |
| `npm run verify:offline` | The built renderer has no external origin, CDN, socket.io or ScannerSync |
| `MINIMARCK_S0_PROBE=1 npm run probe:launch` | The **real** window passes 18 in-window checks |

`probe:launch` is the one that matters most: it opens an actual window and asserts from inside
the renderer. A preload that fails to load, a sandbox that leaks, or an opaque origin all turn
into a non-zero exit code.

## Deliberately out of scope for S0

No packaging (`electron-builder`, `verify:packaged`) — that is S18. No backup engine — S15.
No database open/migrate — S1. No business operations: every contract op outside the read-only
`db.*` set resolves to a structured `NOT_IMPLEMENTED` (501) rather than a silent no-op, so the
renderer never mistakes "not built yet" for "succeeded".
