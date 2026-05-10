/**
 * Read / merge / write helpers for Claude Desktop's
 * `claude_desktop_config.json`.
 *
 * The proxy's `setup` subcommand writes a known "default profile"
 * Claude Desktop reads on launch — gateway routing, egress allow-all,
 * telemetry off, MCP / desktop-extension toggles, and a workspace
 * folder under `$HOME/Claude` (created if missing).
 *
 * The merge is **allowlist-only**: we touch exactly the keys in
 * `PROXY_KEYS` and never overwrite anything else in the file. Writes
 * are atomic via temp-file + rename so a partial write can't leave the
 * user with a corrupted config.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** Keys we own. Anything else in the file is left untouched. Order
 *  matches the layout Claude Desktop's settings panel surfaces, to
 *  keep the on-disk file diff-friendly. */
export const PROXY_KEYS = [
  "inferenceProvider",
  "inferenceGatewayBaseUrl",
  "inferenceGatewayApiKey",
  "inferenceGatewayAuthScheme",
  "disableDeploymentModeChooser",
  "isClaudeCodeForDesktopEnabled",
  "coworkEgressAllowedHosts",
  "allowedWorkspaceFolders",
  "isDesktopExtensionEnabled",
  "isDesktopExtensionDirectoryEnabled",
  "isDesktopExtensionSignatureRequired",
  "isLocalDevMcpEnabled",
  "disableAutoUpdates",
  "disableEssentialTelemetry",
  "disableNonessentialTelemetry",
  "disableNonessentialServices",
] as const

/** @public Used by external integrations / docs as the canonical key list type. */
export type ProxyKey = (typeof PROXY_KEYS)[number]

export interface ProxyKeyValues {
  inferenceProvider: string
  inferenceGatewayBaseUrl: string
  inferenceGatewayApiKey: string
  inferenceGatewayAuthScheme: string
  disableDeploymentModeChooser: boolean
  isClaudeCodeForDesktopEnabled: boolean
  coworkEgressAllowedHosts: Array<string>
  allowedWorkspaceFolders: Array<string>
  isDesktopExtensionEnabled: boolean
  isDesktopExtensionDirectoryEnabled: boolean
  isDesktopExtensionSignatureRequired: boolean
  isLocalDevMcpEnabled: boolean
  disableAutoUpdates: boolean
  disableEssentialTelemetry: boolean
  disableNonessentialTelemetry: boolean
  disableNonessentialServices: boolean
}

/** Default profile written by `copilot-api setup`. Mirrors the shape
 *  Claude Desktop's "Configure third-party inference → Default" panel
 *  produces, with `allowedWorkspaceFolders` parameterized to the
 *  current user's home so the profile is portable across machines. */
export function defaultProxyValues(
  home: string = os.homedir(),
): ProxyKeyValues {
  return {
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: "http://127.0.0.1:4141",
    inferenceGatewayApiKey: "anything",
    inferenceGatewayAuthScheme: "bearer",
    disableDeploymentModeChooser: true,
    isClaudeCodeForDesktopEnabled: true,
    coworkEgressAllowedHosts: ["*"],
    allowedWorkspaceFolders: [path.join(home, "Claude")],
    isDesktopExtensionEnabled: true,
    isDesktopExtensionDirectoryEnabled: true,
    isDesktopExtensionSignatureRequired: false,
    isLocalDevMcpEnabled: true,
    disableAutoUpdates: false,
    disableEssentialTelemetry: true,
    disableNonessentialTelemetry: true,
    disableNonessentialServices: false,
  }
}

/**
 * Back-compat alias. Older callers imported a constant; the function
 * form is preferred since the workspace folder depends on `$HOME`.
 * @public
 */
export const DEFAULT_PROXY_VALUES: ProxyKeyValues = defaultProxyValues()

/** Resolve the platform-specific config path. Linux falls back to
 *  the macOS layout for tests / containers; not officially supported. */
export function getClaudeDesktopConfigPath(): string {
  const home = os.homedir()
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming")
    return path.join(appData, "Claude", "claude_desktop_config.json")
  }
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
  values: ProxyKeyValues = defaultProxyValues(),
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing }
  for (const k of PROXY_KEYS) {
    out[k] = values[k]
  }
  return out
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

/** Are our keys already present with the expected values? Used to
 *  decide "skip — already configured" vs "do the write." Compares
 *  arrays by content (order-sensitive — matches what we'd write). */
export function alreadyConfigured(
  existing: Record<string, unknown>,
  values: ProxyKeyValues = defaultProxyValues(),
): boolean {
  return PROXY_KEYS.every((k) => deepEqual(existing[k], values[k]))
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }
  return false
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
  /** Workspace folders we ensured exist on disk. */
  ensuredWorkspaceFolders: Array<string>
}

/** End-to-end "make Claude Desktop point at our proxy." Reads,
 *  merges, writes if needed, and creates `allowedWorkspaceFolders`
 *  on disk so Claude Desktop can attach them on first launch. */
export function applyProxyConfig(
  filePath: string = getClaudeDesktopConfigPath(),
  values: ProxyKeyValues = defaultProxyValues(),
): ApplySetupResult {
  const existing = readClaudeDesktopConfig(filePath)
  const preservedKeys = Object.keys(existing).filter(
    (k) => !(PROXY_KEYS as ReadonlyArray<string>).includes(k),
  )
  const ensuredWorkspaceFolders = ensureWorkspaceFolders(
    values.allowedWorkspaceFolders,
  )
  if (alreadyConfigured(existing, values)) {
    return {
      path: filePath,
      wrote: false,
      preservedKeys,
      ensuredWorkspaceFolders,
    }
  }
  const merged = mergeProxyKeys(existing, values)
  writeClaudeDesktopConfig(filePath, merged)
  return {
    path: filePath,
    wrote: true,
    preservedKeys,
    ensuredWorkspaceFolders,
  }
}

/** Best-effort `mkdir -p` for each workspace folder. Folders we
 *  couldn't create (permissions, non-existent parent on a removable
 *  drive) are silently skipped — Claude Desktop will surface the
 *  problem next time it tries to attach. */
function ensureWorkspaceFolders(folders: Array<string>): Array<string> {
  const created: Array<string> = []
  for (const folder of folders) {
    try {
      fs.mkdirSync(folder, { recursive: true })
      created.push(folder)
    } catch {
      /* best effort */
    }
  }
  return created
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
