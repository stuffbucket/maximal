/**
 * Shell-local mirror of the sidecar's token-usage response shapes
 * (`src/lib/token-usage/store.ts`). Declared here — not imported — because
 * `store.ts` pulls in `~/`-aliased sidecar-only modules (sqlite, paths) the shell
 * tsconfig can't resolve; the same reason `feed-types.ts` declares its client
 * shapes locally. Keep in sync with the store's `TokenUsageSummary` (the
 * `/token-usage` GET body).
 */

export interface TokenUsageTotals {
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  input_tokens: number;
  output_tokens: number;
  request_count: number;
  total_tokens: number;
  total_nano_aiu: number;
}

export interface TokenUsageModelSummary extends TokenUsageTotals {
  model: string;
  is_premium: boolean | null;
}

export interface TokenUsageSummary {
  byModel: Array<TokenUsageModelSummary>;
  period: string;
  range: {
    end_ms: number;
    end_utc: string;
    start_ms: number;
    start_utc: string;
  };
  totals: TokenUsageTotals;
}
