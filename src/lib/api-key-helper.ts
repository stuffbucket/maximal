/**
 * apiKeyHelper — resolve the proxy's API key for an integrated client, invoked
 * as `maximal --apiKeyHelper [label]` (the command a client's config points at
 * so it never stores a key statically).
 *
 * Generic on purpose: this is NOT specific to any one app. Given an optional
 * label, it prefers a configured API-key entry whose id/label best matches that
 * label — so a user can mint a dedicated key per client — and otherwise falls
 * back to the default endpoint key. App configurators (Claude Code, Claude
 * Desktop, …) only WRITE the setting that points their client at this helper
 * (see e.g. `apiKeyHelperCommand`); the resolution itself lives here so every
 * client shares one implementation rather than each reimplementing it.
 */
import type { ApiKeyEntry, AppConfig } from "~/lib/config"

import { getConfig } from "~/lib/config"
import { normalizeApiKeys } from "~/lib/request-auth"

export type ApiKeyHelperResult =
  | { ok: true; key: string; source: "app" | "default" }
  | { ok: false; error: string }

/** The flag maximal exposes for the helper (see src/main.ts). */
const HELPER_FLAG = "--apiKeyHelper"

/**
 * Build the command a client writes into its config to call this helper.
 *
 * We write an ABSOLUTE path to the running binary (`process.execPath`), not a
 * bare `maximal`, because the consumer runs it from a context that does NOT
 * have our PATH: Claude Code invokes `apiKeyHelper` via `/bin/sh -c` (or
 * `cmd.exe` on Windows), and a GUI-launched Claude Code inherits launchd's
 * minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) — never `~/.local/bin`. A bare
 * `maximal` there fails with `command not found` (exit 127). The absolute path
 * is double-quoted so a space in it survives both `sh` and `cmd.exe`.
 *
 * `process.execPath` is the right anchor (vs. the macOS-only `~/.local/bin`
 * symlink, which doesn't exist on Windows): it is absolute on every platform.
 * If the app moves/updates, the path can go stale — boot reconciliation
 * rewrites it to the current execPath (see config.ts `applyProxyBaseUrl` +
 * `isOwnedApiKeyHelper`).
 *
 * The optional `label` lets a user attribute a dedicated key to that client
 * (a key entry whose id/label matches `label` wins over the default key).
 */
export function apiKeyHelperCommand(
  label?: string,
  execPath: string = process.execPath,
): string {
  const trimmed = label?.trim()
  const bin = `"${execPath}"`
  return trimmed ? `${bin} ${HELPER_FLAG} ${trimmed}` : `${bin} ${HELPER_FLAG}`
}

/**
 * Recognize a helper command WE wrote, regardless of which binary path precedes
 * it — i.e. match on the `--apiKeyHelper <label>` signature, not the exact
 * string. This is what lets ownership detection treat a command pointing at a
 * now-stale maximal path as still "ours" (so boot can self-heal it and uninstall
 * can strip it), while leaving a genuinely third-party apiKeyHelper untouched.
 */
export function isOwnedApiKeyHelper(command: unknown, label?: string): boolean {
  if (typeof command !== "string") return false
  const trimmed = label?.trim()
  const suffix = trimmed ? `${HELPER_FLAG} ${trimmed}` : HELPER_FLAG
  // "<path>" --apiKeyHelper <label>  — the binary is quoted, then our flag.
  // Endswith the signature, and contains the flag as a standalone token.
  return new RegExp(`\\s${suffix}\\s*$`, "u").test(command)
}

function normalizeLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[\s_-]+/gu, " ")
    .trim()
}

function isEnabledEntry(entry: ApiKeyEntry): boolean {
  return entry.enabled && entry.key.trim().length > 0
}

/**
 * Score how well an entry's id/label matches the requested label. Exact match
 * wins; a label that's a prefix of the entry (or vice versa) scores lower. 0
 * means no match. Generic — the target is whatever label the client passed,
 * not a hardcoded app name.
 */
function matchScore(value: string, target: string): number {
  const normalized = normalizeLabel(value)
  const t = normalizeLabel(target)
  if (!normalized || !t) return 0
  if (normalized === t) return 100
  if (normalized.startsWith(`${t} `)) return 90
  if (`${t} `.startsWith(`${normalized} `)) return 80
  return 0
}

/** The best enabled entry matching `label`, or null when none match. */
function findEntry(
  entries: Array<ApiKeyEntry>,
  label: string,
): ApiKeyEntry | null {
  let best: { entry: ApiKeyEntry; score: number } | null = null
  for (const entry of entries) {
    if (!isEnabledEntry(entry)) continue
    const score = Math.max(
      matchScore(entry.id, label),
      matchScore(entry.label, label),
    )
    if (score === 0) continue
    if (!best || score > best.score) {
      best = { entry, score }
    }
  }
  return best?.entry ?? null
}

function getDefaultEndpointApiKey(config: AppConfig): string | null {
  const legacy = normalizeApiKeys(config.auth?.apiKeys)
  if (legacy[0]) return legacy[0]

  const fallbackEntry = (config.auth?.apiKeyEntries ?? []).find((entry) =>
    isEnabledEntry(entry),
  )
  return fallbackEntry?.key.trim() ?? null
}

/**
 * Resolve the API key a client should present to the proxy. With a `label`,
 * a matching key entry wins (`source: "app"`); otherwise — or when nothing
 * matches — the default endpoint key is used (`source: "default"`).
 */
export function resolveApiKey(
  label?: string,
  config: AppConfig = getConfig(),
): ApiKeyHelperResult {
  const wanted = label?.trim()
  const entries = config.auth?.apiKeyEntries ?? []
  if (wanted) {
    const appEntry = findEntry(entries, wanted)
    if (appEntry) return { ok: true, key: appEntry.key.trim(), source: "app" }
  }

  const defaultKey = getDefaultEndpointApiKey(config)
  if (defaultKey) return { ok: true, key: defaultKey, source: "default" }

  return {
    ok: false,
    error:
      wanted ?
        `no API key found for "${wanted}" and no default endpoint API key is configured`
      : "no default endpoint API key is configured",
  }
}

/**
 * CLI entry for `maximal --apiKeyHelper [label]`: print the resolved key to
 * stdout (exit 0) or an error to stderr (exit 1). The non-zero exit lets the
 * calling client treat a missing key as a hard failure.
 */
export function runApiKeyHelper(label?: string): number {
  const result = resolveApiKey(label)
  if (result.ok) {
    process.stdout.write(`${result.key}\n`)
    return 0
  }
  process.stderr.write(`ERROR: ${result.error}\n`)
  return 1
}
