/**
 * Shell-local mirror of the sidecar's token-usage response shapes
 * (`src/lib/token-usage/store.ts`) and the live feed's usage payload
 * (`src/lib/ws/feed-types.ts`). Declared here — not imported — because those
 * modules pull in `~/`-aliased sidecar-only code the shell tsconfig can't
 * resolve. Keep in sync with the store's `TokenUsageSummary` / `TokenUsageSeries`
 * and the feed's `UsageSnapshot` / `UsageLastEvent`.
 */

export type UsagePeriod = "day" | "week" | "month" | "all"

/** Upstream a request went to: the built-in Copilot path or an external provider. */
export type UsageSource = "copilot" | "provider"

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

/** Per-provider rollup (`GROUP BY source, provider_name`). `provider` is the
 *  stable display key: `copilot` for the built-in path, else the provider name. */
export interface TokenUsageProviderSummary extends TokenUsageTotals {
  source: UsageSource
  provider_name: string | null
  provider: string
}

export interface TokenUsageSummary {
  byModel: Array<TokenUsageModelSummary>
  byProvider: Array<TokenUsageProviderSummary>
  period: UsagePeriod
  range: {
    end_ms: number
    end_utc: string
    start_ms: number
    start_utc: string
  }
  totals: TokenUsageTotals
}

/** One fixed-width time bucket of the usage series (`/token-usage/series`). */
export interface TokenUsageSeriesBucket extends TokenUsageTotals {
  bucket_start_ms: number
}

export interface TokenUsageSeries {
  buckets: Array<TokenUsageSeriesBucket>
  bucket_ms: number
  period: UsagePeriod
  range: {
    end_ms: number
    end_utc: string
    start_ms: number
    start_utc: string
  }
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

/** One recent request row from `/token-usage/events`. Now carries the provider
 *  dimension (`source` / `provider_name`) surfaced in the events table. */
export interface TokenUsageEvent {
  created_at_utc: string
  created_at_ms: number
  endpoint: string
  model: string
  source: UsageSource
  provider_name: string | null
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

/**
 * The just-recorded request carried on a live `usage` feed frame — mirror of the
 * sidecar's `UsageLastEvent` (camelCase, the wire shape). Drives the live pulse
 * + rolling stream without a refetch.
 */
export interface UsageLastEvent {
  model: string
  source: UsageSource
  providerName: string | null
  endpoint: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  createdAtMs: number
}

/** The live `usage` feed payload (mirror of the sidecar's `UsageSnapshot`). */
export interface UsageLiveSnapshot {
  periodStart: string
  periodEnd: string
  totalTokens: number
  requestCount: number
  lastEvent: UsageLastEvent | null
}
