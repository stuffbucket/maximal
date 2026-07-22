/**
 * Centralized, pure display formatters shared across UI features.
 *
 * These are adapted faithfully from the per-feature helpers that predated this
 * module (`features/models/Models.tsx` and `features/usage/format.ts`) so the
 * numbers and strings read identically after callers migrate. No DOM, no i18n
 * side effects — just typed, deterministic string output.
 */

/** Locale-grouped integer, e.g. 1234567 → "1,234,567"; non-finite → "0". */
export function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : "0"
}

/**
 * Compact token count with a K/M suffix, e.g. 200000 → "200K",
 * 1000000 → "1M", 1500000 → "1.5M". A `null` count (unknown / not
 * applicable) renders an em dash. Values below 1,000 are shown verbatim.
 *
 * Distinct from {@link formatNumber}, which groups the full integer — use
 * this where space is tight (table cells, chips) and precision to the digit
 * is not needed.
 */
export function formatTokensCompact(n: number | null): string {
  if (n === null) return "—"
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

/**
 * Relative age of an ISO timestamp, e.g. "just now", "3 min ago", "2 h ago",
 * "5 d ago". Anything within the last 45 seconds is "just now". A `null`
 * timestamp (never loaded) is the caller's concern — pass a real ISO string.
 */
export function formatRelativeAge(iso: string): string {
  const then = new Date(iso).getTime()
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 45) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return `${days} d ago`
}
