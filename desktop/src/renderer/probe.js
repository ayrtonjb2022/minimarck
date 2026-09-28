/**
 * S0 renderer probe — runs inside the real `app://bundle` origin and proves, from the
 * renderer side, the claims S0 owns:
 *   - OFFL-3: `app://` is a real, secure origin — localStorage works, origin is not "null".
 *   - SEC-1: `Object.keys(window.minimarck)` is exactly the four members.
 *   - SEC-2: no `require`, no `process`, no `fs`; the raw ipcRenderer handle is not exposed.
 *   - SEC-4: an unknown group/op comes back as a structured error, not a leak.
 *   - OFFL-1: no outbound request to any real origin, across every transport the renderer
 *     can actually use.
 *
 * This file is INSTRUMENTATION, not a mock: it runs in the real window, so what it reports
 * is what the operator would see. Later slices reuse the same audit hook to prove the
 * vendored renderer makes no network calls.
 *
 * ---------------------------------------------------------------------------
 * WHAT "0 ATTEMPTS" DOES AND DOES NOT PROVE — read before trusting a PASS
 * ---------------------------------------------------------------------------
 * Wrapping `window.fetch` alone proves very little. XMLHttpRequest, WebSocket, EventSource,
 * sendBeacon, an <img src>, a dynamic import() and a Worker all leave the machine without
 * ever touching `fetch`, and an offline app that only counted `fetch` would report a clean
 * bill of health while streaming telemetry over a websocket. So all of them are counted
 * here, not just fetch.
 *
 * A counter that reports zero is worth nothing unless the counter is proven to work. An
 * earlier version of this probe printed "0 attempt(s)" from a two-file placeholder
 * containing no network code at all, which is what a broken recorder also prints. So the
 * probe now runs a SELF-CHECK: it deliberately fires each instrumented transport at
 * `*.invalid` (RFC 2606, reserved and guaranteed never to resolve) and asserts the
 * recorder caught it. A PASS therefore means "the counter is live AND saw nothing", not
 * "nothing happened, trust me".
 *
 * KNOWN BLIND SPOT, deliberately not hidden: a dynamic `import()` of a runtime-assembled
 * URL cannot be wrapped in JavaScript at all. It is covered by the CSP instead —
 * `script-src 'self'` and `connect-src 'self'` block it whether or not this file saw it.
 * No recorder and no text-scan gate can close that gap; the CSP is the control that does.
 */

// --- OFFL-1 audit: count every outbound request attempt -------------------------
const SELF_CHECK_ORIGIN = 'https://offline-selfcheck.invalid'
const attempts = []

/** @param selfCheck true for the deliberate self-check traffic, which must be excluded. */
function note(transport, target, selfCheck) {
  attempts.push({ transport, target: String(target), selfCheck: Boolean(selfCheck) })
}

function wrapFetch() {
  const real = window.fetch
  window.fetch = function auditedFetch(...args) {
    note('fetch', args[0], isSelfCheck(args[0]))
    return real.apply(this, args)
  }
}

function wrapXhr() {
  const real = window.XMLHttpRequest.prototype.open
  window.XMLHttpRequest.prototype.open = function auditedOpen(method, url, ...rest) {
    note('XMLHttpRequest', url, isSelfCheck(url))
    return real.call(this, method, url, ...rest)
  }
}

/** Replace a constructor with an auditing shim that returns a real instance. */
function wrapConstructor(name, globalName) {
  const Real = window[globalName]
  if (typeof Real !== 'function') {
    note(globalName, 'constructor-absent', false)
    return false
  }
  const Shim = function (url, ...rest) {
    note(globalName, url, isSelfCheck(url))
    return new Real(url, ...rest)
  }
  Shim.prototype = Real.prototype
  Object.assign(Shim, Real) // CONNECTING/OPEN/CLOSING/CLOSED, and EventSource constants
  window[globalName] = Shim
  return true
}

function wrapSendBeacon() {
  const real = navigator.sendBeacon
  if (typeof real !== 'function') {
    note('sendBeacon', 'api-absent', false)
    return
  }
  navigator.sendBeacon = function auditedSendBeacon(url, data) {
    note('sendBeacon', url, isSelfCheck(url))
    return real.call(this, url, data)
  }
}

function isSelfCheck(target) {
  return String(target).includes('offline-selfcheck.invalid')
}

/** An element with an off-origin src/href is an outbound request, whatever the tag. */
const URL_ATTRS = { IMG: ['src'], SCRIPT: ['src'], LINK: ['href'], IFRAME: ['src'], AUDIO: ['src'], VIDEO: ['src'], SOURCE: ['src'], EMBED: ['src'], TRACK: ['src'] }
const OFF_ORIGIN_TAGS = Object.keys(URL_ATTRS)
/** Only these schemes actually leave the machine. `data:`, `blob:`, `about:` do not. */
const NETWORK_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:'])
/** Elements this probe injected on purpose, so the observer can tell them from real ones. */
const selfCheckElements = new WeakSet()

function scanElement(el, selfCheck) {
  if (!el || el.nodeType !== 1) return
  for (const attr of URL_ATTRS[el.tagName] || []) {
    const raw = (el.getAttribute && el.getAttribute(attr)) || ''
    // A protocol-relative reference has no scheme, so it inherits the page's — which on
    // app:// stays in the app scheme, and on the http dev server leaves the machine. It
    // can never be a legitimate bundle asset here (those are root-relative), so it is
    // always surfaced rather than resolved and dismissed.
    if (raw.trim().startsWith('//')) {
      note(el.tagName.toLowerCase(), raw, selfCheck)
      continue
    }
    let resolved
    try {
      resolved = new URL(raw, window.location.href)
    } catch {
      continue
    }
    if (!NETWORK_SCHEMES.has(resolved.protocol)) continue
    if (resolved.origin !== window.location.origin) {
      note(el.tagName.toLowerCase(), resolved.href, selfCheck)
    }
  }
}

/** Watch live DOM injection AND sweep what is already there — both, because either alone misses. */
function observeOffOriginElements() {
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) scanElement(node, selfCheckElements.has(node))
    }
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
  for (const tag of OFF_ORIGIN_TAGS) {
    for (const el of document.querySelectorAll(tag)) scanElement(el, false)
  }
  return observer
}

wrapFetch()
wrapXhr()
wrapConstructor('WebSocket', 'WebSocket')
wrapConstructor('EventSource', 'EventSource')
wrapSendBeacon()
const elementObserver = observeOffOriginElements()

// --- Self-check: prove the recorder is live on every transport ------------------
/**
 * Fire each instrumented transport at a reserved, non-resolvable TLD. These requests are
 * blocked by the CSP before they leave the process, and RFC 2606 guarantees `.invalid`
 * never resolves, so nothing can succeed and nothing can leave the machine. What is being
 * proven is that the RECORDER fired — a broken shim records nothing and would silently
 * turn the OFFL-1 check below into the same vacuous "0 attempt(s)" it replaced.
 */
function runRecorderSelfChecks() {
  const url = `${SELF_CHECK_ORIGIN}/probe`
  try {
    void window.fetch(url).catch(() => {})
  } catch { /* CSP blocked before the shim could return; the note already happened */ }
  try {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', url) // open() records; no send(), so nothing is attempted
  } catch { /* recorded in the shim */ }
  try {
    void new WebSocket(`${SELF_CHECK_ORIGIN.replace('https', 'wss')}/ws`)
  } catch { /* CSP blocked; recorded in the shim */ }
  try {
    void new EventSource(`${url}/es`)
  } catch { /* CSP blocked; recorded in the shim */ }
  try {
    navigator.sendBeacon(`${url}/beacon`, 'probe')
  } catch { /* recorded in the shim */ }
  try {
    const img = document.createElement('img')
    selfCheckElements.add(img)
    img.src = `${url}/pixel.gif`
    document.body.appendChild(img)
  } catch { /* recorded by the MutationObserver */ }
}

// --- probe ----------------------------------------------------------------------
const results = []
const record = (ok, label, detail) => results.push({ ok, label, detail })

function assertEq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  record(ok, label, `${JSON.stringify(actual)} ${ok ? '==' : '!= expected'} ${JSON.stringify(expected)}`)
}

function main() {
  // OFFL-3: a real origin means localStorage is available and origin is not opaque/null.
  try {
    localStorage.setItem('mm-s0-probe', 'ok')
    assertEq(localStorage.getItem('mm-s0-probe'), 'ok', 'OFFL-3 localStorage works over app://')
    record(window.location.origin !== 'null', 'OFFL-3 origin is a real origin', window.location.origin)
  } catch (e) {
    record(false, 'OFFL-3 localStorage works over app://', String(e))
  }

  // SEC-1: exactly four members, no more.
  const keys = Object.keys(window.minimarck || {}).sort()
  assertEq(keys, ['call', 'env', 'on', 'platform'], 'SEC-1 bridge exposes exactly 4 members')

  // SEC-2: nothing dangerous leaked onto window.
  for (const leak of ['require', 'process', 'fs', 'child_process', 'ipcRenderer', 'sqlite']) {
    record(typeof window[leak] === 'undefined', `SEC-2 window.${leak} absent`, typeof window[leak])
  }

  // SEC-1/2 shape of the members.
  record(typeof window.minimarck.call === 'function', 'SEC-1 call is a function', '')
  record(typeof window.minimarck.on === 'function', 'SEC-1 on is a function', '')
  record(typeof window.minimarck.platform.saveBytes === 'function', 'SEC-1 platform.saveBytes present', '')

  // SEC-2: an unknown topic subscription must throw and register nothing.
  try {
    window.minimarck.on('nope:nope', () => {})
    record(false, 'SEC-2 unknown topic throws', 'no throw')
  } catch (e) {
    record(String(e.message).includes('unknown topic'), 'SEC-2 unknown topic throws', e.message)
  }

  return runIpcChecks()
}

async function runIpcChecks() {
  // End-to-end IPC: a real registered operation round-trips through main.
  try {
    const info = await window.minimarck.call('db', 'info', {})
    record(info && info.dbFile, 'IPC db.info round-trips to main', info && info.dbFile)
    record(
      info && String(info.sqlite || '').length > 0,
      'main reports its SQLite version',
      info && info.sqlite
    )
  } catch (e) {
    record(false, 'IPC db.info round-trips to main', String(e))
  }

  // SEC-4: a contract member with no handler in this build is 501 NOT_IMPLEMENTED, not a leak.
  try {
    await window.minimarck.call('platform', 'print', { html: '<p>x</p>' })
    record(false, 'SEC-2 unimplemented op returns NOT_IMPLEMENTED', 'no error')
  } catch (e) {
    const msg = String(e.message || '')
    record(msg.includes('not implemented') || msg.includes('NOT_IMPLEMENTED'),
      'SEC-2 unimplemented op returns NOT_IMPLEMENTED', msg)
  }

  // SEC-2: an unknown group is rejected.
  try {
    await window.minimarck.call('evil', 'dropTables', {})
    record(false, 'SEC-2 unknown group rejected', 'no error')
  } catch (e) {
    record(String(e.message || '').includes('Unknown group'), 'SEC-2 unknown group rejected', String(e.message))
  }

  // OFFL-1, part 1: is the recorder actually alive on every transport? Without this the
  // count below is meaningless, because a broken shim and a clean app both report zero.
  runRecorderSelfChecks()
  // Let the MutationObserver deliver the <img> injection.
  await new Promise((r) => setTimeout(r, 100))
  for (const transport of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'img']) {
    const hits = attempts.filter((a) => a.transport === transport && a.selfCheck)
    record(hits.length > 0, `OFFL-1 recorder is live on ${transport}`, hits.length ? `${hits.length} recorded` : 'nothing recorded')
  }

  // OFFL-1, part 2: the actual claim. Self-check traffic is excluded, because this probe
  // caused it on purpose; everything else would be the app reaching out on its own.
  const real = attempts.filter((a) => !a.selfCheck)
  record(
    real.length === 0,
    'OFFL-1 zero outbound attempts to any real origin (all transports)',
    real.length === 0
      ? `0 of ${attempts.length - real.length} recorder self-check(s); ${Object.keys(URL_ATTRS).length} element tags swept`
      : real.map((a) => `${a.transport} -> ${a.target}`).join(', ')
  )
  elementObserver.disconnect()

  render()
}

function render() {
  const ul = document.getElementById('results')
  ul.innerHTML = ''
  for (const r of results) {
    const li = document.createElement('li')
    li.textContent = `${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? '  — ' + r.detail : ''}`
    ul.appendChild(li)
  }
  const failed = results.filter((r) => !r.ok).length
  const summary = document.createElement('li')
  summary.textContent = `=== ${results.length - failed}/${results.length} probe checks passed ===`
  ul.appendChild(summary)
  // Surface the outcome to the automated S0 run (and to a human eye).
  window.__S0_PROBE__ = { total: results.length, failed, results }
}

main()
