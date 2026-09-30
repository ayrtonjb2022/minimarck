/**
 * Adversarial tests for `scripts/assert-installed-payload.mjs`.
 *
 * WHY A PAYLOAD CHECK NEEDS ATTACKS. This script's whole job is to say "the file the shop receives
 * contains the migration, compiles nothing, and fetches nothing". Three of those claims are the
 * kind that pass forever while meaning nothing: a scanner that never matches, an `entries` list
 * read from the wrong directory, an archive that silently degrades to "no findings, scanned 0".
 * A verifier that cannot fail is worse than no verifier, because it converts a real risk into a
 * false green — the failure mode `assert-migrations-packaged.mjs` documents for a version of itself
 * whose async check registered PASS on every run because a rejected promise never reached the catch.
 *
 * So every case below changes exactly ONE variable in an otherwise valid archive and asserts the
 * check catches it. The archive is SYNTHETIC rather than the real installed one, on purpose: the
 * test has to run on a machine where nothing is installed, which is the machine CI runs on. It
 * carries a byte-identical copy of the real migration so that the ONLY thing wrong with a poisoned
 * archive is the poison — otherwise every case would pass for the wrong reason, which is the same
 * false green in a different hat.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createPackageWithOptions } from '@electron/asar'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(here, '..', '..')
const SCRIPT = path.join(desktopRoot, 'scripts', 'assert-installed-payload.mjs')
const MIGRATION = path.join(desktopRoot, 'src', 'main', 'db', 'migrations', '001_init.sql')

let root

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'minimarck-payload-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * Build a fake INSTALL DIRECTORY containing an app.asar staged from `files`.
 * The layout mirrors the real one: `<installDir>/resources/app.asar`.
 *
 * `createPackageWithOptions` RETURNS A PROMISE in @electron/asar 4.x, despite not being named
 * `...Async` and despite every sibling in that module being synchronous. Not awaiting it writes
 * NOTHING and throws nothing: the archive is simply absent, and the first version of this file
 * spent a full run reporting thirteen honest-looking failures that all said "NOT FOUND at
 * <temp path>". Same family of bug as the unawaited check in `assert-migrations-packaged.mjs` — a
 * promise nobody waited on, turning a real risk into a green or a red for the wrong reason.
 */
async function packArchive(name, files) {
  const staging = path.join(root, `${name}-staging`)
  const installDir = path.join(root, `${name}-install`)
  mkdirSync(path.join(staging, 'out', 'main', 'migrations'), { recursive: true })
  mkdirSync(path.join(staging, 'out', 'preload'), { recursive: true })
  mkdirSync(path.join(staging, 'out', 'renderer', 'assets'), { recursive: true })
  mkdirSync(path.join(installDir, 'resources'), { recursive: true })

  // The real migration, byte for byte, so the byte-identity check has something true to confirm.
  copyFileSync(MIGRATION, path.join(staging, 'out', 'main', 'migrations', '001_init.sql'))
  writeFileSync(path.join(staging, 'out', 'main', 'index.js'), files.main ?? 'export const ok = true\n')
  if (files.preload !== null) {
    writeFileSync(
      path.join(staging, 'out', 'preload', files.preloadName ?? 'index.cjs'),
      files.preload ?? 'const { contextBridge } = require("electron")\n'
    )
  }
  writeFileSync(
    path.join(staging, 'out', 'renderer', 'index.html'),
    files.html ?? '<!doctype html><html><body><div id="root"></div></body></html>\n'
  )
  for (const [rel, body] of Object.entries(files.extra ?? {})) {
    const dest = path.join(staging, rel)
    mkdirSync(path.dirname(dest), { recursive: true })
    writeFileSync(dest, body)
  }

  await createPackageWithOptions(staging, path.join(installDir, 'resources', 'app.asar'), { unpack: false })
  return installDir
}

function runCheck(installDir) {
  const res = spawnSync(process.execPath, [SCRIPT, installDir], { encoding: 'utf8' })
  return { status: res.status, out: `${res.stdout || ''}${res.stderr || ''}` }
}

describe('assert-installed-payload — a valid archive passes', () => {
  it('accepts an archive with the migration, no natives and no remote loads', async () => {
    const { status, out } = runCheck(await packArchive('clean', {}))
    expect(out).toContain('byte-for-byte identical to source')
    expect(status, out).toBe(0)
  })

  it('tolerates the inert vendor URLs a real bundle contains', async () => {
    // If this ever fails, the check has become a naive grep and will reject a perfectly offline
    // build — the "disabled because it cries wolf" outcome this file is defending against.
    const { status, out } = runCheck(
      await packArchive('inert', {
        extra: {
          'out/renderer/assets/inert.js':
            '/*! tailwindcss v4 | MIT License | https://tailwindcss.com */\n' +
            '// see https://issues.chromium.org/issues/41491098\n' +
            'var msg = "Minified React error; visit https://reactjs.org/docs/error-decoder.html?invariant=1"\n' +
            'var ns = "http://www.w3.org/2000/svg"\n',
        },
      })
    )
    expect(out).toContain('absolute URL STRING(S) are present')
    expect(status, out).toBe(0)
  })
})

describe('assert-installed-payload — it must FAIL on each real defect', () => {
  it.each([
    ['a remote script tag in the renderer HTML', { html: '<script src="https://cdn.example.com/app.js"></script>' }, 'index.html'],
    ['a fetch() to a remote host', { extra: { 'out/renderer/assets/net.js': 'fetch("https://cdn.example.com/a.json")\n' } }, 'net.js'],
    ['a CSS url() to a remote host', { extra: { 'out/renderer/assets/net.css': 'body{background:url("https://cdn.example.com/a.png")}\n' } }, 'net.css'],
    ['a CSS @import of a remote stylesheet', { extra: { 'out/renderer/assets/net.css': '@import "https://cdn.example.com/a.css";\n' } }, 'net.css'],
    ['a WebSocket to a remote host', { extra: { 'out/renderer/assets/net.js': 'new WebSocket("wss://cdn.example.com/s")\n' } }, 'net.js'],
    ['a main-process remote load', { main: 'fetch("https://cdn.example.com/telemetry")\n' }, 'index.js'],
    ['a preload remote load', { preload: 'require("https://cdn.example.com/x")\n' }, 'index.cjs']
  ])('rejects %s', async (_label, files, blamedFile) => {
    const { status, out } = runCheck(await packArchive(`net-${blamedFile}`, files))
    expect(status, out).toBe(1)
    expect(out).toContain('INSTALLED PAYLOAD FAILED')
    // The finding must NAME the file and LINE, or a reader cannot act on it.
    expect(out).toMatch(new RegExp(`${blamedFile.replace(/\./g, '\\.')}:\\d+`))
  })

  it('rejects a compiled native module', async () => {
    const { status, out } = runCheck(
      await packArchive('native', { extra: { 'out/main/better_sqlite3.node': 'MZ fake native binary' } })
    )
    expect(status, out).toBe(1)
    expect(out).toContain('nothing to rebuild')
    expect(out).toContain('better_sqlite3.node')
  })

  it('rejects a runtime dependency smuggled into the archive', async () => {
    const { status, out } = runCheck(
      await packArchive('deps', {
        extra: {
          'out/main/node_modules/left-pad/index.js': 'module.exports = () => {}\n',
          'out/main/node_modules/left-pad/package.json': '{"name":"left-pad"}\n'
        }
      })
    )
    expect(status, out).toBe(1)
    expect(out).toContain('ships no runtime dependencies')
    expect(out).toContain('left-pad')
  })

  it('rejects a preload bundled as ESM, which cannot cross the context bridge', async () => {
    const { status, out } = runCheck(
      await packArchive('esm-preload', { preloadName: 'index.mjs', preload: 'export const x = 1\n' })
    )
    expect(status, out).toBe(1)
    expect(out).toContain('CommonJS')
  })

  it('rejects a TRUNCATED migration, which would leave the shop with no tables', async () => {
    // Byte-identity is the claim under test. A migration cut in half still CONTAINS the words
    // CREATE TABLE, so any check phrased as "does it declare tables" would sail through this.
    const staging = path.join(root, 'truncated-staging')
    const installDir = path.join(root, 'truncated-install')
    mkdirSync(path.join(staging, 'out', 'main', 'migrations'), { recursive: true })
    mkdirSync(path.join(staging, 'out', 'preload'), { recursive: true })
    mkdirSync(path.join(staging, 'out', 'renderer'), { recursive: true })
    mkdirSync(path.join(installDir, 'resources'), { recursive: true })
    const full = readFileSync(MIGRATION)
    writeFileSync(path.join(staging, 'out', 'main', 'migrations', '001_init.sql'), full.subarray(0, 2000))
    writeFileSync(path.join(staging, 'out', 'main', 'index.js'), 'export const ok = true\n')
    writeFileSync(path.join(staging, 'out', 'preload', 'index.cjs'), 'const a = 1\n')
    writeFileSync(path.join(staging, 'out', 'renderer', 'index.html'), '<html></html>\n')
    await createPackageWithOptions(staging, path.join(installDir, 'resources', 'app.asar'), { unpack: false })
    const { status, out } = runCheck(installDir)
    expect(status, out).toBe(1)
    expect(out).toMatch(/bytes in source, \d+ bytes installed/)
  })

  it('reports a MISSING install instead of passing quietly', () => {
    const { status, out } = runCheck(path.join(root, 'never-installed'))
    expect(status, out).toBe(1)
    expect(out).toContain('is it installed?')
  })
})
