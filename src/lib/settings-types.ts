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
