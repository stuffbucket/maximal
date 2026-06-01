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

/** GitHub device-code auth state, exposed by /settings/api/auth/github/*.
 *
 *  Lifecycle:
 *    unauthenticated → device_code_issued → polling → authenticated
 *                                                   ↘ error
 *
 *  Transitions are driven by POST /start (issue), the background
 *  poller (polling → authenticated|error), and POST /sign-out (reset).
 *
 *  The shape mirrors the device-code fields exactly so the shell never
 *  has to reconstruct the verification URL or guess at expiry. */
export const AuthStatus = z.object({
  state: z.enum([
    "unauthenticated",
    "device_code_issued",
    "polling",
    "authenticated",
    "error",
  ]),
  user_code: z.string().optional(),
  verification_uri: z.string().optional(),
  expires_at: z.string().optional(),
  account_login: z.string().optional(),
  error: z.string().optional(),
  /** Optional remediation URL surfaced when GHCP rejects our token at
   *  the Copilot exchange (e.g. updated TOS, Copilot settings page).
   *  Present only in the `error` state and only when GHCP returned a
   *  URL in the rejection body. */
  remediation_url: z.string().optional(),
  /** Last non-fatal upstream rejection from a Copilot completion
   *  endpoint (quota exhausted, model not on plan, transient upstream
   *  error). Distinct from `error`/`remediation_url` (which are about
   *  the GitHub-token state itself) — `last_upstream_rejection` is a
   *  sidecar attached to the most recent completion attempt and clears
   *  on the next successful request. Surfaced as a banner in the
   *  Settings UI without changing the authenticated state. */
  last_upstream_rejection: z
    .object({
      message: z.string(),
      status: z.number().int(),
      at: z.string(),
      remediation_url: z.string().optional(),
    })
    .optional(),
})
export type AuthStatus = z.infer<typeof AuthStatus>

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
