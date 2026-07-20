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
import { randomBytes, randomUUID } from "node:crypto"

import type { ApiKeyEntry, AppConfig } from "~/lib/config/config"

import {
  HELPER_SUBCOMMAND,
  LEGACY_HELPER_FLAG,
} from "~/lib/auth/api-key-helper-tokens"
import { normalizeApiKeys } from "~/lib/auth/request-auth"
import { getConfig, writeConfig } from "~/lib/config/config"

export type ApiKeyHelperResult =
  | { ok: true; key: string; source: "app" | "default" }
  | { ok: false; error: string }

/**
 * Build the command a client writes into its config to call this helper.
 *
 * We write an ABSOLUTE path to the running binary (`process.execPath`), not a
 * bare `maximal`, because the consumer runs it from a context that does NOT
 * have our PATH: Claude Code invokes the helper via `/bin/sh -c` (or `cmd.exe`
 * on Windows), and a GUI-launched Claude Code inherits launchd's minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`) — never `~/.local/bin`. A bare `maximal`
 * there fails with `command not found` (exit 127). The absolute path is
 * double-quoted so a space in it survives both `sh` and `cmd.exe`.
 *
 * `process.execPath` is the right anchor (vs. the macOS-only `~/.local/bin`
 * symlink, which doesn't exist on Windows) — BUT only when we ARE the maximal
 * binary, i.e. the compiled single-file sidecar (`bun build --compile`). When
 * maximal runs under a RUNTIME (dev, `bun run …`, any bun/node-launched CLI),
 * `process.execPath` is the runtime, not maximal — writing `"…/bun" api <label>`
 * would make the client run `bun api <label>` (bun tries to exec a script named
 * `api`, which fails). So in the runtime case we emit `"<runtime>" "<entry>"
 * api <label>` (with the entry script from `Bun.main`/`process.argv[1]`), which
 * actually invokes maximal's CLI. The packaged app heals this back to the stable
 * single-token compiled path on the next boot (see config.ts `applyProxyBaseUrl`
 * + `isOwnedApiKeyHelper`, which recognizes both forms as ours).
 *
 * The optional `label` lets a user attribute a dedicated key to that client
 * (a key entry whose id/label matches `label` wins over the default key), and
 * is the client id citty dispatches on (`maximal api <label>`).
 */
export function apiKeyHelperCommand(
  label?: string,
  execPath: string = process.execPath,
  mainScript: string | undefined = resolveMainScript(),
): string {
  const trimmed = label?.trim()
  const bin =
    isRuntimeExecPath(execPath) && mainScript ?
      `"${execPath}" "${mainScript}"`
    : `"${execPath}"`
  return trimmed ?
      `${bin} ${HELPER_SUBCOMMAND} ${trimmed}`
    : `${bin} ${HELPER_SUBCOMMAND}`
}

/** True when `execPath` is a bare JS runtime (bun/node) rather than a compiled
 *  maximal binary. Basename check, tolerant of a Windows `.exe` suffix and
 *  either path separator (so it's correct regardless of the host platform); the
 *  compiled sidecar's basename is `maximal` / `maximal-<triple>`, never these. */
function isRuntimeExecPath(execPath: string): boolean {
  const base =
    execPath
      .split(/[/\\]/u)
      .pop()
      ?.toLowerCase()
      .replace(/\.exe$/u, "") ?? ""
  return base === "bun" || base === "node"
}

/** The entry script maximal was launched with, so a runtime invocation can be
 *  reconstructed as `"<runtime>" "<entry>" …`. `Bun.main` is set under bun
 *  (including `bun run src/main.ts`); `process.argv[1]` covers node. Only
 *  consulted when {@link isRuntimeExecPath} is true, so the compiled binary's
 *  `$bunfs` `Bun.main` is never written to disk. */
function resolveMainScript(): string | undefined {
  // casts-keep: `Bun.main` is an optional runtime global (absent under node).
  const bunMain = (globalThis as { Bun?: { main?: string } }).Bun?.main
  if (typeof bunMain === "string" && bunMain.length > 0) return bunMain
  return process.argv[1]
}

/**
 * Recognize a helper command WE wrote, regardless of which binary path precedes
 * it — matching on the invocation SIGNATURE, not the exact string. Accepts BOTH
 * the current `api <label>` form and the legacy `--apiKeyHelper <label>` form,
 * so a config written by an older maximal is still ours (boot self-heals it
 * forward to the `api` form; uninstall strips it), while a genuinely
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
  // Current: "<abs-path>" api <label>  — or the runtime two-token form
  // "<runtime>" "<entry>" api <label>. Anchored on a leading quoted path so a
  // foreign `tool api foo` can't match; the optional second quoted token covers
  // a dev/bun invocation, which boot reconciliation heals to the single-token
  // compiled path.
  const apiSuffix =
    trimmed ? `${HELPER_SUBCOMMAND} ${trimmed}` : HELPER_SUBCOMMAND
  return new RegExp(
    `^"[^"]+"(?:\\s+"[^"]+")?\\s+${escapeRegExp(apiSuffix)}\\s*$`,
    "u",
  ).test(command)
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
 * Generate a random API-key value: `mxl_` + 24 bytes base64url (32 chars).
 * base64url is [A-Za-z0-9_-], so the result already satisfies
 * `API_KEY_VALUE_PATTERN`. The `mxl_` prefix makes an accidental commit
 * greppable. Single source for BOTH the Settings "generate key" route and the
 * auto-minted default endpoint key (see `ensureDefaultEndpointKey`).
 */
export function generateApiKeyValue(): string {
  return `mxl_${randomBytes(24).toString("base64url")}`
}

/** Injectable seams for {@link ensureDefaultEndpointKey} — real config/FS by
 *  default, overridable in tests so no on-disk config is touched. */
export interface EnsureDefaultKeyDeps {
  read?: () => AppConfig
  write?: (config: AppConfig) => void
  mintKey?: () => string
  newId?: () => string
  now?: () => string
}

/**
 * Guarantee a resolvable default endpoint key exists, minting one if not.
 *
 * A config app with an `apiKeyLabel` points its client at `maximal api <label>`,
 * which falls back to the default endpoint key when no per-app key matches. If
 * NO key is configured at all, that fallback is empty and the helper exits 1 —
 * so the client's `apiKeyHelper` hard-fails even though the proxy accepts
 * key-less requests while enforcement is off. Enabling such an app (and boot
 * reconciliation) calls this so the client always has a usable key, and so
 * turning on "Block unknown connections" later can't lock out a client that was
 * already wired up.
 *
 * Idempotent: a no-op when any enabled endpoint key (legacy `auth.apiKeys` or an
 * enabled `apiKeyEntries` entry) already exists. Labeled "Default" (generic) so
 * it is the shared fallback, not coupled to any one app.
 */
export function ensureDefaultEndpointKey(
  deps: EnsureDefaultKeyDeps = {},
): void {
  const read = deps.read ?? getConfig
  const write = deps.write ?? writeConfig
  const mintKey = deps.mintKey ?? generateApiKeyValue
  const newId = deps.newId ?? randomUUID
  const now = deps.now ?? (() => new Date().toISOString())

  const config = read()
  if (getDefaultEndpointApiKey(config) !== null) return

  const entry: ApiKeyEntry = {
    id: newId(),
    label: "Default",
    key: mintKey(),
    enabled: true,
    created_at: now(),
  }
  write({
    ...config,
    auth: {
      ...config.auth,
      apiKeyEntries: [...(config.auth?.apiKeyEntries ?? []), entry],
    },
  })
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
