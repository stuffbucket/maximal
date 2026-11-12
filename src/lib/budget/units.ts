/**
 * The one place costs change unit.
 *
 * Spend and limits are stored as integer nano-AIU (`copilot_usage.total_nano_aiu`,
 * 10⁻⁹ AI credit). People see US dollars by default, at GitHub's documented
 * $0.01 per AI credit, or AI credits. `budget.display.creditUsd` overrides the
 * rate; it changes only what is shown, never what is stored.
 */

import type { BudgetConfig, BudgetDisplayUnit } from "./schema"

export const NANO_AIU_PER_CREDIT = 1_000_000_000
export const DEFAULT_CREDIT_USD = 0.01

export interface BudgetDisplay {
  unit: BudgetDisplayUnit
  /** USD per AI credit. */
  creditUsd: number
}

export function resolveBudgetDisplay(
  config: BudgetConfig | undefined,
): BudgetDisplay {
  return {
    unit: config?.display?.unit ?? "usd",
    creditUsd: config?.display?.creditUsd ?? DEFAULT_CREDIT_USD,
  }
}

/** Display-unit amount for a nano-AIU figure. */
export function nanoAiuToDisplay(
  nanoAiu: number,
  display: BudgetDisplay,
): number {
  const credits = nanoAiu / NANO_AIU_PER_CREDIT
  return display.unit === "usd" ? credits * display.creditUsd : credits
}

/** Nano-AIU for an amount entered in the display unit, rounded to whole
 *  nano-AIU. */
export function displayToNanoAiu(
  amount: number,
  display: BudgetDisplay,
): number {
  const credits = display.unit === "usd" ? amount / display.creditUsd : amount
  return Math.round(credits * NANO_AIU_PER_CREDIT)
}
