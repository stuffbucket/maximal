/**
 * Pure display formatters for the Usage section (spec §4), ported verbatim from
 * the standalone dashboard's render helpers so the numbers read identically. No
 * DOM, no i18n — unit-tested in `tests/usage-format.test.ts`. The React `Usage`
 * feature composes these; the exhaustive tables/meters live in `Usage.tsx`.
 */

/** `total_nano_aiu` is billed in nano-AIU; 1 AIU = 1e9 nano-AIU. */
const NANO_AIU_PER_AIU = 1_000_000_000

/** Locale-grouped integer, e.g. 1234567 → "1,234,567"; non-finite → "0". */
export function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : "0"
}

/**
 * Human cost in AIU. Zero/absent cost is common (many models bill nothing here),
 * so render an em dash rather than "0.000 AIU"/"NaN" (design failure-modes rule).
 * Small values need more digits; trailing zeros are trimmed.
 */
export function formatCostAiu(nanoAiu: number): string {
  if (!Number.isFinite(nanoAiu) || nanoAiu <= 0) {
    return "—"
  }
  const aiu = nanoAiu / NANO_AIU_PER_AIU
  const digits = aiu < 1 ? 4 : 3
  const text = aiu.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  })
  return `${text} AIU`
}

/** A table cell that is a non-empty trimmed string, or an em dash otherwise. */
export function formatCellText(value: unknown): string {
  if (typeof value !== "string") {
    return "—"
  }
  return value.trim() || "—"
}

/** "used / entitlement" quota text; unlimited entitlement shows ∞. */
export function formatQuotaUsed(
  entitlement: number,
  remaining: number,
  unlimited: boolean,
): string {
  if (unlimited) return "0"
  return Math.max(0, entitlement - remaining).toLocaleString()
}

/** Severity of a quota's consumption, driving the progress-bar colour (§4). */
export type QuotaLevel = "ok" | "warn" | "crit" | "unlimited"

/** Display-ready projection of a raw `QuotaDetails` (pure; DOM-free). */
export interface QuotaView {
  readonly percentUsed: number
  readonly level: QuotaLevel
  readonly used: string
  readonly entitlement: string
  readonly remaining: string
}

/**
 * Project a quota snapshot to its display view (ported from the dashboard's
 * `renderQuotaCard` thresholds: >90% crit, >75% warn, unlimited its own state).
 */
export function quotaView(details: {
  entitlement: number
  remaining: number
  percent_remaining: number
  unlimited: boolean
}): QuotaView {
  if (details.unlimited) {
    return {
      percentUsed: 100,
      level: "unlimited",
      used: "∞",
      entitlement: "∞",
      remaining: "∞",
    }
  }
  const percentUsed = 100 - details.percent_remaining
  let level: QuotaLevel = "ok"
  if (percentUsed > 90) level = "crit"
  else if (percentUsed > 75) level = "warn"
  return {
    percentUsed,
    level,
    used: Math.max(0, details.entitlement - details.remaining).toLocaleString(),
    entitlement: details.entitlement.toLocaleString(),
    remaining: details.remaining.toLocaleString(),
  }
}

/**
 * Compact token count for the big live/headline numerals, e.g. 1_234 → "1.2K",
 * 3_400_000 → "3.4M". Keeps the ticking counter from wrapping. Non-finite → "0".
 */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "0"
  const abs = Math.abs(value)
  if (abs < 1000) return String(Math.round(value))
  const units = [
    { size: 1_000_000_000, suffix: "B" },
    { size: 1_000_000, suffix: "M" },
    { size: 1_000, suffix: "K" },
  ]
  for (const { size, suffix } of units) {
    if (abs >= size) {
      const scaled = value / size
      // One decimal below 10 (1.2K), none above (12K) — keeps width stable.
      const text =
        Math.abs(scaled) < 10 ? scaled.toFixed(1) : String(Math.round(scaled))
      return `${text.replace(/\.0$/, "")}${suffix}`
    }
  }
  return String(Math.round(value))
}

/** Human display name for a provider key. The built-in path is "GitHub Copilot";
 *  an external provider is title-cased from its key (e.g. "anthropic" → "Anthropic"). */
export function providerLabel(provider: string): string {
  const key = provider.trim().toLowerCase()
  if (key === "copilot" || key === "") return "GitHub Copilot"
  return key.charAt(0).toUpperCase() + key.slice(1)
}

/** Humanize an endpoint id for display, e.g. "chat_completions" → "Chat". */
export function endpointLabel(endpoint: string): string {
  switch (endpoint) {
    case "chat_completions": {
      return "Chat"
    }
    case "provider_messages":
    case "messages": {
      return "Messages"
    }
    case "responses": {
      return "Responses"
    }
    case "embeddings": {
      return "Embeddings"
    }
    default: {
      return formatCellText(endpoint)
    }
  }
}

/** Short relative age of a timestamp, e.g. "just now", "12s ago", "4m ago".
 *  `now` is injectable for tests. */
export function formatRelativeTime(ms: number, now = Date.now()): string {
  const delta = Math.max(0, now - ms)
  const secs = Math.floor(delta / 1000)
  if (secs < 3) return "just now"
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/** A tokens-per-minute rate label from a token count over a window (ms). */
export function formatRate(tokens: number, windowMs: number): string {
  if (!Number.isFinite(tokens) || !Number.isFinite(windowMs) || windowMs <= 0) {
    return "0/min"
  }
  const perMin = (tokens / windowMs) * 60_000
  return `${formatCompact(perMin)}/min`
}
