import { z } from "zod"

/**
 * The `GET /token-usage/sessions` response: every session active in the last
 * 24 h with its rate, cache state and context fill. Shared by the route, which
 * validates what it serves, and the Dashboard, which validates what it reads.
 */

export const SessionClient = z.enum([
  "claude-code",
  "claude-desktop",
  "codex",
  "other",
])

export const SessionWindowSource = z.enum([
  "codex-catalog",
  "claude-1m",
  "models-endpoint",
  "model-listing",
])

const MinuteBucket = z.object({
  start_ms: z.number(),
  total_tokens: z.number(),
})

const Session = z.object({
  /** session_id, or "other:<client>" for requests with no session. */
  id: z.string(),
  client: SessionClient,
  client_label: z.string().nullable(),
  /** Model of the latest request. */
  model: z.string(),
  started_at_ms: z.number(),
  last_request_at_ms: z.number(),
  state: z.enum(["streaming", "warm", "cold"]),
  /** Tokens per minute, the mean of the last 5 one-minute buckets. */
  rate_per_min: z.number(),
  /** The last 15 minutes, the same buckets as the summary's recent_minutes. */
  minutes: z.array(MinuteBucket),
  /** Last 24 h. */
  total_tokens: z.number(),
  request_count: z.number(),
  cache: z.object({
    /** 0 = nothing cached. */
    ttl_s: z.number(),
    expires_at_ms: z.number().nullable(),
    /** estimated = an automatic cache (GPT) or a lifetime nobody asked for. */
    confidence: z.enum(["observed", "requested", "estimated"]),
    last_cache_read_tokens: z.number(),
  }),
  context: z.object({
    used_tokens: z.number(),
    window_tokens: z.number().nullable(),
    ceiling_tokens: z.number().nullable(),
    /** Codex only. */
    compact_at_tokens: z.number().nullable(),
    window_source: SessionWindowSource,
    compacted_at_ms: z.number().nullable(),
  }),
})

export const SessionsResponse = z.object({
  /** Whole system: tokens in the trailing 60 s, plus output tokens streamed
   *  so far by requests in flight. */
  flow_per_min: z.number(),
  sessions: z.array(Session),
})

export type SessionsResponse = z.infer<typeof SessionsResponse>
export type SessionView = SessionsResponse["sessions"][number]
