/**
 * The sentences a refusal says, in the display unit (US dollars by default).
 * Pure.
 */

import type { RefusalUnit } from "./metric"

import { nanoAiuToDisplay, type BudgetDisplay } from "./units"

/** `$0.03`, `$0.006`, or `0.03 AI credits` in the credits unit. */
export function formatAmount(nanoAiu: number, display: BudgetDisplay): string {
  const value = nanoAiuToDisplay(nanoAiu, display)
  const text =
    value === 0 || value >= 0.01 ?
      value.toFixed(2)
    : String(Number(value.toPrecision(2)))
  return display.unit === "usd" ? `$${text}` : `${text} AI credits`
}

/** `950`, `12.3k`, `2M`: three significant digits. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens))
  const thousands = Number((tokens / 1e3).toPrecision(3))
  if (thousands < 1000) return `${thousands}k`
  const millions = Number((tokens / 1e6).toPrecision(3))
  if (millions < 1000) return `${millions}M`
  return `${Number((tokens / 1e9).toPrecision(3))}B`
}

const TOKEN_NOUN = {
  input_tokens: "input tokens",
  output_tokens: "output tokens",
  total_tokens: "tokens",
} as const

/** An amount in a limit's own unit: money, tokens or requests. */
export function formatUnitAmount(
  amount: number,
  unit: RefusalUnit,
  display: BudgetDisplay,
): string {
  if (unit === "nano_aiu") return formatAmount(amount, display)
  if (unit === "requests") {
    return `${amount} ${amount === 1 ? "request" : "requests"}`
  }
  return `${formatTokens(amount)} ${TOKEN_NOUN[unit]}`
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 48) return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
  return `${Math.round(hours / 24)} days`
}

export interface RefusalWords {
  /** The limit's label, else its id. */
  name: string
  /** What the figures are in. */
  unit: RefusalUnit
  limit: number
  used: number
  held: number
  requested: number
  resetsAtMs: number | null
  nowMs: number
  inFlight: boolean
  display: BudgetDisplay
  /** Set for a rolling window: how long spend counts. */
  rollingMs?: number
}

/** What a rolling window counts, as a sentence starts. */
const COUNTED_NOUN: Record<RefusalUnit, string> = {
  nano_aiu: "Spend",
  requests: "Requests",
  input_tokens: "Usage",
  output_tokens: "Usage",
  total_tokens: "Usage",
}

function resetSentence(words: RefusalWords): string {
  if (words.inFlight) return "Try again in a moment."
  if (words.rollingMs !== undefined) {
    const counts = `${COUNTED_NOUN[words.unit]} counts for ${formatDuration(words.rollingMs)}.`
    if (words.resetsAtMs === null) return counts
    const iso = new Date(words.resetsAtMs).toISOString()
    return `${counts} The oldest ages out ${iso} (in ${formatDuration(words.resetsAtMs - words.nowMs)}).`
  }
  if (words.resetsAtMs === null) return "It never resets."
  const iso = new Date(words.resetsAtMs).toISOString()
  return `Resets ${iso} (in ${formatDuration(words.resetsAtMs - words.nowMs)}).`
}

/** The refusal as one message. Ends with where to change the limit. */
export function refusalMessage(words: RefusalWords): string {
  const { display } = words
  const amount = (value: number) => formatUnitAmount(value, words.unit, display)
  const blockedLead = `Maximal rule "${words.name}" blocked this request:`
  if (words.unit === "requests") {
    // A request cap: "it has made 200 of its 200 requests".
    const lead = `${blockedLead} it has made ${words.used} of its ${amount(words.limit)}.`
    return `${lead} ${resetSentence(words)} Raise or remove it in Maximal → Rules.`
  }
  const need =
    words.requested > 0 ?
      `the request needs about ${amount(words.requested)}`
    : ""
  const blocked = `Maximal rule "${words.name}" blocked this request:`
  const figures = `${amount(words.used)} of ${amount(words.limit)} used`
  let lead: string
  if (words.inFlight) {
    const left = amount(Math.max(0, words.limit - words.used))
    lead = `${blocked} it has ${left} left, and requests in progress already hold ${amount(words.held)} of it${need ? `; ${need}` : ""}.`
  } else if (words.used >= words.limit) {
    lead = `${blocked} it is used up (${figures})${need ? `; ${need}` : ""}.`
  } else {
    lead = `${blocked} ${figures}, and ${need}.`
  }
  return `${lead} ${resetSentence(words)} Raise or remove it in Maximal → Rules.`
}
