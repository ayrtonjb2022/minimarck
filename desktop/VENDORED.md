# Vendored assets and provenance

MiniMarck Desktop is **offline by design**. This file records where third-party code comes from
and what rule governs it, so an audit never has to reverse-engineer `node_modules`.

## Rule

Nothing may be fetched at runtime. Any third-party asset that must ship in the renderer is
**vendored into this repository** — copied in, version-pinned, and committed — never loaded from
a CDN. The `verify:offline` gate fails the build if a remote origin reappears anywhere in the
built output.

## What the gate rejects

| Rule | Example that fails the build |
|------|-----------------------------|
| `banned-cdn` | `fonts.googleapis.com`, `cdnjs.cloudflare.com`, `cdn.jsdelivr.net`, `unpkg.com` |
| `tag-external-origin` | `<link href="https://cdn...">` or `<script src="http...">` |
| `external-origin` | any `http(s)://` in built output to a host that is not allowlisted |
| `css-url-offsite` | `url(https://...)` in a stylesheet |
| `socket-io-present` | any `socket.io-client` / `socket.io` import (OFFL-5) |
| `scanner-sync-present` | any `ScannerSync` reference (VIS-3) |
| `socket-io-dependency` | `socket.io-client` in `dependencies`/`devDependencies` |

Allowlisted hosts (namespaces, licence text, local dev only): `www.w3.org`, `purl.org`,
`spdx.org`, `opensource.org`, `github.com`, `creativecommons.org`, `localhost`, `127.0.0.1`.

Run it: `npm run verify:offline`.

## Current vendored set

| Asset | Version | Source | Licence | Why |
|-------|---------|--------|---------|-----|
| `electron` | `44.4.5` | npm | MIT | The runtime shell |
| `electron-vite` | `^4.0.1` | npm | MIT | Build tooling |
| `vite` | `^7.1.14` | npm | MIT | Build tooling |
| `vitest` | `^3.2.4` | npm | MIT | Test runner |

**No vendored font or icon assets at S0.** The S0 renderer is a plain HTML/JS probe with no icon
font and no webfont, which is why the offline gate passes on an empty dependency surface. The
icon set is a **later** decision and must be vendored when it lands — a CDN icon font is exactly
the regression this gate exists to catch, because it would fail *silently*.

## Why offline is enforced rather than documented

A remote asset that fails at runtime is the worst class of bug in a POS: the app still starts,
still looks mostly fine, and quietly loses functionality on a machine with no connectivity. A
build-time gate turns that silent failure into a build failure, and the CSP turns any future
regression into a loud console error instead of a mystery.
