/**
 * The sentences a refusal says, in the display unit (US dollars by default).
 * Pure.
 */

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

function resetSentence(words: RefusalWords): string {
  if (words.inFlight) return "Try again in a moment."
  if (words.rollingMs !== undefined) {
    const counts = `Spend counts for ${formatDuration(words.rollingMs)}.`
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
  const amount = (nano: number) => formatAmount(nano, display)
  const need =
    words.requested > 0 ?
      `this request needs about ${amount(words.requested)}`
    : ""
  let lead: string
  if (words.inFlight) {
    const left = amount(Math.max(0, words.limit - words.used))
    lead = `Maximal rule "${words.name}" has ${left} left, and requests in progress already hold ${amount(words.held)} of it${need ? `; ${need}` : ""}.`
  } else if (words.used >= words.limit) {
    lead = `Maximal rule "${words.name}" is used up: ${amount(words.used)} of ${amount(words.limit)} used${need ? `; ${need}` : ""}.`
  } else {
    lead = `Maximal rule "${words.name}" doesn't have room for this request: ${amount(words.used)} of ${amount(words.limit)} used; ${need}.`
  }
  return `${lead} ${resetSentence(words)} Raise or remove it in Maximal → Rules.`
}
