/**
 * WHERE esbuild's large transform payloads get staged, and why it is not `%TEMP%`.
 *
 * WHAT HAPPENS. esbuild's JS bridge passes a transform result to its Go service. Below roughly
 * 1 MB it goes over the pipe in memory. Above that it writes a temp file, hands the path to the
 * service, and the service deletes it when it is finished. On this machine that delete returns
 * `ERROR_ACCESS_DENIED` ("Acceso denegado") for files of that size — every time, reproducibly,
 * in every temp directory tried: the user `%TEMP%`, `C:\WINDOWS\temp`, and the repository root.
 * The renderer bundle is ~1,19 MB, which is why this surfaces on the renderer build and why the
 * main and preload bundles, both under the threshold, always succeeded.
 *
 * WHAT IT IS NOT, since the obvious explanations were all checked and eliminated.
 *
 *   - Not antivirus. Windows Defender reports `RealTimeProtectionEnabled: False` on this host,
 *     and PowerShell deletes a 1 MB file written to `%TEMP%` in 9 ms.
 *   - Not permissions. The staging directory carries no deny ACE, and the failing file is not
 *     locked once the process has exited — it deletes immediately afterwards.
 *   - Not a filesystem size limit. The same size deletes fine from the directory below.
 *   - Not a stale lock and not accumulation. No `esbuild`, `vite` or stray `node` process is
 *     alive when it fails, and clearing every `esbuild-*` entry does not make the next build pass.
 *
 * The failing step is esbuild's own `os.Remove`, which points at the sandbox/guard layer on this
 * machine rather than at anything in this repository. Confirming that needs `fltmc` with
 * administrator rights, so it is documented here rather than claimed as understood. If that
 * layer ever grants the delete, this indirection is harmless and can be deleted.
 *
 * WHY THIS DIRECTORY. `node_modules/.cache/`, for three reasons: `node_modules/` is already in
 * `.gitignore`, so nothing here can ever dirty the tree; it is NOT the outDir, so electron-vite's
 * `emptyOutDir` cannot delete the staging directory out from under the build that is using it;
 * and it is a cache, so a stale file here costs disk and never correctness.
 *
 * WHY IT IS NOT CLEANED UP. Given that deletion is the exact operation failing, a script whose
 * own job was to delete these files would fail at its job.
 */
import path from 'node:path'
import { mkdirSync } from 'node:fs'

/** Absolute path to the staging directory, created if absent. */
export function stagingDir(root) {
  const dir = path.join(root, 'node_modules', '.cache', 'minimarck-staging')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * A child-process environment with the staging directory applied.
 *
 * `os.tmpdir()` consults `TMPDIR` on POSIX and `TEMP` on Windows. All three are set so this
 * keeps working if the build is ever run on another platform, where the bug may not exist at all
 * and this wrapper is then simply a harmless pass-through.
 */
export function stagingEnv(root) {
  const dir = stagingDir(root)
  return { ...process.env, TEMP: dir, TMP: dir, TMPDIR: dir }
}