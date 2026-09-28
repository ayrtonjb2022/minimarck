/**
 * S0 renderer probe — runs inside the real `app://bundle` origin and proves, from the
 * renderer side, the claims S0 owns:
 *   - OFFL-3: `app://` is a real, secure origin — localStorage works, origin is not "null".
 *   - SEC-1: `Object.keys(window.minimarck)` is exactly the four members.
 *   - SEC-2: no `require`, no `process`, no `fs`; the raw ipcRenderer handle is not exposed.
 *   - SEC-4: an unknown group/op comes back as a structured error, not a leak.
 *   - OFFL-1: the offline audit — fetch is instrumented and must observe ZERO outbound calls.
 *
 * This file is INSTRUMENTATION, not a mock: it runs in the real window, so what it reports
 * is what the operator would see. Later slices reuse the same audit hook to prove the
 * vendored renderer makes no network calls.
 */

// --- OFFL-1 audit: count every outbound request attempt -------------------------
const networkAttempts = []
const realFetch = window.fetch
window.fetch = function auditedFetch(...args) {
  networkAttempts.push(String(args[0]))
  return realFetch.apply(this, args)
}

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

  // OFFL-1: the audit must be clean after everything above.
  record(networkAttempts.length === 0, 'OFFL-1 zero outbound fetch attempts observed',
    `${networkAttempts.length} attempt(s): ${networkAttempts.join(', ') || 'none'}`)

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
