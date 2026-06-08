/**
 * Read / merge / write helpers for Claude Code's `~/.claude/settings.json`.
 *
 * Unlike the Claude *Desktop* config (a flat allowlist of many keys), this
 * writer owns **exactly one** nested key: `env.ANTHROPIC_BASE_URL`. We point
 * Claude Code's CLI at the local proxy by setting that single value and never
 * touch anything else in the file — not sibling env vars (`ANTHROPIC_API_KEY`,
 * `ANTHROPIC_AUTH_TOKEN`, …) and not other top-level settings.
 *
 * Ownership guard: if `env.ANTHROPIC_BASE_URL` is already set to something
 * other than our proxy URL, we back off rather than clobber a user's hand-set
 * base URL or a different gateway.
 *
 * Writes are atomic via temp-file + rename (mode 0600 — the file can carry
 * secrets in other env keys) so a partial write can't corrupt the config.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** The local proxy's base URL. "Ours" means `env.ANTHROPIC_BASE_URL` equals
 *  this exact value. */
export const PROXY_BASE_URL = "http://127.0.0.1:4141"

/** The single key we own, nested under the top-level `env` object. */
const BASE_URL_KEY = "ANTHROPIC_BASE_URL"
const ENV_KEY = "env"

/** Resolve the Claude Code settings path. Honors `CLAUDE_CONFIG_DIR`
 *  (which Claude Code itself respects), else `~/.claude`. */
export function getClaudeCodeSettingsPath(): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")
  return path.join(configDir, "settings.json")
}

/** Read and parse the settings file. Returns `{}` on absent / unreadable /
 *  empty / unparseable / non-object — callers treat all of these as "no
 *  settings yet." */
export function readClaudeCodeSettings(
  filePath: string = getClaudeCodeSettingsPath(),
): Record<string, unknown> {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, "utf8")
  } catch {
    return {}
  }
  if (!raw.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== "object"
      || parsed === null
      || Array.isArray(parsed)
    ) {
      return {}
    }
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Extract the `env` object from a settings object, or `{}` if absent /
 *  not a plain object. Never mutates the input. */
function readEnv(settings: Record<string, unknown>): Record<string, unknown> {
  const env = settings[ENV_KEY]
  if (typeof env === "object" && env !== null && !Array.isArray(env)) {
    return env as Record<string, unknown>
  }
  return {}
}

/** Whether the current `env.ANTHROPIC_BASE_URL` is ours, someone else's, or
 *  not set at all. The crux of the ownership guard. */
export type BaseUrlOwnership = "ours" | "foreign" | "absent"

export function getBaseUrlOwnership(
  settings: Record<string, unknown>,
): BaseUrlOwnership {
  const env = readEnv(settings)
  if (!(BASE_URL_KEY in env)) return "absent"
  return env[BASE_URL_KEY] === PROXY_BASE_URL ? "ours" : "foreign"
}

/** Allowlist merge: returns a new settings object with `env.ANTHROPIC_BASE_URL`
 *  set to the proxy URL. Every other top-level setting and every sibling env
 *  var is preserved. Pure — no I/O, no mutation. */
export function mergeBaseUrl(
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const env = { ...readEnv(existing), [BASE_URL_KEY]: PROXY_BASE_URL }
  return { ...existing, [ENV_KEY]: env }
}

/** Inverse of `mergeBaseUrl`: removes only `env.ANTHROPIC_BASE_URL`. If `env`
 *  becomes empty it is dropped entirely. Every other key is preserved. Pure. */
export function stripBaseUrl(
  existing: Record<string, unknown>,
): Record<string, unknown> {
  // Destructure-and-drop rather than `delete` to satisfy no-dynamic-delete.
  const { [BASE_URL_KEY]: _droppedBaseUrl, ...env } = readEnv(existing)
  const { [ENV_KEY]: _droppedEnv, ...rest } = existing
  if (Object.keys(env).length === 0) {
    return rest
  }
  return { ...rest, [ENV_KEY]: env }
}

/** True iff `env.ANTHROPIC_BASE_URL` already equals our proxy URL. Used by the
 *  Apps card's `enabled` flag. */
export function isProxyBaseUrlConfigured(
  filePath: string = getClaudeCodeSettingsPath(),
): boolean {
  return getBaseUrlOwnership(readClaudeCodeSettings(filePath)) === "ours"
}

/** Atomic write: serialize, write to `<file>.tmp`, fsync, rename. A crash
 *  mid-write leaves the original file intact. Mode 0600 because the settings
 *  file can carry secrets (API keys / auth tokens) in its env block. */
export function writeClaudeCodeSettings(
  filePath: string,
  settings: Record<string, unknown>,
): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.tmp`
  const json = `${JSON.stringify(settings, null, 2)}\n`
  // Opportunistic cleanup of a stale tmp left by a prior crash. The O_EXCL
  // open below is what actually claims the path; this unlink does not create a
  // TOCTOU window. Swallow ENOENT only.
  try {
    fs.unlinkSync(tmp)
  } catch (err: unknown) {
    if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") {
      throw err
    }
  }
  // O_EXCL ensures we fail rather than follow a symlink an attacker could have
  // planted at `${filePath}.tmp`.
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
        `refusing to write Claude Code settings: ${tmp} already exists (possible symlink attack); remove it and retry`,
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

/** Why a write was skipped, when it was. */
export type SkipReason = "already-ours" | "foreign-base-url"

export interface ApplyResult {
  /** Where the file lived. */
  path: string
  /** Whether we actually wrote. False when skipped (see `skippedReason`). */
  wrote: boolean
  /** Set when `wrote` is false: why we didn't write. Undefined on a real write. */
  skippedReason?: SkipReason
}

/** Ownership-guarded write: point Claude Code at the proxy by setting
 *  `env.ANTHROPIC_BASE_URL`.
 *
 *  - absent  → write it.
 *  - ours    → no-op (`already-ours`).
 *  - foreign → back off (`foreign-base-url`), never clobber.
 *
 *  Throws only on real IO / symlink errors. */
export function applyProxyBaseUrl(
  filePath: string = getClaudeCodeSettingsPath(),
): ApplyResult {
  const existing = readClaudeCodeSettings(filePath)
  const ownership = getBaseUrlOwnership(existing)
  if (ownership === "ours") {
    return { path: filePath, wrote: false, skippedReason: "already-ours" }
  }
  if (ownership === "foreign") {
    return { path: filePath, wrote: false, skippedReason: "foreign-base-url" }
  }
  writeClaudeCodeSettings(filePath, mergeBaseUrl(existing))
  return { path: filePath, wrote: true }
}

export interface RevertResult {
  /** Where the file lived. */
  path: string
  /** Whether we changed anything on disk (write or delete). */
  wrote: boolean
  /** Top-level keys remaining after the revert. Empty when the file was
   *  removed. */
  remainingKeys: Array<string>
}

/** Inverse of `applyProxyBaseUrl`: remove `env.ANTHROPIC_BASE_URL` only if it
 *  is ours. A foreign base URL is left intact. If removing ours empties `env`,
 *  the `env` key is dropped; if that empties the whole settings object, the
 *  file is removed. */
export function revertProxyBaseUrl(
  filePath: string = getClaudeCodeSettingsPath(),
): RevertResult {
  const existing = readClaudeCodeSettings(filePath)
  const ownership = getBaseUrlOwnership(existing)
  if (ownership !== "ours") {
    // absent → nothing to do; foreign → not ours, leave it.
    return {
      path: filePath,
      wrote: false,
      remainingKeys: Object.keys(existing),
    }
  }
  const stripped = stripBaseUrl(existing)
  if (Object.keys(stripped).length === 0) {
    try {
      fs.rmSync(filePath, { force: true })
    } catch {
      /* best effort — caller may not own the file */
    }
    return { path: filePath, wrote: true, remainingKeys: [] }
  }
  writeClaudeCodeSettings(filePath, stripped)
  return {
    path: filePath,
    wrote: true,
    remainingKeys: Object.keys(stripped),
  }
}
