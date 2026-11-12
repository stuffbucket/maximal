/**
 * The report endpoints' work, apart from HTTP: what-if simulation, session
 * costs and suggested rules. Each resolves its range, reads the usage it
 * needs, runs the pure modules (`./simulate`, `./sessions`, `./suggest`) and
 * shapes the wire response. Nothing here changes config.
 */

import type {
  BudgetReportRangeInput,
  BudgetSessionsResponse,
  BudgetSimulateRequest,
  BudgetSimulateResponse,
  BudgetSimulationResult,
  BudgetSuggestRequest,
  BudgetSuggestResponse,
} from "~/lib/config/settings-types"

import type { FollowedWindow } from "../periods"
import type { BudgetConfig } from "../schema"
import type { BudgetDisplay } from "../units"
import type {
  ParsedRange,
  RangeQuery,
  TrailingRange,
  UsageRange,
} from "./range"
import type { DraftLimit, SimulationResult } from "./simulate"

import { DAY_MS, startOfUtcDay } from "../periods"
import { DEFAULT_WARN_AT, NanoAiuAmount } from "../schema"
import {
  displayToNanoAiu,
  nanoAiuToDisplay,
  resolveBudgetDisplay,
} from "../units"
import { parseUsageRange } from "./range"
import { getSessionsReport } from "./sessions"
import { replayStartMs, simulateDraft } from "./simulate"
import { suggestRules } from "./suggest"
import { getFirstUsageMs } from "./usage"
import { getUsageEventRows } from "./usage-rows"

const iso = (ms: number): string => new Date(ms).toISOString()
const isoOrNull = (ms: number | null): string | null =>
  ms === null ? null : iso(ms)

export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string }

/** What a report needs from outside: the clock and the provider windows. */
export interface ReportContext {
  nowMs: number
  config: BudgetConfig | undefined
  findWindow: (ref: string) => FollowedWindow | undefined
}

/** The range a body names, as the query form `parseUsageRange` reads. */
export function rangeQueryOf(
  input: BudgetReportRangeInput | undefined,
): RangeQuery {
  if (input === undefined) return {}
  return typeof input === "string" ? { range: input } : input
}

/** Resolve a range; `all` starts at the first recorded request, not the
 *  epoch, so a replay over it has a sensible number of periods. */
export async function resolveReportRange(
  query: RangeQuery,
  nowMs: number,
  fallback: TrailingRange,
): Promise<ParsedRange> {
  const parsed = parseUsageRange(query, nowMs, fallback)
  if (!parsed.ok || parsed.range.label !== "all") return parsed
  const firstMs = await getFirstUsageMs()
  return {
    ok: true,
    range: {
      ...parsed.range,
      fromMs: Math.min(firstMs ?? nowMs - DAY_MS, nowMs - 1),
    },
  }
}

/** The range as the wire reports it. Only the forms the report endpoints
 *  accept can reach it. */
function wireRange(range: UsageRange): BudgetSimulateResponse["range"] {
  const label =
    range.label === "day" || range.label === "week" || range.label === "month" ?
      "custom"
    : range.label
  return { from: iso(range.fromMs), to: iso(range.toMs), label }
}

const displayOf = (
  display: BudgetDisplay,
): BudgetSimulateResponse["display"] => ({
  unit: display.unit,
  credit_usd: display.creditUsd,
})

function draftsOf(
  body: BudgetSimulateRequest,
  display: BudgetDisplay,
  filters: BudgetConfig["filters"],
): Outcome<Array<DraftLimit>> {
  const drafts: Array<DraftLimit> = []
  const seen = new Set<string>()
  const filterIds = new Set((filters ?? []).map((filter) => filter.id))
  for (const [index, entry] of body.limits.entries()) {
    const id = entry.id ?? `draft-${index + 1}`
    if (seen.has(id))
      return { ok: false, message: `duplicate draft id '${id}'` }
    seen.add(id)
    if (entry.scope.kind === "filter" && !filterIds.has(entry.scope.id)) {
      return {
        ok: false,
        message: `'${id}' uses unknown filter '${entry.scope.id}'`,
      }
    }
    const limit = NanoAiuAmount.safeParse(
      entry.limit ?? displayToNanoAiu(entry.amount ?? 0, display),
    )
    if (!limit.success) {
      return { ok: false, message: `the amount of '${id}' is out of range` }
    }
    drafts.push({
      id,
      ...(entry.label === undefined ? {} : { label: entry.label }),
      scope: entry.scope,
      limit: limit.data,
      limitReset: entry.limit_reset,
      warnAt: entry.warn_at ?? DEFAULT_WARN_AT,
      action: entry.action,
    })
  }
  return { ok: true, value: drafts }
}

function simulationResult(
  draft: DraftLimit,
  result: SimulationResult,
  display: BudgetDisplay,
): BudgetSimulationResult {
  const amount = (nano: number): number => nanoAiuToDisplay(nano, display)
  return {
    id: draft.id,
    label: draft.label ?? null,
    scope: draft.scope,
    limit: draft.limit,
    limit_reset: draft.limitReset,
    warn_at: draft.warnAt,
    action: draft.action,
    mode: result.mode,
    matched_requests: result.matchedRequests,
    matched_nano_aiu: result.matchedNanoAiu,
    admitted_nano_aiu: result.admittedNanoAiu,
    refused_requests: result.refusedRequests,
    refused_nano_aiu: result.refusedNanoAiu,
    warned_at: isoOrNull(result.warnedAtMs),
    tripped_at: isoOrNull(result.trippedAtMs),
    peak: { nano_aiu: result.peakNanoAiu, at: isoOrNull(result.peakAtMs) },
    periods_total: result.periodsTotal,
    periods_warned: result.periodsWarned,
    periods_tripped: result.periodsTripped,
    suggested_nano_aiu: result.suggestedNanoAiu,
    display: {
      limit: amount(draft.limit),
      matched: amount(result.matchedNanoAiu),
      refused: amount(result.refusedNanoAiu),
      peak: amount(result.peakNanoAiu),
      suggested:
        result.suggestedNanoAiu === null ?
          null
        : amount(result.suggestedNanoAiu),
    },
    periods: result.periods.map((period) => ({
      start: iso(period.startMs),
      end: isoOrNull(period.endMs),
      estimated: period.estimated,
      spend_nano_aiu: period.spendNanoAiu,
      refused_requests: period.refusedRequests,
      refused_nano_aiu: period.refusedNanoAiu,
      warned_at: isoOrNull(period.warnedAtMs),
      tripped_at: isoOrNull(period.trippedAtMs),
    })),
  }
}

/** Replay the usage in the range through each draft. */
export async function runSimulation(
  body: BudgetSimulateRequest,
  context: ReportContext,
): Promise<Outcome<BudgetSimulateResponse>> {
  const display = resolveBudgetDisplay(context.config)
  const drafts = draftsOf(body, display, context.config?.filters)
  if (!drafts.ok) return drafts
  const parsed = await resolveReportRange(
    rangeQueryOf(body.range),
    context.nowMs,
    "30d",
  )
  if (!parsed.ok) return { ok: false, message: parsed.message }
  const { range } = parsed
  const replay = {
    fromMs: range.fromMs,
    toMs: range.toMs,
    nowMs: context.nowMs,
    findWindow: context.findWindow,
    filters: context.config?.filters,
  }
  const readFromMs = Math.min(
    ...drafts.value.map((draft) => replayStartMs(draft, replay)),
  )
  const rows = await getUsageEventRows({ fromMs: readFromMs, toMs: range.toMs })
  return {
    ok: true,
    value: {
      range: wireRange(range),
      display: displayOf(display),
      requests_replayed: rows.length,
      results: drafts.value.map((draft) =>
        simulationResult(draft, simulateDraft(draft, rows, replay), display),
      ),
    },
  }
}

/** What each session in the range cost. */
export async function runSessions(
  query: RangeQuery & { limit: number },
  context: ReportContext,
): Promise<Outcome<BudgetSessionsResponse>> {
  const display = resolveBudgetDisplay(context.config)
  const parsed = parseUsageRange(query, context.nowMs, "7d")
  if (!parsed.ok) return { ok: false, message: parsed.message }
  const report = await getSessionsReport(parsed.range, { limit: query.limit })
  const amount = (nano: number): number => nanoAiuToDisplay(nano, display)
  return {
    ok: true,
    value: {
      range: wireRange(parsed.range),
      display: displayOf(display),
      total_sessions: report.totalSessions,
      totals: report.totals,
      sessions: report.sessions.map((session) => ({
        id: session.id,
        attributed: session.attributed,
        client: session.client,
        client_label: session.clientLabel,
        key: session.key,
        started_at: iso(session.startedAtMs),
        ended_at: iso(session.endedAtMs),
        duration_ms: Math.max(0, session.endedAtMs - session.startedAtMs),
        requests: session.usage.request_count,
        nano_aiu: session.usage.total_nano_aiu,
        amount: amount(session.usage.total_nano_aiu),
        usage: session.usage,
        models: session.models.map((mix) => ({
          model: mix.model,
          requests: mix.requests,
          nano_aiu: mix.nanoAiu,
          amount: amount(mix.nanoAiu),
          share:
            session.usage.total_nano_aiu === 0 ?
              0
            : mix.nanoAiu / session.usage.total_nano_aiu,
        })),
      })),
    },
  }
}

/** Draft rules sized from the sessions' (or the range's) usage. */
export async function runSuggest(
  body: BudgetSuggestRequest,
  context: ReportContext,
): Promise<Outcome<BudgetSuggestResponse>> {
  const display = resolveBudgetDisplay(context.config)
  const sessionIds = body.session_ids ?? body.sessionIds
  const parsed = await resolveReportRange(
    rangeQueryOf(body.range),
    context.nowMs,
    "30d",
  )
  if (!parsed.ok) return { ok: false, message: parsed.message }
  let { range } = parsed
  if (sessionIds !== undefined && body.range === undefined) {
    // From the sessions' first request, not from before they existed.
    const all = await getUsageEventRows({
      fromMs: 0,
      toMs: context.nowMs + 1,
      sessionIds,
    })
    range = {
      fromMs: startOfUtcDay(all.at(0)?.createdAtMs ?? context.nowMs - DAY_MS),
      toMs: context.nowMs + 1,
      label: "custom",
    }
  }
  const rows = await getUsageEventRows({
    fromMs: range.fromMs,
    toMs: range.toMs,
    ...(sessionIds === undefined ? {} : { sessionIds }),
  })
  const suggestion = suggestRules({
    rows,
    ...(body.persona === undefined ? {} : { persona: body.persona }),
    display,
    context: {
      fromMs: range.fromMs,
      toMs: range.toMs,
      nowMs: context.nowMs,
      findWindow: context.findWindow,
      filters: context.config?.filters,
    },
    existingIds: new Set((context.config?.limits ?? []).map((l) => l.id)),
  })
  return {
    ok: true,
    value: {
      range: wireRange(range),
      display: displayOf(display),
      persona: body.persona ?? null,
      sessions_considered: new Set(
        rows
          .map((row) => row.sessionId)
          .filter((id) => id !== undefined && id !== ""),
      ).size,
      requests_considered: rows.length,
      nano_aiu_considered: rows.reduce((sum, row) => sum + row.nanoAiu, 0),
      notes: suggestion.notes,
      limits: suggestion.rules.map((rule) => ({
        id: rule.id,
        label: rule.label,
        scope: rule.scope,
        limit: rule.limitNanoAiu,
        amount: nanoAiuToDisplay(rule.limitNanoAiu, display),
        limit_reset: rule.limitReset,
        warn_at: rule.warnAt,
        action: rule.action,
        basis: {
          percentile: rule.basis.percentile,
          periods_observed: rule.basis.periodsObserved,
          peak_nano_aiu: rule.basis.peakNanoAiu,
          sized_to_nano_aiu: rule.basis.sizedToNanoAiu,
          share: rule.basis.share,
        },
        projection: {
          periods_total: rule.projection.periodsTotal,
          periods_tripped: rule.projection.periodsTripped,
          refused_requests: rule.projection.refusedRequests,
          refused_nano_aiu: rule.projection.refusedNanoAiu,
        },
      })),
    },
  }
}
