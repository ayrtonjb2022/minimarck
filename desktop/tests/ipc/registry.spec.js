import { describe, it, expect } from 'vitest'
import { createRegistry } from '../../src/main/bridge/registry.js'
import { OPS, OPS_COUNT, TOPICS } from '../../src/shared/ipc-contract.js'
import { registerDbHandlers } from '../../src/main/ipc/db.js'

/**
 * The IPC allowlist (SEC-2). The security claim is that the renderer cannot express SQL,
 * name a table, or reach the filesystem — enforced by the frozen OPS contract plus the
 * registry's two gates (unknown group/op, and not-implemented-in-this-build).
 */

describe('frozen OPS contract', () => {
  it('contains exactly 88 operations', () => {
    expect(OPS_COUNT).toBe(88)
  })

  it('exposes NO channel that could carry SQL, a table name, or a file path', () => {
    // The allowlist is the whole security claim: if none of these exist as operations,
    // the renderer has no way to express SQL even if it tried.
    const sqlEscape = ['query', 'exec', 'sql', 'raw', 'run', 'pragma', 'statement', 'prepare', 'readFile', 'writeFile', 'table']
    for (const [group, ops] of Object.entries(OPS)) {
      for (const op of ops) {
        // No operation is a raw-SQL / escape primitive.
        expect(sqlEscape, `${group}.${op}`).not.toContain(op.toLowerCase())
        // No operation is a full SQL statement (i.e. carries its own keywords + space).
        // A bare business verb like `update` or `remove` is legitimate and present in the
        // contract; what must never appear is a statement that names a table or clause.
        expect(op.toLowerCase(), `${group}.${op}`).not.toMatch(
          /^(select|insert\s+into|update\s+\w|delete\s+from|drop\s+table|alter\s+table)/
        )
      }
    }
  })

  it('uses business verbs, not SQL, as its operation vocabulary', () => {
    // The positive statement of the same claim: the contract is CRUD-over-aggregates.
    const all = Object.values(OPS).flat()
    for (const verb of ['list', 'get', 'create', 'update', 'remove', 'cancel', 'close', 'open']) {
      expect(all).toContain(verb)
    }
  })
})

describe('registry allowlist (SEC-2)', () => {
  it('rejects an unknown group with UNKNOWN_GROUP', () => {
    const r = createRegistry()
    expect(() => r.resolve('evil', 'dropTables')).toThrowError(/Unknown group/)
  })

  it('rejects an unknown op within a real group with UNKNOWN_OP', () => {
    const r = createRegistry()
    expect(() => r.resolve('ventas', 'dropEverything')).toThrowError(/Unknown op/)
  })

  it('resolves a contract member with no handler to NOT_IMPLEMENTED, not a crash', () => {
    const r = createRegistry()
    try {
      r.resolve('ventas', 'create')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e.code).toBe('NOT_IMPLEMENTED')
      expect(e.status).toBe(501)
    }
  })

  it('refuses to register an operation that is not in the frozen contract', () => {
    const r = createRegistry()
    expect(() => r.register('ventas', { dbQuery: () => 'nope' })).toThrowError(/not in the frozen OPS contract/)
  })

  it('resolves a registered handler and runs it with the payload', async () => {
    const r = createRegistry()
    r.register('ventas', { list: (payload) => ({ echoed: payload.page ?? 1 }) })
    const fn = r.resolve('ventas', 'list')
    expect(await fn({ page: 3 }, {})).toEqual({ echoed: 3 })
  })
})

describe('S0 registered surface', () => {
  it('registers ONLY the read-only db.* contract ops, nothing else', () => {
    const r = createRegistry()
    registerDbHandlers(r, { userDataPath: '/tmp/u', env: {} })
    for (const group of Object.keys(OPS)) {
      for (const op of OPS[group]) {
        const implemented = r.isImplemented(group, op)
        // S0 implements db.info/schemaVersion/reconcile and nothing else. Every other
        // contract op must be unimplemented so later slices own them honestly.
        const shouldBeImplemented = group === 'db'
        expect(implemented, `${group}.${op}`).toBe(shouldBeImplemented)
      }
    }
  })

  it('db.info reports resolved paths and the runtime versions, and opens no database', () => {
    const r = createRegistry()
    const paths = registerDbHandlers(r, { userDataPath: '/tmp/u', env: {} })
    const info = r.resolve('db', 'info')({})
    expect(info.dbFile).toContain('minimarck.db')
    expect(info.exists).toBe(false) // S0 creates no DB
    expect(typeof info.sqlite).toBe('string')
    expect(paths.dataDir).toBeTruthy()
  })
})

describe('event topics (SEC-2)', () => {
  it('exposes exactly the four allowed topics', () => {
    expect(TOPICS).toEqual(['backup:progress', 'import:progress', 'db:changed', 'theme:changed'])
  })
})
