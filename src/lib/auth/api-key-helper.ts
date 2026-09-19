/**
 * API-key helpers shared by client integrations and the `maximal api` command.
 *
 * Given an optional label, resolution prefers a configured API-key entry whose
 * id/label best matches that label and otherwise falls back to the default
 * endpoint key. Claude Code writes the resolved value as an echo command so its
 * settings survive maximal binary upgrades; older binary-backed commands remain
 * recognizable for migration.
 */
import type { ApiKeyEntry, AppConfig } from "~/lib/config/config"

import {
  HELPER_SUBCOMMAND,
  LEGACY_HELPER_FLAG,
} from "~/lib/auth/api-key-helper-tokens"
import { normalizeApiKeys } from "~/lib/auth/request-auth"
import { getConfig } from "~/lib/config/config"

export type ApiKeyHelperResult =
  | { ok: true; key: string; source: "app" | "default" }
  | { ok: false; error: string }

/** Build the binary-backed helper form written before v0.4.42. */
export function apiKeyHelperCommand(
  label?: string,
  execPath: string = process.execPath,
): string {
  const trimmed = label?.trim()
  const bin = `"${execPath}"`
  return trimmed ?
      `${bin} ${HELPER_SUBCOMMAND} ${trimmed}`
    : `${bin} ${HELPER_SUBCOMMAND}`
}

export function echoApiKeyHelperCommand(
  key: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    // Claude Code invokes the helper through cmd.exe on Windows, where POSIX
    // single quotes are literal. Base64 keeps legacy free-form keys out of cmd
    // and PowerShell syntax while emitting the exact key without quote marks.
    const encoded = Buffer.from(key, "utf8").toString("base64")
    return (
      "powershell.exe -NoProfile -NonInteractive -Command "
      + `"[Console]::Out.Write([Text.Encoding]::UTF8.GetString(`
      + `[Convert]::FromBase64String('${encoded}')))"`
    )
  }

  // Single-quote for POSIX shells; close/escape/reopen defensively for legacy
  // free-form keys even though newly-created keys use a restricted charset.
  const quoted = key.replaceAll("'", `'"'"'`)
  return `echo '${quoted}'`
}

/**
 * Recognize a helper command WE wrote, regardless of which binary path precedes
 * it — matching on the invocation SIGNATURE, not the exact string. Accepts BOTH
 * the current `api <label>` form and the legacy `--apiKeyHelper <label>` form,
 * so a config written by an older maximal is still ours (boot migrates it to
 * the stable helper form; uninstall strips it), while a genuinely
 * third-party helper is left untouched.
 *
 * The `api <label>` form is anchored on the quoted-path prefix (`"…" api
 * <label>`) — the bare-word `api` is common enough that matching it unanchored
 * could misfire on a foreign `some-tool api foo`. The legacy flag stays matched
 * by its distinctive `--apiKeyHelper` token (unanchored, as before, so a
 * bare-`maximal` legacy string keeps upgrading).
 */
export function isOwnedApiKeyHelper(command: unknown, label?: string): boolean {
  if (typeof command !== "string") return false
  const trimmed = label?.trim()
  // Legacy: "<path>" --apiKeyHelper <label>  — flag as a standalone trailing token.
  const legacySuffix =
    trimmed ? `${LEGACY_HELPER_FLAG} ${trimmed}` : LEGACY_HELPER_FLAG
  if (new RegExp(`\\s${escapeRegExp(legacySuffix)}\\s*$`, "u").test(command)) {
    return true
  }
  // Current: "<abs-path>" api <label> — anchored on a quoted path so a foreign
  // `tool api foo` can't match.
  const apiSuffix =
    trimmed ? `${HELPER_SUBCOMMAND} ${trimmed}` : HELPER_SUBCOMMAND
  if (
    new RegExp(`^"[^"]+"\\s+${escapeRegExp(apiSuffix)}\\s*$`, "u").test(command)
  ) {
    return true
  }

  const runtimeMatch = new RegExp(
    `^"[^"]+"\\s+"([^"]+)"\\s+${escapeRegExp(apiSuffix)}\\s*$`,
    "u",
  ).exec(command)
  return (
    runtimeMatch?.[1]?.replaceAll("\\", "/").endsWith("/maximal/src/main.ts")
    ?? false
  )
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)
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
