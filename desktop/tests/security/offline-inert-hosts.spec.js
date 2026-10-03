/**
 * Adversarial tests for the inert-bundle exemption in `scripts/verify-offline.mjs`.
 *
 * An exemption is the only part of a security gate that can silently become a hole, so every case
 * below is written as an attack that MUST be caught, or as the inert vendor text that MUST be
 * tolerated. If someone later widens this to a flat host allowlist, the "must fail" half of this
 * file fails with it — which is the point of having it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { auditRenderer } from '../../scripts/verify-offline.mjs'

let root

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'minimarck-offline-'))
  mkdirSync(path.join(root, 'assets'), { recursive: true })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Scan one line of renderer source and return only the findings it produced. */
function scan(js) {
  writeFileSync(path.join(root, 'assets', 'index-case.js'), js, 'utf8')
  return auditRenderer(root).findings.filter((f) => f.file.startsWith('assets'))
}

describe('verify:offline — inert bundle hosts', () => {
  it.each([
    ['a fetch() to an inert host', 'fetch("https://reactjs.org/malicious.js");'],
    ['a CSS url() to an inert host', 'a{background:url("https://tailwindcss.com/x.png")}'],
    ['an @import of an inert host', '@import "https://reactjs.org/docs/x.css";'],
    ['a tag src to an inert host', '<script src="https://reactjs.org/evil.js"></script>'],
    ['an XHR to an inert host', 'var x=new XMLHttpRequest();x.open("GET","https://reactjs.org/z")'],
    ['a socket to an inert host', 'new WebSocket("wss://reactjs.org/socket")'],
    ['an origin split by string concatenation', 'fetch("https://react"+"js.org/w")'],
    [
      // THE REGRESSION THIS FILE EXISTS FOR. A `//` inside a string literal is not a comment, so
      // this line contains a real `fetch`. An earlier version of the exemption read the first
      // `//` as the start of a comment, exempted the whole tail of the line, and passed this.
      'a protocol-ish string BEFORE a real fetch',
      'var a="//x";fetch("https://reactjs.org/y")'
    ]
  ])('still reports %s', (_label, src) => {
    expect(scan(src).length).toBeGreaterThan(0)
  })

  it.each([
    ['a line comment', '// see https://issues.chromium.org/issues/41491098 for details'],
    ['a licence banner', '/*! tailwindcss v4 | MIT License | https://tailwindcss.com */'],
    [
      'a string constant that merely names an origin',
      'var msg="Minified React error; visit https://reactjs.org/docs/error-decoder.html?invariant=1"'
    ]
  ])('tolerates %s', (_label, src) => {
    expect(scan(src)).toEqual([])
  })
})
