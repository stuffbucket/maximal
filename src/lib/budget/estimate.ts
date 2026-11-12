/**
 * A first estimate for the billed calls whose cost is known well enough to
 * hold: image generations and edits. Everything else returns 0, which the
 * budget service admits while the limit has room.
 *
 * Seeded from what Copilot billed for the default image model (about 0.6 AI
 * credits for a low-quality 1024² generation, 1.4 for an edit); quality
 * scales it by the ratio OpenAI prices its image models at. The actual cost,
 * `copilot_usage.total_nano_aiu`, replaces the estimate when the call ends.
 */

import type { BudgetOperation } from "./scope"

import { NANO_AIU_PER_CREDIT } from "./units"

const GENERATION_LOW = 0.6 * NANO_AIU_PER_CREDIT
const EDIT_LOW = 1.4 * NANO_AIU_PER_CREDIT

const QUALITY_FACTOR: Readonly<Record<string, number>> = {
  low: 1,
  medium: 4,
  high: 16,
}

function field(
  body: Record<string, unknown> | FormData,
  name: string,
): unknown {
  return body instanceof FormData ? body.get(name) : body[name]
}

function imageCount(body: Record<string, unknown> | FormData): number {
  const raw = field(body, "n")
  const n = typeof raw === "string" ? Number(raw) : raw
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ?
      Math.min(n, 10)
    : 1
}

export function estimateOperationNanoAiu(
  operation: BudgetOperation,
  body: Record<string, unknown> | FormData,
): number {
  if (operation !== "images.generations" && operation !== "images.edits") {
    return 0
  }
  const raw = field(body, "quality")
  const named =
    typeof raw === "string" ? QUALITY_FACTOR[raw.toLowerCase()] : undefined
  // An edit's 1.4 credits was observed with no quality named; a generation
  // that names none (or `auto`) is estimated as `medium`.
  const factor =
    named ?? (operation === "images.edits" ? 1 : QUALITY_FACTOR.medium)
  const base = operation === "images.edits" ? EDIT_LOW : GENERATION_LOW
  return Math.round(base * factor * imageCount(body))
}
