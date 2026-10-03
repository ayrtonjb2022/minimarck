import { describe, it, expect, afterAll } from 'vitest'
import { DatabaseSync, backup } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The node:sqlite SMOKE test (S0's headline verification).
 *
 * Two runtimes matter and this file covers the TEST runtime:
 *   - Electron's bundled Node is proven by `npm run spike` (src/main/spike/node-sqlite.spike.js),
 *     which runs the same assertions UNDER electron@44.4.5. That is the abort criterion.
 *   - This spec runs under the SYSTEM Node that Vitest uses, because from S1 onward EVERY
 *     database test (connection, TxRunner, migrate, schema) executes here. If node:sqlite
 *     were unavailable in the test runtime, the whole S1+ test strategy would be dead on
 *     arrival — so it is proven now, in S0, not discovered in S1.
 *
 * The core requirement is literal: a database file is created, a table is created, a row
 * is inserted, and the row is read back.
 */

const dir = mkdtempSync(join(tmpdir(), 'mm-smoke-'))
const file = join(dir, 'smoke.db')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('node:sqlite smoke', () => {
  it('imports node:sqlite and exposes the API surface S1+ depends on', () => {
    // These three are what design §0.4 pins Electron >= 40 for. If the TEST runtime lacks
    // them, S1's connection layer (setAuthorizer allowlist, enableDefensive) cannot be
    // tested at all.
    expect(typeof DatabaseSync).toBe('function')
    expect(typeof DatabaseSync.prototype.setAuthorizer).toBe('function')
    expect(typeof DatabaseSync.prototype.enableDefensive).toBe('function')
    expect(typeof backup).toBe('function')
  })

  it('creates a database file, a table, inserts a row, and reads it back', () => {
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
    db.prepare('INSERT INTO t (id, name) VALUES (?, ?)').run(1, 'minimarck')
    const row = db.prepare('SELECT name FROM t WHERE id = ?').get(1)
    expect(row.name).toBe('minimarck')
    db.close()
  })

  it('reopens the file and the committed row survives (durability)', () => {
    const db = new DatabaseSync(file)
    const row = db.prepare('SELECT name FROM t WHERE id = ?').get(1)
    expect(row.name).toBe('minimarck')
    db.close()
  })

  it('supports WAL, so a committed write is visible from a second handle', () => {
    const writer = new DatabaseSync(file)
    writer.exec('PRAGMA journal_mode = WAL')
    const mode = writer.prepare('PRAGMA journal_mode').get().journal_mode
    expect(String(mode).toLowerCase()).toBe('wal')
    const reader = new DatabaseSync(file)
    expect(reader.prepare('SELECT COUNT(*) AS n FROM t').get().n).toBe(1)
    reader.close()
    writer.close()
  })
})
