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

export interface AtomicWriteTextOptions {
  /** Human-readable context for error messages. Defaults to `"file"`. */
  label?: string
  /** Expected destination bytes. Use `null` when the file must not exist. */
  expectedContent?: string | null
}

export type AtomicWriteJsonOptions = Pick<AtomicWriteTextOptions, "label">

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

function unlinkIfPresent(filePath: string): void {
  try {
    fs.unlinkSync(filePath)
  } catch (error: unknown) {
    if (!isErrorCode(error, "ENOENT")) throw error
  }
}

function readRegularDestination(
  filePath: string,
  label: string,
): string | null {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(filePath)
  } catch (error: unknown) {
    if (isErrorCode(error, "ENOENT")) return null
    throw error
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      `refusing to write ${label}: destination is a symbolic link`,
    )
  }
  return fs.readFileSync(filePath, "utf8")
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return ["EPERM", "EISDIR", "EINVAL"].some((code) => isErrorCode(error, code))
}

/** Best-effort metadata durability on platforms that permit directory fsync. */
export function fsyncDirectory(directory: string): void {
  let fd: number
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY)
  } catch (error: unknown) {
    if (isUnsupportedDirectorySync(error)) return
    throw error
  }
  try {
    fs.fsyncSync(fd)
  } catch (error: unknown) {
    if (!isUnsupportedDirectorySync(error)) throw error
  } finally {
    fs.closeSync(fd)
  }
}

/** Atomically write private text, returning false when the bytes are unchanged. */
export function atomicWriteText(
  filePath: string,
  content: string,
  opts: AtomicWriteTextOptions = {},
): boolean {
  const label = opts.label ?? "file"
  const directory = path.dirname(filePath)
  fs.mkdirSync(directory, { recursive: true })
  const initialContent = readRegularDestination(filePath, label)
  const hasExpectedContent = Object.hasOwn(opts, "expectedContent")
  if (hasExpectedContent && initialContent !== opts.expectedContent) {
    throw new Error(
      `refusing to write ${label}: file changed before it could be written`,
    )
  }
  if (initialContent === content) {
    fs.chmodSync(filePath, 0o600)
    return false
  }

  const tmp = `${filePath}.tmp`
  unlinkIfPresent(tmp)
  let fd: number
  try {
    fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    )
  } catch (error: unknown) {
    if (isErrorCode(error, "EEXIST")) {
      throw new Error(
        `refusing to write ${label}: ${tmp} already exists (possible symlink attack); remove it and retry`,
      )
    }
    throw error
  }

  try {
    fs.writeFileSync(fd, content)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = -1

    const currentContent = readRegularDestination(filePath, label)
    if (currentContent !== initialContent) {
      throw new Error(
        `refusing to write ${label}: file changed before it could be written`,
      )
    }
    fs.renameSync(tmp, filePath)
    fs.chmodSync(filePath, 0o600)
    fsyncDirectory(directory)
    return true
  } finally {
    if (fd >= 0) fs.closeSync(fd)
    unlinkIfPresent(tmp)
  }
}

/**
 * Atomically write `value` as pretty-printed JSON (2-space indent, trailing
 * newline) to `filePath`.
 */
export function atomicWriteJson(
  filePath: string,
  value: unknown,
  opts: AtomicWriteJsonOptions = {},
): void {
  atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`, opts)
}
