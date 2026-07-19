/**
 * Shell-local mirror of the sidecar's token-usage response shapes
 * (`src/lib/token-usage/store.ts`). Declared here — not imported — because
 * `store.ts` pulls in `~/`-aliased sidecar-only modules (sqlite, paths) the shell
 * tsconfig can't resolve; the same reason `feed-types.ts` declares its client
 * shapes locally. Keep in sync with the store's `TokenUsageSummary` (the
 * `/token-usage` GET body).
 */

export interface TokenUsageTotals {
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  input_tokens: number
  output_tokens: number
  request_count: number
  total_tokens: number
  total_nano_aiu: number
}

export interface TokenUsageModelSummary extends TokenUsageTotals {
  model: string
  is_premium: boolean | null
}

export interface TokenUsageSummary {
  byModel: Array<TokenUsageModelSummary>
  period: string
  range: {
    end_ms: number
    end_utc: string
    start_ms: number
    start_utc: string
  }
  totals: TokenUsageTotals
}

/** One entitlement snapshot from `/usage` (`quota_snapshots[<name>]`). */
export interface QuotaDetails {
  entitlement: number
  remaining: number
  percent_remaining: number
  unlimited: boolean
}

/** The `/usage` response (the quota half of the dashboard, §4). */
export interface UsageData {
  quota_snapshots?: Record<string, QuotaDetails> | null
}

/** One recent request row from `/token-usage/events`. */
export interface TokenUsageEvent {
  created_at_utc: string
  created_at_ms: number
  endpoint: string
  model: string
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

/** A page of recent events from `/token-usage/events`. */
export interface TokenUsageEventsPage {
  items: Array<TokenUsageEvent>
  page: number
  total: number
  total_pages: number
}
