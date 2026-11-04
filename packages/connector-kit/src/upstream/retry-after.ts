const DELTA_SECONDS = /^\d+(?:\.\d+)?$/

/**
 * `Retry-After` as milliseconds: delta-seconds (integer or decimal) or an
 * HTTP-date relative to `now` (a date in the past is 0). Anything else —
 * missing, negative, garbage — is `undefined`. Not capped: the caller
 * decides whether a long hint is worth waiting for.
 */
export function parseRetryAfter(
  value: string | number | null | undefined,
  now: number,
): number | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === "number")
    return Number.isFinite(value) && value >= 0 ?
        Math.ceil(value * 1000)
      : undefined
  const trimmed = value.trim()
  if (DELTA_SECONDS.test(trimmed)) return Math.ceil(Number(trimmed) * 1000)
  // An HTTP-date always names a weekday or month; this also keeps "-5" or
  // "2024" from parsing as a date.
  if (!/[a-z]{3}/i.test(trimmed)) return undefined
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - now)
}
