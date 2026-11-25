/**
 * What-if: replay recorded usage, in time order, through a draft limit as if
 * it had been in force, and report what it would have done.
 *
 * Pure and deterministic: rows, clock and provider windows come in as
 * arguments. It reuses the real pieces rather than restating them: a limit
 * covers a request when `scopeMatches` says so (the same call the service
 * makes), periods come from `periodsInRange` over `resolvePeriod`, and spend
 * is counted by the replay ledger (periods start over; a rolling window ages
 * spend out one window later).
 *
 * The decision is the chat gate's, since a recorded request carries no
 * estimate: a request is refused by a `block` limit when the spend already
 * counted in its period has reached the limit, and it warns when that spend
 * has reached `warnAt`. A refused request is never billed, so it adds nothing
 * to the period. A `warn` limit refuses nothing and counts everything; its
 * `trippedAt` is the first request that found the limit already reached.
 *
 * Each draft is replayed on its own, as if it were the only rule.
 */

import type { BudgetPeriod, FollowedWindow } from "../periods"
import type {
  BudgetFilterConfig,
  BudgetLimitAction,
  BudgetLimitReset,
  BudgetScope,
} from "../schema"
import type { BudgetSubject } from "../scope"

import { HOUR_MS } from "../periods"
import { resolveScope, scopeMatches } from "../scope"
import { createLedger, type Ledger } from "./ledger"
import { periodsInRange } from "./timeline"

/** A limit being tried, in the shape the service enforces. */
export interface DraftLimit {
  id: string
  label?: string
  scope: BudgetScope
  /** Nano-AIU. */
  limit: number
  limitReset: BudgetLimitReset
  /** Fraction of the limit at which it warns. */
  warnAt: number
  action: BudgetLimitAction
}

/** One recorded request, as budget scopes see it. */
export interface UsageEventRow extends BudgetSubject {
  createdAtMs: number
  nanoAiu: number
  /** The session the request belonged to; "" for none. */
  sessionId?: string
}

export interface SimulationContext {
  /** The window results are reported for. Rows before it still count toward
   *  the period they fall in, so a limit's first period isn't cut short. */
  fromMs: number
  /** Exclusive. */
  toMs: number
  nowMs: number
  findWindow: (ref: string) => FollowedWindow | undefined
  /** The reusable filters a `filter` scope refers to. */
  filters?: ReadonlyArray<BudgetFilterConfig> | undefined
}

export interface SimulatedPeriod {
  startMs: number
  endMs: number | null
  estimated: boolean
  /** What the scope spent in the period with no limit in force. */
  spendNanoAiu: number
  refusedRequests: number
  refusedNanoAiu: number
  warnedAtMs: number | null
  trippedAtMs: number | null
}

export interface SimulationResult {
  id: string
  /** `rolling` limits have no periods to count or list. */
  mode: "periods" | "rolling"
  matchedRequests: number
  /** What the matched requests cost, with no limit in force. */
  matchedNanoAiu: number
  /** What the limit would have let through. */
  admittedNanoAiu: number
  refusedRequests: number
  refusedNanoAiu: number
  warnedAtMs: number | null
  trippedAtMs: number | null
  /** The most the scope spent in one period (a rolling window: in one
   *  window), with no limit in force, and when. */
  peakNanoAiu: number
  peakAtMs: number | null
  periods: Array<SimulatedPeriod>
  periodsTotal: number | null
  periodsWarned: number | null
  periodsTripped: number | null
  /** The p90 of the period (window) spend, so the limit would not have
   *  tripped most periods; null when the scope spent nothing. */
  suggestedNanoAiu: number | null
}

/** The share of periods a suggested amount fits. */
export const SUGGESTED_PERCENTILE = 0.9

/** The value at rank `ceil(p * n)` of the sorted samples (nearest rank). */
export function percentile(
  sorted: ReadonlyArray<number>,
  p: number,
): number | undefined {
  if (sorted.length === 0) return undefined
  const rank = Math.min(
    sorted.length,
    Math.max(1, Math.ceil(p * sorted.length)),
  )
  return sorted[rank - 1]
}

const ascending = (a: number, b: number): number => a - b

/** Spend per period with no limit in force, one entry per period; the last
 *  one still open at `toMs` is left out when an earlier one is complete. */
function completedSpends(
  periods: ReadonlyArray<SimulatedPeriod>,
  toMs: number,
): Array<number> {
  const open = (period: SimulatedPeriod): boolean =>
    period.endMs !== null && period.endMs > toMs
  const complete = periods.filter((period) => !open(period))
  return (complete.length > 0 ? complete : periods).map((p) => p.spendNanoAiu)
}

/** The trailing-window spend at every hour boundary in the window, with no
 *  limit in force: the samples a rolling limit is sized against. */
export function rollingSamples(
  rows: ReadonlyArray<UsageEventRow>,
  windowMs: number,
  { fromMs, toMs }: Pick<SimulationContext, "fromMs" | "toMs">,
): Array<number> {
  const ledger = createLedger([rollingPeriod(windowMs)])
  const samples: Array<number> = []
  let index = 0
  for (
    let hourEnd = Math.floor(fromMs / HOUR_MS) * HOUR_MS + HOUR_MS;
    hourEnd - HOUR_MS < toMs;
    hourEnd += HOUR_MS
  ) {
    for (; index < rows.length && rows[index].createdAtMs < hourEnd; index++) {
      ledger.advance(rows[index].createdAtMs)
      ledger.add(rows[index].nanoAiu)
    }
    ledger.advance(hourEnd - 1)
    samples.push(ledger.used)
  }
  return samples
}

interface Tally {
  matchedRequests: number
  matchedNanoAiu: number
  refusedRequests: number
  refusedNanoAiu: number
  warnedAtMs: number | null
  trippedAtMs: number | null
}

function rollingPeriod(windowMs: number): BudgetPeriod {
  return {
    startMs: 0,
    endMs: null,
    basis: "fixed",
    estimated: false,
    rollingMs: windowMs,
  }
}

function openPeriods(
  draft: DraftLimit,
  context: SimulationContext,
): {
  periods: Array<SimulatedPeriod>
  rolling: boolean
  ledger: Ledger
  windowMs: number
} {
  const source = periodsInRange(draft.limitReset, context.findWindow, context)
  const windowMs = source.at(0)?.rollingMs ?? 0
  const rolling = windowMs > 0
  return {
    rolling,
    windowMs,
    ledger: createLedger(source),
    periods:
      rolling ?
        []
      : source.map((period) => ({
          startMs: period.startMs,
          endMs: period.endMs,
          estimated: period.estimated,
          spendNanoAiu: 0,
          refusedRequests: 0,
          refusedNanoAiu: 0,
          warnedAtMs: null,
          trippedAtMs: null,
        })),
  }
}

interface Peak {
  nanoAiu: number
  atMs: number | null
}

interface Replayed {
  tally: Tally
  peak: Peak
  /** The rows the draft covers, oldest first. */
  matched: Array<UsageEventRow>
}

type Setup = ReturnType<typeof openPeriods>

/** What the chat gate does with a request that finds `used` already counted. */
function decide(
  draft: DraftLimit,
  used: number,
): { warned: boolean; tripped: boolean; refused: boolean } {
  const tripped = used >= draft.limit
  return {
    warned: used >= draft.limit * draft.warnAt,
    tripped,
    // A rule that asks refuses until it is answered, like one that blocks.
    refused: draft.action !== "warn" && tripped,
  }
}

/** Where to start reading usage so the draft's first period is whole: the
 *  period's start, a rolling window back from the window's start, or (a
 *  lifetime limit, which has no earlier history to replay) the window's
 *  start. */
export function replayStartMs(
  draft: DraftLimit,
  context: SimulationContext,
): number {
  const first = periodsInRange(
    draft.limitReset,
    context.findWindow,
    context,
  ).at(0)
  if (first === undefined) return context.fromMs
  if (first.rollingMs !== undefined) return context.fromMs - first.rollingMs
  if (first.endMs === null) return context.fromMs
  return Math.min(context.fromMs, first.startMs)
}

/** Replay `rows` (oldest first) through the draft's ledger. */
function replay(
  draft: DraftLimit,
  rows: ReadonlyArray<UsageEventRow>,
  plan: { context: SimulationContext; setup: Setup },
): Replayed {
  const { context, setup } = plan
  const { periods, rolling, ledger, windowMs } = setup
  const firstStartMs = periods.at(0)?.startMs ?? Number.NEGATIVE_INFINITY
  const tally: Tally = {
    matchedRequests: 0,
    matchedNanoAiu: 0,
    refusedRequests: 0,
    refusedNanoAiu: 0,
    warnedAtMs: null,
    trippedAtMs: null,
  }
  // A rolling window's spend with no limit in force, for its peak.
  const free = rolling ? createLedger([rollingPeriod(windowMs)]) : undefined
  const peak: Peak = { nanoAiu: 0, atMs: null }
  const matched: Array<UsageEventRow> = []

  const scope = resolveScope(draft.scope, context.filters)
  for (const row of rows) {
    if (!scopeMatches(scope, row)) continue
    // A period's earlier rows belong to a period this replay doesn't cover.
    if (!rolling && row.createdAtMs < firstStartMs) continue
    matched.push(row)
    ledger.advance(row.createdAtMs)
    const decision = decide(draft, ledger.used)
    const inWindow =
      row.createdAtMs >= context.fromMs && row.createdAtMs < context.toMs
    const period = rolling ? undefined : periods[ledger.periodIndex]
    if (inWindow) noteRequest({ tally, period }, row, decision)
    // A refused request is never billed.
    if (!decision.refused) ledger.add(row.nanoAiu)
    if (period) period.spendNanoAiu += row.nanoAiu
    if (free) {
      free.advance(row.createdAtMs)
      free.add(row.nanoAiu)
      if (inWindow && free.used > peak.nanoAiu) {
        peak.nanoAiu = free.used
        peak.atMs = row.createdAtMs
      }
    }
  }
  return { tally, peak, matched }
}

/** Replay `rows` (oldest first) through the draft: when it would have
 *  warned and tripped, what it would have refused, the scope's peak, and the
 *  amount that would have fit most periods. */
export function simulateDraft(
  draft: DraftLimit,
  rows: ReadonlyArray<UsageEventRow>,
  context: SimulationContext,
): SimulationResult {
  const setup = openPeriods(draft, context)
  const { tally, peak, matched } = replay(draft, rows, { context, setup })
  const { periods, rolling, windowMs } = setup

  let samples: Array<number>
  if (rolling) {
    samples = rollingSamples(matched, windowMs, context)
  } else {
    for (const period of periods) {
      if (period.spendNanoAiu > peak.nanoAiu) {
        peak.nanoAiu = period.spendNanoAiu
        peak.atMs = period.startMs
      }
    }
    samples = completedSpends(periods, context.toMs)
  }
  const suggested = percentile(samples.sort(ascending), SUGGESTED_PERCENTILE)
  const count = (pick: (p: SimulatedPeriod) => number | null): number | null =>
    rolling ? null : periods.filter((p) => pick(p) !== null).length
  return {
    id: draft.id,
    mode: rolling ? "rolling" : "periods",
    ...tally,
    admittedNanoAiu: tally.matchedNanoAiu - tally.refusedNanoAiu,
    peakNanoAiu: peak.nanoAiu,
    peakAtMs: peak.atMs,
    periods,
    periodsTotal: rolling ? null : periods.length,
    periodsWarned: count((p) => p.warnedAtMs),
    periodsTripped: count((p) => p.trippedAtMs),
    suggestedNanoAiu:
      suggested === undefined || suggested === 0 ? null : suggested,
  }
}

function noteRequest(
  target: { tally: Tally; period: SimulatedPeriod | undefined },
  row: UsageEventRow,
  decision: { warned: boolean; tripped: boolean; refused: boolean },
): void {
  const { tally, period } = target
  tally.matchedRequests += 1
  tally.matchedNanoAiu += row.nanoAiu
  if (decision.warned) {
    tally.warnedAtMs ??= row.createdAtMs
    if (period) period.warnedAtMs ??= row.createdAtMs
  }
  if (decision.tripped) {
    tally.trippedAtMs ??= row.createdAtMs
    if (period) period.trippedAtMs ??= row.createdAtMs
  }
  if (decision.refused) {
    tally.refusedRequests += 1
    tally.refusedNanoAiu += row.nanoAiu
    if (period) {
      period.refusedRequests += 1
      period.refusedNanoAiu += row.nanoAiu
    }
  }
}
