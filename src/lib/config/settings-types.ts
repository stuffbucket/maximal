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

/** Which executor resolves web_search / web_fetch tool calls for Claude
 *  clients. `kind` is the executor class (stable, matches
 *  `/_debug/state`); `detail` is the human-readable model/base/notes from
 *  describeExecutor (e.g. the /responses model or "no key"). */
export const WebSearchStatus = z.object({
  kind: z.string(),
  detail: z.string().nullable(),
})
export type WebSearchStatus = z.infer<typeof WebSearchStatus>

export const DiagnosticsResponse = z.object({
  version: z.string(),
  source_revision: z.string().nullable(),
  source_branch: z.string().nullable(),
  /** Absolute path the running sidecar was launched from
   *  (`process.execPath`). Distinguishes a DMG-app launch from a
   *  Homebrew / dev / standalone one in bug reports. */
  launch_path: z.string(),
  /** Coarse classification of `launch_path`. */
  launch_kind: z.enum(["dmg-app", "homebrew", "user-bin", "dev", "other"]),
  pid: z.number().int(),
  uptime_ms: z.number().int(),
  account_type: z.string(),
  models_cached: z.number().int(),
  tokens: TokenStatus,
  rate_limit: RateLimitStatus,
  web_search: WebSearchStatus,
})
export type DiagnosticsResponse = z.infer<typeof DiagnosticsResponse>

/** Update-availability status — GET /settings/api/update-status. Best-effort:
 *  `latest` is null and `update_available` false whenever the check is disabled
 *  or the manifest fetch failed. `url` is the install-channel-neutral download
 *  page (mxml.sh), not a raw release asset. The `enabled` / `checked_at` /
 *  `last_error` fields are diagnostic — they let the Settings UI show whether
 *  the mechanism is working and what it last reported. See update-check.ts. */
export const UpdateStatusResponse = z.object({
  current: z.string(),
  latest: z.string().nullable(),
  update_available: z.boolean(),
  url: z.string(),
  enabled: z.boolean(),
  checked_at: z.string().nullable(),
  last_error: z.string().nullable(),
})
export type UpdateStatusResponse = z.infer<typeof UpdateStatusResponse>

/** A model's distilled capability flags — the "key capabilities" the
 *  Settings UI surfaces (not the full upstream model card). Each is a
 *  plain boolean derived from `capabilities.supports.*`, so the shell
 *  can render a compact flag row without knowing Copilot's schema. */
export const ModelCapabilityFlags = z.object({
  vision: z.boolean(),
  tool_calls: z.boolean(),
  streaming: z.boolean(),
  /** Reasoning / extended-thinking support (adaptive_thinking or a
   *  declared reasoning_effort ladder). */
  reasoning: z.boolean(),
})
export type ModelCapabilityFlags = z.infer<typeof ModelCapabilityFlags>

/** One row in the Settings → Models list. A flattened, UI-shaped view
 *  of the upstream `Model` (src/services/copilot/get-models.ts) — only
 *  the fields the section actually renders, snake_cased per the
 *  contract convention. */
export const ModelSummary = z.object({
  id: z.string(),
  name: z.string(),
  vendor: z.string(),
  family: z.string(),
  /** Upstream `capabilities.type` — "chat", "embeddings", etc. The UI
   *  groups by this. */
  type: z.string(),
  preview: z.boolean(),
  /** Max context window in tokens, or null when upstream omits it. */
  context_window_tokens: z.number().int().nullable(),
  /** Max output tokens, or null when upstream omits it. */
  max_output_tokens: z.number().int().nullable(),
  capabilities: ModelCapabilityFlags,
})
export type ModelSummary = z.infer<typeof ModelSummary>

/** Response of GET/POST `/settings/api/models`. Carries the cached
 *  catalog plus its freshness so the UI can show staleness and offer a
 *  manual refresh. `loaded_at` is null before the first successful
 *  fetch. */
export const ModelsListResponse = z.object({
  models: z.array(ModelSummary),
  count: z.number().int(),
  /** ISO timestamp of when the cache was last populated, or null. */
  loaded_at: z.string().nullable(),
})
export type ModelsListResponse = z.infer<typeof ModelsListResponse>

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

/** The hysteresis-resolved network-issue signal for the banner. Distinct from
 *  `last_upstream_rejection` (a completion-time rejection) and from the auth
 *  `error` state (a token problem): this says "we can't reach the service" and
 *  the token may be perfectly fine. Carries ONLY the typed discriminant + scope
 *  — no user-facing prose. The shell builds the message via i18n keyed on
 *  `(kind, scope)` (and, for `scope-unreachable`, tailors copy by `account_type`
 *  on the authenticated variant). Rides on the `authenticated` AND
 *  `unauthenticated` variants so the banner works signed-out. Present only when
 *  a failure has persisted past the onset window; cleared on recovery.
 *
 *  `kind` values MIRROR `NETWORK_DIAGNOSIS_KIND` and `scope` MIRRORS
 *  `NETWORK_SCOPE` (both in `~/lib/net/network-diagnostics`). The literals are
 *  DELIBERATELY re-declared here rather than imported: this wire-type module is
 *  consumed by the Tauri shell, and importing network-diagnostics (which pulls
 *  `node:dns`/`node:net`/`node:os`) would drag those into the browser bundle.
 *  A drift guard in `tests/network-hysteresis.test.ts` fails the build if these
 *  fall out of sync with the source-of-truth constants. */
export const NetworkDiagnosisSignal = z.object({
  kind: z.enum(["offline", "dns-failure", "scope-unreachable", "unknown"]),
  scope: z.enum(["github-copilot-auth"]).nullable(),
})
export type NetworkDiagnosisSignal = z.infer<typeof NetworkDiagnosisSignal>

/** Account plan type, mirroring `AccountType` (individual|business|enterprise).
 *  Surfaced on the `authenticated` variant so the shell can tailor the
 *  network-banner copy (e.g. an enterprise-specific restart nudge). Nullable
 *  because a session may not have resolved a plan yet. */
export const AccountTypeWire = z.enum(["individual", "business", "enterprise"])
export type AccountTypeWire = z.infer<typeof AccountTypeWire>

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
    /** Network-issue banner signal — present when a failure has persisted past
     *  the onset window. Rides on the signed-out variant so the banner works
     *  before sign-in. */
    network_diagnosis: NetworkDiagnosisSignal.optional(),
    /** Transient: true on the single event that recovers a long outage, telling
     *  the shell to fire a "reconnected" OS notification. Not part of steady
     *  state — the very next event omits it. */
    notify_on_reconnect: z.boolean().optional(),
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
    /** Profile photo URL from the GitHub `/user` API (`avatar_url`). Optional:
     *  a cold-boot session that couldn't re-fetch the user, or a pre-field
     *  account, omits it and the UI falls back to a typographic initial. Using
     *  the API URL (not `github.com/<login>.png`) is what makes EMU avatars
     *  resolve. */
    account_avatar_url: z.string().optional(),
    /** ISO timestamp of when this session became authenticated — the anchor
     *  for the "Connected · <uptime>" line. Optional for the same cold-boot /
     *  legacy reasons; the UI just shows "Connected" without a duration. */
    connected_since: z.string().optional(),
    /** The account's plan type — lets the shell tailor the network-banner copy
     *  (e.g. the enterprise restart nudge). Null when unresolved. */
    account_type: AccountTypeWire.nullable(),
    last_upstream_rejection: UpstreamRejection.optional(),
    /** Network-issue banner signal — see the unauthenticated variant. */
    network_diagnosis: NetworkDiagnosisSignal.optional(),
    /** Transient reconnect-notification flag — see the unauthenticated variant. */
    notify_on_reconnect: z.boolean().optional(),
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
   *  has a setting we don't own (e.g. a user-set ANTHROPIC_BASE_URL or
   *  apiKeyHelper). The UI surfaces this so the user knows why the toggle
   *  didn't take. */
  conflict: z.enum(["foreign-base-url", "foreign-api-key-helper"]).nullable(),
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
