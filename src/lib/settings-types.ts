/**
 * Shared type contracts between the proxy and the Tauri shell's
 * Settings UI. The shapes here are the *stable* contract — distinct
 * from `/_debug/state`, which is a free-form dev dump.
 *
 * The zod schemas are the source of truth; inferred TS types are
 * what the shell consumes. The shell can import the inferred type
 * directly (TS-only import; no runtime zod dependency required on
 * the shell side) via a relative path. If/when the shell needs
 * client-side validation, it can add zod as a dep and import the
 * schema too — keeping the same parser on both ends.
 *
 * Field names follow snake_case to match the rest of `/_debug/state`
 * and the Anthropic / OpenAI JSON conventions.
 */

import { z } from "zod"

/** Tail-4 redacted token presence + (when known) source. We do NOT
 *  expose token values, validity windows we don't track, or any
 *  data that could narrow the secret. */
export const TokenStatus = z.object({
  github_token_present: z.boolean(),
  copilot_token_present: z.boolean(),
})
export type TokenStatus = z.infer<typeof TokenStatus>

/** The proxy throttles via a fixed minimum interval between
 *  requests, not a "tokens remaining / resets-at" bucket. The
 *  contract surfaces what actually exists. */
export const RateLimitStatus = z.object({
  /** Minimum seconds between requests, or null when unconfigured. */
  interval_seconds: z.number().nullable(),
  /** ISO timestamp of the last completed request, or null if none yet. */
  last_request_at: z.string().nullable(),
  /** Whether the proxy waits (vs rejects) when over the limit. */
  wait_when_throttled: z.boolean(),
})
export type RateLimitStatus = z.infer<typeof RateLimitStatus>

export const DiagnosticsResponse = z.object({
  version: z.string(),
  source_revision: z.string().nullable(),
  source_branch: z.string().nullable(),
  pid: z.number().int(),
  uptime_ms: z.number().int(),
  account_type: z.string(),
  models_cached: z.number().int(),
  tokens: TokenStatus,
  rate_limit: RateLimitStatus,
})
export type DiagnosticsResponse = z.infer<typeof DiagnosticsResponse>

/** Structured error envelope. Mirrors what Hono routes already emit
 *  via forwardError, so the shell can render either source uniformly. */
export const ApiErrorBody = z.object({
  error: z.object({
    message: z.string(),
    type: z.string().optional(),
  }),
})
export type ApiErrorBody = z.infer<typeof ApiErrorBody>

/** Last non-fatal upstream rejection from a Copilot completion
 *  endpoint (quota exhausted, model not on plan, transient upstream
 *  error). Distinct from `error`/`remediation_url` on AuthStatus
 *  (which are about the GitHub-token state itself) —
 *  `last_upstream_rejection` is a sidecar attached to the most recent
 *  completion attempt and clears on the next successful request.
 *  Rides along on `unauthenticated` and `authenticated` states only;
 *  the pending and error variants don't carry it (a token state issue
 *  takes precedence over a completion-time rejection in the UI). */
export const UpstreamRejection = z.object({
  message: z.string(),
  status: z.number().int(),
  at: z.string(),
  remediation_url: z.string().optional(),
})
export type UpstreamRejection = z.infer<typeof UpstreamRejection>

/** GitHub device-code auth state, exposed by /settings/api/auth/github/*.
 *
 *  Lifecycle:
 *    unauthenticated → device_code_issued → polling → authenticated
 *                                                   ↘ error
 *
 *  Transitions are driven by POST /start (issue), the background
 *  poller (polling → authenticated|error), and POST /sign-out (reset).
 *
 *  Modeled as a discriminated union on `state` (boundary D3, ADR-0006):
 *  each variant declares exactly the data valid in that state, so the
 *  shell narrows by `state` and the renderer is exhaustive. Adding a
 *  new state requires a new variant — the compiler then surfaces every
 *  renderer + controller site that must handle it.
 *
 *  Note on `account_login` for the `authenticated` variant: a real
 *  GitHub login is required by contract. The controller resolves it
 *  before flipping to authenticated (see auth-controller.runPoller).
 *  In the best-effort failure path (sign-in succeeded but
 *  getGitHubUser threw), the controller emits the literal `"unknown"`
 *  string rather than dropping the field — the renderer treats
 *  `"unknown"` as a placeholder trigger. The field is never absent.
 */
export const AuthStatus = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("unauthenticated"),
    last_upstream_rejection: UpstreamRejection.optional(),
  }),
  z.object({
    state: z.literal("device_code_issued"),
    user_code: z.string(),
    verification_uri: z.string(),
    expires_at: z.string(),
  }),
  z.object({
    state: z.literal("polling"),
    user_code: z.string(),
    verification_uri: z.string(),
    expires_at: z.string(),
  }),
  z.object({
    state: z.literal("authenticated"),
    account_login: z.string(),
    last_upstream_rejection: UpstreamRejection.optional(),
  }),
  z.object({
    state: z.literal("error"),
    error: z.string(),
    /** Optional remediation URL surfaced when GHCP rejects our token at
     *  the Copilot exchange (e.g. updated TOS, Copilot settings page).
     *  Present only when GHCP returned a URL in the rejection body. */
    remediation_url: z.string().optional(),
  }),
])
export type AuthStatus = z.infer<typeof AuthStatus>

// ---------------------------------------------------------------------------
// Multi-account roster — Settings → Account quick-switch (slice 3).
//
// The persisted accounts maximal can switch between. Tokens are NEVER
// included — only identity + provenance, like the auth status above redacts
// the credential.
// ---------------------------------------------------------------------------

export const AccountSummary = z.object({
  /** Stable identity key, `login@host`. */
  key: z.string(),
  login: z.string(),
  host: z.string(),
  /** How this account entered the registry. */
  added_via: z.enum(["device-code", "gh-cli", "migration"]),
  obtained_at: z.string(),
  /** Whether this is the account the proxy is (or will boot) signed in as. */
  active: z.boolean(),
})
export type AccountSummary = z.infer<typeof AccountSummary>

export const AccountsListResponse = z.object({
  accounts: z.array(AccountSummary),
  active_key: z.string().nullable(),
})
export type AccountsListResponse = z.infer<typeof AccountsListResponse>

/**
 * An API-key entry as managed by Settings → API clients. The key value
 * is returned in full to the local Settings UI — the endpoint is
 * already auth-gated and loopback-only in normal operation, and the
 * "show/hide" affordance lives in the UI, not the wire format.
 *
 * Key value charset matches `API_KEY_VALUE_PATTERN` in config-schema.ts:
 * 8–128 chars of [A-Za-z0-9_-], or the literal "*" wildcard.
 */
export const ApiKeyEntry = z.object({
  id: z.string(),
  label: z.string(),
  key: z.string(),
  enabled: z.boolean(),
  created_at: z.string(),
})
export type ApiKeyEntry = z.infer<typeof ApiKeyEntry>

export const ApiKeysListResponse = z.object({
  entries: z.array(ApiKeyEntry),
  /** Whether the proxy is currently enforcing API-key auth. False when
   *  both `apiKeys` and `apiKeyEntries` are empty (no enabled keys);
   *  in that mode the proxy accepts all local requests. */
  enforcing: z.boolean(),
})
export type ApiKeysListResponse = z.infer<typeof ApiKeysListResponse>

export const ApiKeyCreateRequest = z.object({
  label: z.string().min(1).max(64),
  /** Optional: if omitted, the server generates one. */
  key: z.string().optional(),
  enabled: z.boolean().optional(),
})
export type ApiKeyCreateRequest = z.infer<typeof ApiKeyCreateRequest>

export const ApiKeyUpdateRequest = z.object({
  label: z.string().min(1).max(64).optional(),
  key: z.string().optional(),
  enabled: z.boolean().optional(),
})
export type ApiKeyUpdateRequest = z.infer<typeof ApiKeyUpdateRequest>

// ---------------------------------------------------------------------------
// Apps integration — Settings → Apps.
//
// An "app" is a downstream tool we can wire to talk to the proxy. Two
// active kinds, distinguished by `kind`:
//   - "config":    a tool we route by editing its config file — Claude
//                  Desktop (claude_desktop_config.json) and Claude Code
//                  (~/.claude/settings.json env.ANTHROPIC_BASE_URL).
//   - "coming-soon": a placeholder card with no wiring yet.
// ---------------------------------------------------------------------------

/** One detected install of a CLI app (display only). */
export const AppInstall = z.object({
  /** Resolved absolute path of the real binary. */
  path: z.string(),
  /** `--version` output, or null when it couldn't be read. */
  version: z.string().nullable(),
  /** How it was installed (homebrew / npm-global / local-bin / …). */
  source: z.enum([
    "homebrew",
    "npm-global",
    "local-bin",
    "claude-local",
    "path",
    "unknown",
  ]),
})
export type AppInstall = z.infer<typeof AppInstall>

/** When set, the UI offers a one-line install command for the app. */
export const AppInstallHint = z.object({
  method: z.string(),
  command: z.string(),
})
export type AppInstallHint = z.infer<typeof AppInstallHint>

export const AppEntry = z.object({
  id: z.enum(["claude-code", "claude-desktop", "copilot-cli"]),
  name: z.string(),
  kind: z.enum(["config", "coming-soon"]),
  /** Whether the integration is currently active (proxy config applied). */
  enabled: z.boolean(),
  status: z.enum(["ready", "not-installed", "coming-soon"]),
  installs: z.array(AppInstall),
  install: AppInstallHint.nullable(),
  /** Non-null when enabling was refused because the app's config already
   *  has a setting we don't own (e.g. a user-set ANTHROPIC_BASE_URL). The
   *  UI surfaces this so the user knows why the toggle didn't take. */
  conflict: z.enum(["foreign-base-url"]).nullable(),
})
export type AppEntry = z.infer<typeof AppEntry>

export const AppsListResponse = z.object({
  apps: z.array(AppEntry),
})
export type AppsListResponse = z.infer<typeof AppsListResponse>

export const ClaudeCodeToggleRequest = z.object({
  enabled: z.boolean(),
})
export type ClaudeCodeToggleRequest = z.infer<typeof ClaudeCodeToggleRequest>

export const ClaudeDesktopToggleRequest = z.object({
  enabled: z.boolean(),
})
export type ClaudeDesktopToggleRequest = z.infer<
  typeof ClaudeDesktopToggleRequest
>
