/** One minute of token usage, keyed by the minute's start. */
export interface MinuteBucket {
  start_ms: number
  total_tokens: number
}

export const MINUTE_MS = 60_000
/** How many one-minute buckets the Dashboard's rate views cover. */
export const RECENT_MINUTES = 15

/** The start of the minute containing `ms`. */
export function minuteStartMs(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS
}

/** RECENT_MINUTES zeroed buckets ending with the current minute, oldest first. */
export function emptyRecentMinutes(nowMs: number): Array<MinuteBucket> {
  const current = minuteStartMs(nowMs)
  return Array.from({ length: RECENT_MINUTES }, (_, i) => ({
    start_ms: current - (RECENT_MINUTES - 1 - i) * MINUTE_MS,
    total_tokens: 0,
  }))
}

/** Add tokens to the bucket for `atMs`; a time outside the buckets is ignored. */
export function addToRecentMinutes(
  buckets: Array<MinuteBucket>,
  atMs: number,
  totalTokens: number,
): void {
  const start = minuteStartMs(atMs)
  const bucket = buckets.find((b) => b.start_ms === start)
  if (bucket) bucket.total_tokens += totalTokens
}
