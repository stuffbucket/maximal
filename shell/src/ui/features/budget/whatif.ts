/**
 * The what-if preview's logic, free of the DOM and the catalog so it can be
 * tested on its own (tests/budget-whatif.test.ts): which drafts are worth
 * replaying, what to send, and what to say about the answer.
 */

import type {
  BudgetLimitPutRequest,
  BudgetSimulateRequest,
  BudgetSimulationResult,
} from "../../../../../src/lib/config/settings-types";

import { fractionDigits } from "./format";
import { type RangeChoice, rangeBody } from "./range";

/** The ranges the preview offers. 30 days is the default: long enough to hold a month of habits. */
export const WHATIF_PRESETS = ["7d", "30d", "90d", "all"] as const;

/**
 * The request for a draft, or null while the form isn't a rule yet or the range isn't
 * complete. The name is left out: it can't change what a rule would have done, so
 * typing it must not replay anything.
 */
export function simulateRequest(
  draft: BudgetLimitPutRequest | null,
  choice: RangeChoice,
): BudgetSimulateRequest | null {
  const range = rangeBody(choice);
  if (!draft || range === null) return null;
  const { label: _label, ...rest } = draft;
  return { limits: [rest], range };
}

/** A key that changes exactly when the answer could: the same request is the same replay. */
export function simulateKey(request: BudgetSimulateRequest | null): string {
  return request ? JSON.stringify(request) : "";
}

/**
 * An amount rounded up to what its display shows ($4.381 reads $4.39, never
 * $4.38), so applying a suggestion never lands below it.
 */
export function roundUpAmount(value: number): number {
  const digits = fractionDigits(value);
  const scale = 10 ** digits;
  return Math.ceil(Number((value * scale).toPrecision(12))) / scale;
}

/** The suggested amount in the display unit, rounded up, or null when there is no history to size it from. */
export function suggestedAmount(result: BudgetSimulationResult): number | null {
  const { suggested } = result.display;
  return suggested === null || suggested <= 0 ? null : roundUpAmount(suggested);
}

export interface WhatIfFacts {
  /** Whether any recorded usage matched the rule's scope in the range. */
  anyUsage: boolean;
  /** Only a rule that blocks refuses: one that warns never does, and one that asks would have asked first. */
  blocks: boolean;
  asks: boolean;
  /** When, as the API gave it (ISO, UTC). */
  warnedAt: string | null;
  trippedAt: string | null;
  refusedRequests: number;
  /** Refused spend in the display unit. */
  refusedAmount: number;
  peakAmount: number;
  peakAt: string | null;
  matchedRequests: number;
  matchedAmount: number;
  /** Periods that hit the limit, of the periods replayed; null for a rolling rule, which has none. */
  periods: { tripped: number; total: number } | null;
  rolling: boolean;
  suggested: number | null;
}

/** What a simulation said, in the order the panel lists it. */
export function whatIfFacts(result: BudgetSimulationResult): WhatIfFacts {
  return {
    anyUsage: result.matched_requests > 0,
    blocks: result.action === "block",
    asks: result.action === "ask",
    warnedAt: result.warned_at,
    trippedAt: result.tripped_at,
    refusedRequests: result.refused_requests,
    refusedAmount: result.display.refused,
    peakAmount: result.display.peak,
    peakAt: result.peak.at,
    matchedRequests: result.matched_requests,
    matchedAmount: result.display.matched,
    periods:
      result.periods_total === null || result.periods_tripped === null ?
        null
      : { tripped: result.periods_tripped, total: result.periods_total },
    rolling: result.mode === "rolling",
    suggested: suggestedAmount(result),
  };
}
