/**
 * Single atomic JSON writer shared by every app-config writer (Claude Code's
 * `settings.json`, Claude Desktop's 3P config, …).
 *
 * Why this lives in `~/lib/` and not under one app: keeping two byte-for-byte
 * copies of a security-relevant write invited exactly the drift that #231
 * caught. Consolidating means neither app owns the other's behavior.
 *
 * Guarantees:
 *  - `mkdir -p` the parent dir.
 *  - Clear any stale `<file>.tmp` first (`unlink`, ignoring ENOENT). `unlink`
 *    removes the temp entry itself — including a planted symlink — WITHOUT
 *    following it to a target, so it is symlink-safe. Its real job is crash
 *    recovery: a write that died between open and rename leaves a stale
 *    regular temp behind, and this clears it so the next write self-heals
 *    instead of failing forever.
 *  - Open the temp with `O_WRONLY|O_CREAT|O_EXCL` @ mode 0o600. O_EXCL is the
 *    actual symlink guard: the kernel refuses to open through a symlink at the
 *    final path component and fails the create if anything already exists
 *    there. The EEXIST branch below is a concurrency/attack backstop (two
 *    writers racing the same temp) — rarely hit once the unlink has run, but
 *    kept for a clear message rather than a raw errno.
 *  - `write` + `fsync` + atomic `rename` into place.
 */

import fs from "node:fs"
import path from "node:path"

export interface AtomicWriteJsonOptions {
  /** Human-readable context for the concurrency/symlink error message, e.g.
   *  `"Claude Code settings"`. Defaults to `"file"`. */
  label?: string
}

/**
 * Atomically write `value` as pretty-printed JSON (2-space indent, trailing
 * newline) to `filePath`. Clears a stale temp first (crash recovery) and
 * writes through a fresh O_EXCL temp (symlink-safe) before renaming into place.
 */
export function atomicWriteJson(
  filePath: string,
  value: unknown,
  opts: AtomicWriteJsonOptions = {},
): void {
  const label = opts.label ?? "file"
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  const json = `${JSON.stringify(value, null, 2)}\n`
  // Clear a stale temp (e.g. from a crashed prior write). unlink removes the
  // entry itself without following a symlink, so this is symlink-safe; ENOENT
  // (no stale temp) is the normal case.
  try {
    fs.unlinkSync(tmp)
  } catch (err: unknown) {
    if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") {
      throw err
    }
  }
  let fd: number
  try {
    fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    )
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "EEXIST") {
      throw new Error(
        `refusing to write ${label}: ${tmp} already exists (possible symlink attack); remove it and retry`,
      )
    }
    throw err
  }
  try {
    fs.writeFileSync(fd, json)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, filePath)
}
