# Vendored assets and provenance

MiniMarck Desktop is **offline by design**. This file records where third-party code comes from
and what rule governs it, so an audit never has to reverse-engineer `node_modules`.

## Rule

Nothing may be fetched at runtime. Any third-party asset that must ship in the renderer is
**vendored into this repository** — copied in, version-pinned, and committed — never loaded from
a CDN. The `verify:offline` gate fails the build if a remote origin reappears in **any of the
three build outputs** (`out/renderer`, `out/main`, `out/preload`).

## What the gate rejects

| Rule | Example that fails the build |
|------|-----------------------------|
| `banned-cdn` | `fonts.googleapis.com`, `cdnjs.cloudflare.com`, `cdn.jsdelivr.net`, `unpkg.com` |
| `tag-external-origin` | `<link href="https://cdn...">` or `<script src="http...">` |
| `tag-protocol-relative` | `<script src="//cdn.example.com/x.js">` — no scheme, so it still leaves the machine |
| `transport-protocol-relative` | `fetch("//telemetry.example.com/v1")` |
| `external-origin` | any `http(s)://` to a host that is not allowlisted, **in any case** |
| `socket-origin` | any `ws://` / `wss://` URL — a websocket to a relay is a network call |
| `raw-content-host` | `github.com`, `raw.githubusercontent.com`, `gist.*` — raw-content endpoints, on any path |
| `css-url-offsite` | `url(https://...)` in a stylesheet |
| `socket-io-present` | any `socket.io-client` / `socket.io` import (OFFL-5) |
| `scanner-sync-present` | any `ScannerSync` reference (VIS-3) |
| `socket-io-dependency` | `socket.io-client` in a **blocking** manifest (OFFL-5) |
| `missing-build` | a build output that does not exist — a gate that scans nothing passes vacuously |

Allowlisted hosts (inert identifier namespaces and local dev only — none serves executable
content): `www.w3.org`, `purl.org`, `spdx.org`, `opensource.org`, `creativecommons.org`,
`localhost`, `127.0.0.1`. Matching is on `URL.hostname`, so `http://localhost:5173` and
`http://localhost:5173/` both match `localhost`.

`github.com` is **not** allowlisted, and the reason is the one that matters: `github.com` was
allowlisted while `raw.githubusercontent.com` was not, so `import("https://github.com/u/r/raw/main/x.js")`
passed the gate with zero findings. Both are raw-content endpoints. Licence and NOTICE text belongs
in this file, not in the bundle.

## What the gate is NOT

`verify:offline` is a **text scan over the built output**. It cannot see a URL assembled at
runtime (`fetch('//' + host + p)`), a base64 blob decoded into a `<script>`, or a payload fetched
and `eval`'d from a `data:` URL. No regex over static text can. What it does is make the
*accidental* case impossible — a copy-pasted `<script src>`, a stray `import`, a leftover
socket.io reference, a retyped uppercase scheme.

The backstop for everything else is the **CSP** (`script-src 'self'`, `connect-src 'self'`,
`object-src 'none'`, `frame-src 'none'`, `form-action 'none'`) together with `sandbox: true` in
the renderer, which blocks those requests at runtime whether or not this gate ever saw them.
Neither control alone is sufficient: the gate stops the accident, the CSP stops the adversary.

## The dependency surface is reported, not assumed

`desktop/package.json` declares **zero** runtime dependencies. On its own that is evidence of
nothing — the earlier version of this gate audited only that file and treated its silence as
proof of OFFL-5.

The gate therefore also reports `frontend/package.json`, the tree the renderer will eventually
be vendored from, on **every run**. It currently declares `socket.io-client@^4.8.3` and is
reported, not blocking, because `desktop/vendor/` does not exist yet, so no frontend dependency
can reach the packaged app. The moment anything is vendored, `frontend/package.json` joins the
blocking manifest set and the gate fails until that relay dependency is gone. `tests/offline-gate.spec.js`
asserts the rule fires against the **real** `frontend/package.json`, not only against a synthetic
fixture.

Run it: `npm run verify:offline`.

## Current vendored set

| Asset | Version | Source | Licence | Why |
|-------|---------|--------|---------|-----|
| `electron` | `44.4.5` | npm | MIT | The runtime shell |
| `electron-vite` | `^4.0.1` | npm | MIT | Build tooling |
| `vite` | `^7.1.14` | npm | MIT | Build tooling |
| `vitest` | `^3.2.4` | npm | MIT | Test runner |
| `react` / `react-dom` | `^18.3.1` | npm | MIT | The real POS is React; it is mounted, not re-implemented |
| `react-router-dom` | `^6.30.6` | npm | MIT | `/pos` and `/ventas` under the `app://` scheme |
| `react-toastify` | `^10.0.6` | npm | MIT | Vendored POS toasts |
| `@tanstack/react-query` | `^5.104.0` | npm | MIT | The vendored screens already depend on it |
| `framer-motion` | `^11.18.2` | npm | MIT | Vendored POS animations |
| `tailwindcss` + `@tailwindcss/vite` | `^4.3.3` | npm | MIT | Utility classes, compiled into the bundle at build time |
| `@vitejs/plugin-react` | `^4.7.0` | npm | MIT | JSX transform in dev and build |
| `jsdom` | `^26.1.0` | npm | MIT | **dev only** - the DOM the React POS tests run in |
| `@testing-library/react` | `^16.3.3` | npm | MIT | **dev only** - drives the real component, the way a person would |
| `@testing-library/user-event` | `^14.6.7` | npm | MIT | **dev only** - typing barcodes and pressing Enter |
| `@testing-library/dom` | `^10.4.2` | npm | MIT | **dev only** - peer of the two above |

All of these are `dependencies` or `devDependencies` of `desktop/package.json` and are locked in
`package-lock.json`; none of them is fetched at runtime. The last four exist only so the sale
flow can be driven through the real UI in a test - they are never in the packaged output.

**Icons are local CSS masks, not a font and not a CDN.** `styles/icons.css` draws the POS icon set
from inline SVG data URIs in the stylesheet, so there is nothing to download and nothing to fail
offline. A CDN icon font is exactly the regression this gate exists to catch, because it would
fail *silently*.

**No webfonts.** The UI uses the system UI stack. A `fonts.googleapis.com` reference would be
rejected by the gate as a banned CDN host, and would be a silent failure in a shop with no
connectivity.

## What the gate now finds in a minified vendor bundle, and how it stays strict

Vendoring `react-dom` and `tailwindcss` means the built bundle is no longer only our own source,
and it carries three absolute URLs that are text rather than requests: the Tailwind MIT banner
(`https://tailwindcss.com`), a React `error-decoder` message the runtime throws
(`https://reactjs.org/...`), and a `// TODO` copied from React DOM source
(`https://issues.chromium.org/...`).

They are allowed **only** at occurrences where `isFetchableUse()` finds no `url()`, `@import`,
tag `src`/`href` or transport call within reach — the same line, inspected, not a blanket host
allowlist. This was verified rather than assumed: a real `fetch("https://reactjs.org/malicious.js")`
injected into the built bundle still fails the gate as `external-origin`. Adding those hosts to
the flat allowlist set instead would have been one line, and would have silently permitted
exactly the bug the gate exists to find.

## Why offline is enforced rather than documented

A remote asset that fails at runtime is the worst class of bug in a POS: the app still starts,
still looks mostly fine, and quietly loses functionality on a machine with no connectivity. A
build-time gate turns that silent failure into a build failure, and the CSP turns any future
regression into a loud console error instead of a mystery.
