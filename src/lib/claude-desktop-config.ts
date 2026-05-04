/**
 * Read / merge / write helpers for Claude Desktop's
 * `claude_desktop_config.json`.
 *
 * The proxy's `setup` subcommand needs to point Claude Desktop at
 * `localhost:4141` without clobbering whatever else the user has
 * configured. The merge is **allowlist-only** — we touch exactly
 * three keys (`inferenceProvider`, `inferenceGatewayBaseUrl`,
 * `inferenceGatewayApiKey`) and never deep-merge or overwrite
 * anything else.
 *
 * Writes are atomic via temp-file + rename so a partial write can't
 * leave the user with a corrupted config and a broken Claude Desktop.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** Keys we own. Anything else in the file is left untouched. */
export const PROXY_KEYS = [
  "inferenceProvider",
  "inferenceGatewayBaseUrl",
  "inferenceGatewayApiKey",
] as const

export type ProxyKey = (typeof PROXY_KEYS)[number]

export interface ProxyKeyValues {
  inferenceProvider: string
  inferenceGatewayBaseUrl: string
  inferenceGatewayApiKey: string
}

/** Default values written by `copilot-api setup`. The api-key value
 *  is intentionally a literal — the proxy accepts any non-empty
 *  bearer; the actual auth is the local-loopback connection. */
export const DEFAULT_PROXY_VALUES: ProxyKeyValues = {
  inferenceProvider: "gateway",
  inferenceGatewayBaseUrl: "http://localhost:4141",
  inferenceGatewayApiKey: "anything",
}

/** Resolve the platform-specific config path. Linux falls back to
 *  the macOS layout for tests / containers; not officially supported. */
export function getClaudeDesktopConfigPath(): string {
  const home = os.homedir()
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming")
    return path.join(appData, "Claude", "claude_desktop_config.json")
  }
  // macOS (and fallback for linux test environments)
  return path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "claude_desktop_config.json",
  )
}

/** Read and parse the config file. Returns `{}` on absent / unreadable
 *  / unparseable — the merge step treats absence and bad JSON the
 *  same way (overwrite with our keys). The caller is expected to
 *  decide whether to warn. */
export function readClaudeDesktopConfig(
  filePath: string = getClaudeDesktopConfigPath(),
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

/** Allowlist merge: returns a new object with the proxy keys set to
 *  `values`, every other key from `existing` preserved. Pure — no
 *  I/O, no mutation. */
export function mergeProxyKeys(
  existing: Record<string, unknown>,
  values: ProxyKeyValues = DEFAULT_PROXY_VALUES,
): Record<string, unknown> {
  return {
    ...existing,
    inferenceProvider: values.inferenceProvider,
    inferenceGatewayBaseUrl: values.inferenceGatewayBaseUrl,
    inferenceGatewayApiKey: values.inferenceGatewayApiKey,
  }
}

/** Inverse of `mergeProxyKeys`: removes our keys, leaves everything
 *  else. Used by the uninstall flow's `--revert-claude` path. */
export function stripProxyKeys(
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(existing)) {
    if (!(PROXY_KEYS as ReadonlyArray<string>).includes(k)) {
      out[k] = v
    }
  }
  return out
}

/** Are our three keys already present with the expected values? Used
 *  to decide "skip — already configured" vs "do the write." */
export function alreadyConfigured(
  existing: Record<string, unknown>,
  values: ProxyKeyValues = DEFAULT_PROXY_VALUES,
): boolean {
  return PROXY_KEYS.every((k) => existing[k] === values[k])
}

/** Atomic write: serialize, write to `<file>.tmp`, fsync, rename.
 *  A crash mid-write leaves the original file intact. */
export function writeClaudeDesktopConfig(
  filePath: string,
  config: Record<string, unknown>,
): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.tmp`
  const json = `${JSON.stringify(config, null, 2)}\n`
  const fd = fs.openSync(tmp, "w", 0o644)
  try {
    fs.writeFileSync(fd, json)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, filePath)
}

export interface ApplySetupResult {
  /** Where the file lived. */
  path: string
  /** Whether we actually wrote — false when `alreadyConfigured`. */
  wrote: boolean
  /** Existing keys preserved. Useful for diagnostic output. */
  preservedKeys: Array<string>
}

/** End-to-end "make Claude Desktop point at our proxy." Reads,
 *  merges, writes if needed. Returns a small report. */
export function applyProxyConfig(
  filePath: string = getClaudeDesktopConfigPath(),
  values: ProxyKeyValues = DEFAULT_PROXY_VALUES,
): ApplySetupResult {
  const existing = readClaudeDesktopConfig(filePath)
  if (alreadyConfigured(existing, values)) {
    return {
      path: filePath,
      wrote: false,
      preservedKeys: Object.keys(existing).filter(
        (k) => !(PROXY_KEYS as ReadonlyArray<string>).includes(k),
      ),
    }
  }
  const merged = mergeProxyKeys(existing, values)
  writeClaudeDesktopConfig(filePath, merged)
  return {
    path: filePath,
    wrote: true,
    preservedKeys: Object.keys(existing).filter(
      (k) => !(PROXY_KEYS as ReadonlyArray<string>).includes(k),
    ),
  }
}

export interface RevertResult {
  path: string
  wrote: boolean
  remainingKeys: Array<string>
}

/** End-to-end "remove our keys, leave the rest." Used by the
 *  uninstall flow's `--revert-claude`. If after stripping the file
 *  is empty, the file is removed entirely. */
export function revertProxyConfig(
  filePath: string = getClaudeDesktopConfigPath(),
): RevertResult {
  const existing = readClaudeDesktopConfig(filePath)
  const hasOurs = PROXY_KEYS.some((k) => k in existing)
  if (!hasOurs) {
    return {
      path: filePath,
      wrote: false,
      remainingKeys: Object.keys(existing),
    }
  }
  const stripped = stripProxyKeys(existing)
  if (Object.keys(stripped).length === 0) {
    try {
      fs.rmSync(filePath, { force: true })
    } catch {
      /* best effort — caller may not own the file */
    }
    return { path: filePath, wrote: true, remainingKeys: [] }
  }
  writeClaudeDesktopConfig(filePath, stripped)
  return {
    path: filePath,
    wrote: true,
    remainingKeys: Object.keys(stripped),
  }
}
