import { rmSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Deleting a development database, as a command instead of a judgement call.
 *
 * WHY THIS EXISTS. The migration runner records a checksum per applied file and REFUSES to run
 * when an applied file changed (`migrate.js`, `assertConsistent`). That guard is correct and it
 * is not negotiable: SQLite stores no DDL history, so an edited migration against an existing
 * database is the one way to end up running a different schema over real data with nothing in
 * the logs.
 *
 * But editing `001_init.sql` in place is completely normal while the app is unreleased, and the
 * guard cannot tell that case from the dangerous one. So the recurring decision — "is this
 * database safe to delete?" — arrives as a judgement call every single time the schema changes,
 * and judgement calls under time pressure are exactly how somebody deletes a real database. This
 * module makes the decision ONCE, in code, where it can be read and tested.
 *
 * The refusal is the important half. A destructive one-liner with no guard is worse than the
 * conversation it replaces, because it removes the moment where someone looks at the path and
 * thinks. So: if the app has ever shipped, this refuses and explains, and the only way past is
 * `db:reset:force`, whose existence is the record that a human chose to destroy data.
 */

/** The three files SQLite may hold for one database. All three, or the next open is a partial one. */
export function resetTargets(paths) {
  return [
    { role: 'database', file: paths.dbFile },
    { role: 'WAL sidecar', file: paths.walFile },
    { role: 'shared-memory sidecar', file: paths.shmFile }
  ]
}

/**
 * Has this app ever shipped? The single question the guard turns on.
 *
 * Two independent signals, and EITHER one is enough to mean "there may be real data out there":
 *
 *   - a version at or past 1.0.0, or any non-prerelease tag: a released build has run on
 *     somebody's machine.
 *   - the `private: true` flag being removed: it exists precisely to say "this is not published",
 *     so its absence means the flag is no longer a fact about the app.
 *
 * Both are checked against the REAL `package.json` on disk, not a constant. A hardcoded
 * "0.1.0" would be a guard that silently inverts the day someone bumps the version, which is
 * precisely the day it matters. `1.0.0` is the threshold because 0.x is the conventional
 * "not yet released" range, and a pre-release suffix (`1.0.0-rc.1`) still counts as unreleased.
 */
export function shippedSignals(pkg, tags = []) {
  const version = String(pkg?.version ?? '0.0.0')
  const atOrPastOne = /^\d+\.\d+\.\d+$/.test(version) && version.split('.').map(Number)[0] >= 1
  return {
    version,
    private: pkg?.private === true,
    // A release tag like `v1.0.0` implies a build went out even if package.json still says 0.1.0.
    releaseTags: tags.filter((t) => /^v?\d+\.\d+\.\d+$/.test(t) && t.replace(/^v/, '').split('.').map(Number)[0] >= 1),
    atOrPastOne,
    unpublishedFlagLost: pkg?.private !== true
  }
}

/** Read the real signals off disk. Split out so the guard can be tested with fixtures. */
export function readShippedSignals(root) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  return shippedSignals(pkg, root.tags ?? [])
}

/**
 * Decide what to do, without touching the filesystem.
 *
 * Returns a decision rather than throwing or deleting, so the caller can PRINT the reasoning
 * before anything irreversible happens and a test can assert on it with no real files at risk.
 */
export function planReset({ paths, signals, force = false }) {
  const shipped = signals.atOrPastOne || signals.releaseTags.length > 0 || signals.unpublishedFlagLost
  const reasons = []
  if (signals.atOrPastOne) reasons.push(`version is ${signals.version} (>= 1.0.0)`)
  if (signals.releaseTags.length) reasons.push(`release tags exist: ${signals.releaseTags.join(', ')}`)
  if (signals.unpublishedFlagLost) reasons.push('package.json is not marked private')

  if (shipped && !force) {
    return {
      allowed: false,
      shipped,
      reasons,
      message:
        'REFUSING to delete. This app has shipped, so the database may hold real sales.\n' +
        reasons.map((r) => `  - ${r}`).join('\n') +
        '\n\n' +
        'If you are certain this is throwaway development data, run: npm run db:reset:force'
    }
  }
  return { allowed: true, shipped, reasons, message: null }
}

/**
 * Perform the reset.
 *
 * `unlink` rather than `rm`: these are three known files, and a recursive delete aimed at a path
 * the user did not expect is the worst version of this script. `rmSync(file, { force: true })`
 * would also not follow a directory, but a file-only API makes the intent checkable by reading it.
 *
 * Every target is reported either way, including the ones that were not there. "It deleted
 * minimark.db and left the WAL alone" is a fact the operator needs; silence would leave them
 * guessing whether a sidecar survived and will be reattached on next open.
 */
export function performReset(paths, { force = false, log = console.log } = {}) {
  const targets = resetTargets(paths)
  const deleted = []
  const absent = []
  const failed = []

  for (const t of targets) {
    if (!existsSync(t.file)) {
      absent.push(t)
      continue
    }
    try {
      const bytes = statSync(t.file).size
      rmSync(t.file, { force: true })
      deleted.push({ ...t, bytes })
    } catch (error) {
      // Most likely the app is running and holding the file open. Report it rather than
      // continuing silently — a partial reset that looks like a clean one is the worst outcome.
      failed.push({ ...t, error: error.message })
    }
  }

  for (const t of deleted) log(`  DELETED  ${t.role.padEnd(21)} ${t.file}  (${t.bytes} bytes)`)
  for (const t of absent) log(`  absent   ${t.role.padEnd(21)} ${t.file}  (nothing to delete)`)
  for (const t of failed) log(`  FAILED   ${t.role.padEnd(21)} ${t.file}  — ${t.error}`)

  return { deleted, absent, failed, ok: failed.length === 0 }
}

/** The desktop root, resolved from this module's own location (never `process.cwd()`). */
export function desktopRoot() {
  // reset.js lives at src/main/db/reset.js, so THREE levels up is the package root, not two.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}
