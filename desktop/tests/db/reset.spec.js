import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { shippedSignals, planReset, performReset, resetTargets, desktopRoot } from '../../src/main/db/reset.js'

/**
 * The guard in here is the only thing standing between a schema edit and a deleted database, so
 * it is tested against the cases where being WRONG is expensive: a shipped app, a release tag, a
 * missing private flag, and a force flag that must be explicit.
 */

let dir
let paths

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'minimarck-reset-'))
  paths = {
    dataDir: dir,
    dbFile: path.join(dir, 'minimarck.db'),
    walFile: path.join(dir, 'minimarck.db-wal'),
    shmFile: path.join(dir, 'minimarck.db-shm')
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const write = (file, contents) => writeFileSync(file, contents)

describe('resetTargets — all three files, because one of them is enough to block a launch', () => {
  it('targets the database and BOTH SQLite sidecars', () => {
    const targets = resetTargets(paths)
    expect(targets.map((t) => t.file)).toEqual([paths.dbFile, paths.walFile, paths.shmFile])
  })

  it('derives the sidecar names from the database name, not by string surgery', () => {
    // SQLite appends `-wal` / `-shm` to the full filename. A db named `x.db` yields `x.db-wal`,
    // not `x-wal.db` — and getting that wrong deletes nothing while claiming success.
    const p = { dbFile: path.join('a', 'minimarck.db'), walFile: '', shmFile: '' }
    const resolved = { ...p, walFile: p.dbFile + '-wal', shmFile: p.dbFile + '-shm' }
    expect(resetTargets(resolved).map((t) => t.file)).toEqual([p.dbFile, p.dbFile + '-wal', p.dbFile + '-shm'])
  })
})

describe('shippedSignals — read from real data, never hardcoded', () => {
  it('an unreleased private app is not shipped', () => {
    const s = shippedSignals({ version: '0.1.0', private: true }, [])
    expect(s.atOrPastOne).toBe(false)
    expect(s.unpublishedFlagLost).toBe(false)
  })

  it('a 1.0.0 version means shipped', () => {
    expect(shippedSignals({ version: '1.0.0', private: true }, []).atOrPastOne).toBe(true)
  })

  it('a pre-release of 1.0.0 is still unreleased, so the guard does not cry wolf', () => {
    const s = shippedSignals({ version: '1.0.0-rc.1', private: true }, [])
    expect(s.atOrPastOne).toBe(false)
  })

  it('losing the private flag counts as shipped on its own', () => {
    // `private: true` exists to say "not published". Removing it means it is no longer a fact.
    expect(shippedSignals({ version: '0.1.0' }, []).unpublishedFlagLost).toBe(true)
  })

  it('a v1.0.0 tag counts as shipped even at version 0.1.0', () => {
    const s = shippedSignals({ version: '0.1.0', private: true }, ['v1.0.0'])
    expect(s.releaseTags).toEqual(['v1.0.0'])
  })

  it('a 0.1.0 tag is not a release tag', () => {
    expect(shippedSignals({ version: '0.1.0', private: true }, ['v0.1.0']).releaseTags).toEqual([])
  })
})

describe('planReset — the refusal is the feature', () => {
  const devSignals = shippedSignals({ version: '0.1.0', private: true }, [])

  it('allows an unreleased app to reset without asking', () => {
    expect(planReset({ paths, signals: devSignals }).allowed).toBe(true)
  })

  it('REFUSES a shipped app and names the reason', () => {
    const plan = planReset({ paths, signals: shippedSignals({ version: '1.2.0', private: true }, []) })
    expect(plan.allowed).toBe(false)
    expect(plan.message).toMatch(/REFUSING/)
    expect(plan.message).toMatch(/1\.2\.0/)
    expect(plan.message).toMatch(/db:reset:force/)
  })

  it('refuses on a release tag alone', () => {
    const plan = planReset({ paths, signals: shippedSignals({ version: '0.1.0', private: true }, ['v1.0.0']) })
    expect(plan.allowed).toBe(false)
    expect(plan.message).toMatch(/v1\.0\.0/)
  })

  it('force is the ONLY way past, and it is explicit', () => {
    const signals = shippedSignals({ version: '1.2.0', private: true }, [])
    expect(planReset({ paths, signals, force: false }).allowed).toBe(false)
    const forced = planReset({ paths, signals, force: true })
    expect(forced.allowed).toBe(true)
    expect(forced.shipped).toBe(true)
    expect(forced.reasons.length).toBeGreaterThan(0)
  })

  it('decides WITHOUT touching the filesystem, so a refusal cannot half-delete', () => {
    write(paths.dbFile, 'data')
    planReset({ paths, signals: shippedSignals({ version: '1.0.0', private: true }, []) })
    expect(existsSync(paths.dbFile)).toBe(true)
  })
})

describe('performReset — reports everything, deletes only files', () => {
  it('deletes the database and both sidecars, and reports all three', () => {
    for (const f of [paths.dbFile, paths.walFile, paths.shmFile]) write(f, 'x')
    const out = []
    const r = performReset(paths, { log: (m) => out.push(m) })
    expect(r.ok).toBe(true)
    expect(r.deleted).toHaveLength(3)
    expect(r.absent).toHaveLength(0)
    expect(existsSync(paths.dbFile)).toBe(false)
    // "It did not delete this" must be as visible as "it did".
    expect(out.join('\n')).toMatch(/DELETED/)
    expect(out.filter((l) => l.includes('DELETED'))).toHaveLength(3)
  })

  it('reports an already-absent file as absent rather than silently skipping it', () => {
    write(paths.dbFile, 'x')
    const out = []
    const r = performReset(paths, { log: (m) => out.push(m) })
    expect(r.deleted).toHaveLength(1)
    expect(r.absent).toHaveLength(2)
    expect(out.join('\n')).toMatch(/absent/)
  })

  it('is a no-op, not a failure, when nothing is there', () => {
    const r = performReset(paths, { log: () => {} })
    expect(r.ok).toBe(true)
    expect(r.deleted).toHaveLength(0)
    expect(r.absent).toHaveLength(3)
  })

  it('leaves everything else in the data directory alone', () => {
    // Deleting a database must not take a backup, a sibling database, or anything else with it.
    write(paths.dbFile, 'x')
    const keep = path.join(dir, 'important.txt')
    write(keep, 'do not delete')
    performReset(paths, { log: () => {} })
    expect(existsSync(keep)).toBe(true)
    expect(readdirSync(dir)).toContain('important.txt')
  })

  it('reports the byte count it removed', () => {
    write(paths.dbFile, '12345')
    const r = performReset(paths, { log: () => {} })
    expect(r.deleted[0].bytes).toBe(5)
  })

  it('survives a target that is a DIRECTORY, by failing loudly instead of recursing', () => {
    // `rm(..., {recursive})` would delete a tree. A wrong path must cost a FAILED line, not data.
    // `mkdirSync`, not `writeFileSync` on a child path: that needs the parent to exist first and
    // would fail with ENOENT for a reason that has nothing to do with the behaviour under test.
    mkdirSync(paths.dbFile)
    writeFileSync(path.join(paths.dbFile, 'keep'), 'x')
    const out = []
    const r = performReset(paths, { log: (m) => out.push(m) })
    expect(r.ok).toBe(false)
    expect(r.failed).toHaveLength(1)
    expect(out.join('\n')).toMatch(/FAILED/)
    expect(existsSync(path.join(paths.dbFile, 'keep'))).toBe(true)
  })
})

describe('the real repository layout', () => {
  it('resolves the desktop root from the module location, not the cwd', () => {
    expect(path.basename(desktopRoot())).toBe('desktop')
    expect(existsSync(path.join(desktopRoot(), 'package.json'))).toBe(true)
  })

  it('the version bump to 1.0.0 ARMED the db:reset guard against the real package.json', () => {
    // This test is deliberately about the real package.json, and it deliberately flipped when the
    // version went to 1.0.0. That flip is the test working, not the test breaking: a released
    // build has run on a real machine, and `db:reset` must refuse to delete that machine's sales
    // history because someone typed a convenient command. The guard now needs `db:reset:force`.
    //
    // It is NOT kept green by moving the version back, and it is NOT deleted to get a green run.
    // Both would restore the ability to wipe a real shop's database with one command. The
    // assertion is the version being AT LEAST 1.0.0, so the next bump cannot quietly lower it.
    const pkg = JSON.parse(
      readFileSync(path.join(desktopRoot(), 'package.json'), 'utf8')
    )
    const s = shippedSignals(pkg, [])
    expect(s.atOrPastOne).toBe(true)
    expect(s.version.split('.').map(Number)[0]).toBeGreaterThanOrEqual(1)
    // And therefore the destructive command is refused on the real repo, by the real planner.
    expect(planReset({ paths, signals: s }).allowed).toBe(false)
    // The deliberate override must still exist, or the guard is a lock with no key.
    expect(planReset({ paths, signals: s, force: true }).allowed).toBe(true)
  })

  it('the database name the script deletes is the name the app opens', () => {
    const p = resetTargets({ dbFile: path.join(dir, 'minimarck.db'), walFile: '', shmFile: '' })
    expect(path.basename(p[0].file)).toBe('minimarck.db')
  })
})
