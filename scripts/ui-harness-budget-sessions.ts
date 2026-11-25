/**
 * The mock sidecar's session costs and suggested rules over the made-up spend
 * ledger, following `src/lib/budget/reports/sessions.ts` and `suggest.ts`
 * step for step (the suggestion's sizing is the real one, ported onto the
 * mock's replay). tests/ui-harness-budget-sessions.test.ts checks both
 * against the real modules on the same requests.
 *
 * Browser-safe like its host: web-standard APIs only.
 */
import type {
  BudgetPersonaId,
  BudgetSessionsResponse,
  BudgetSuggestRequest,
  BudgetSuggestResponse,
  BudgetSimulationResult,
} from "../src/lib/config/settings-types"

import { DAY_MS, startOfUtcDay } from "../src/lib/budget/periods"
import { type RangeQuery, parseUsageRange } from "../src/lib/budget/reports/range"
import { displayToNanoAiu, nanoAiuToDisplay } from "../src/lib/budget/units"
import {
  type ReportContext,
  type ReportFailure,
  type ReportLimit,
  type ReportRow,
  simulateDraft,
  simulationWindow,
} from "./ui-harness-budget-reports"

const UNATTRIBUTED_PREFIX = "other:"

/** A session's id: the recorded one, or the client's pseudo-session for requests that carried none. */
const sessionIdOf = (row: ReportRow): string => (row.sessionId === "" ? `${UNATTRIBUTED_PREFIX}${row.key}` : row.sessionId)

type Totals = BudgetSessionsResponse["totals"]

const EMPTY: Totals = {
  request_count: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  total_tokens: 0,
  total_nano_aiu: 0,
}

function addRow(totals: Totals, row: ReportRow): Totals {
  const tokens = row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens
  return {
    request_count: totals.request_count + row.requests,
    input_tokens: totals.input_tokens + row.inputTokens,
    output_tokens: totals.output_tokens + row.outputTokens,
    cache_read_input_tokens: totals.cache_read_input_tokens + row.cacheReadTokens,
    cache_creation_input_tokens: totals.cache_creation_input_tokens + row.cacheWriteTokens,
    total_tokens: totals.total_tokens + tokens,
    total_nano_aiu: totals.total_nano_aiu + row.nanoAiu,
  }
}

const iso = (ms: number): string => new Date(ms).toISOString()

/** `GET /settings/api/budget/sessions`: what each session cost, biggest first. */
export function buildSessions(context: ReportContext, query: RangeQuery & { limit?: number }): BudgetSessionsResponse | ReportFailure {
  const parsed = parseUsageRange(query, context.nowMs, "7d")
  if (!parsed.ok) return { status: 400, message: parsed.message }
  const { range } = parsed
  const limit = Math.min(500, Math.max(1, query.limit ?? 100))
  const rows = context.rows.filter((row) => row.atMs >= range.fromMs && row.atMs < range.toMs)
  const bySession = new Map<string, Array<ReportRow>>()
  for (const row of rows) {
    const id = sessionIdOf(row)
    bySession.set(id, [...(bySession.get(id) ?? []), row])
  }
  const amount = (nano: number): number => nanoAiuToDisplay(nano, context.display)
  const sessions = [...bySession.entries()]
    .map(([id, parts]) => {
      const usage = parts.reduce(addRow, EMPTY)
      const lead = parts.reduce((best, part) => (part.nanoAiu > best.nanoAiu ? part : best))
      const models = new Map<string, { requests: number; nano: number }>()
      for (const part of parts) {
        const mix = models.get(part.model) ?? { requests: 0, nano: 0 }
        models.set(part.model, { requests: mix.requests + part.requests, nano: mix.nano + part.nanoAiu })
      }
      const startedAtMs = Math.min(...parts.map((p) => p.atMs))
      const endedAtMs = Math.max(...parts.map((p) => p.atMs))
      return {
        id,
        attributed: !id.startsWith(UNATTRIBUTED_PREFIX),
        client: lead.key,
        client_label: null,
        key: lead.key,
        started_at: iso(startedAtMs),
        ended_at: iso(endedAtMs),
        duration_ms: Math.max(0, endedAtMs - startedAtMs),
        requests: usage.request_count,
        nano_aiu: usage.total_nano_aiu,
        amount: amount(usage.total_nano_aiu),
        usage,
        models: [...models.entries()]
          .sort((a, b) => b[1].nano - a[1].nano || a[0].localeCompare(b[0]))
          .map(([model, mix]) => ({
            model,
            requests: mix.requests,
            nano_aiu: mix.nano,
            amount: amount(mix.nano),
            share: usage.total_nano_aiu === 0 ? 0 : mix.nano / usage.total_nano_aiu,
          })),
      }
    })
    .sort((a, b) => b.nano_aiu - a.nano_aiu || Date.parse(b.ended_at) - Date.parse(a.ended_at) || a.id.localeCompare(b.id))
  return {
    range: { from: iso(range.fromMs), to: iso(range.toMs), label: range.label === "day" || range.label === "week" || range.label === "month" ? "custom" : range.label },
    display: { unit: context.display.unit, credit_usd: context.display.creditUsd },
    sessions: sessions.slice(0, limit),
    total_sessions: sessions.length,
    totals: rows.reduce(addRow, EMPTY),
  }
}

// ---- suggested rules ------------------------------------------------------

const OWN_RULE_SHARE = 0.2
const MAX_KEY_RULES = 10
const MIN_WEEKLY_SPAN_MS = 14 * DAY_MS

/** The two significant figures at or above `value` (a display amount). */
function roundUpNice(value: number): number {
  if (!(value > 0)) return 0
  const step = 10 ** (Math.floor(Math.log10(value)) - 1)
  return Number((Math.ceil(value / step - 1e-9) * step).toPrecision(12))
}

function slugOf(text: string): string {
  const slug = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 40)
    .replaceAll(/-+$/gu, "")
  return slug === "" ? "key" : slug
}

interface Shape {
  id: string
  label: string
  scope: ReportLimit["scope"]
  reset: ReportLimit["limitReset"]
}

function spendBy(rows: ReadonlyArray<ReportRow>, pick: (row: ReportRow) => string | null): Array<[string, number]> {
  const totals = new Map<string, number>()
  for (const row of rows) {
    const key = pick(row)
    if (key === null) continue
    totals.set(key, (totals.get(key) ?? 0) + row.nanoAiu)
  }
  return [...totals.entries()].filter(([, nano]) => nano > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

function shapesFor(rows: ReadonlyArray<ReportRow>, persona: BudgetPersonaId | undefined, spanMs: number, notes: Set<"no_spend" | "short_history">): Array<Shape> {
  const daily: Shape = { id: "daily-cap", label: "Daily cap", scope: { kind: "global" }, reset: "daily" }
  if (persona === "trying-things-out") return [daily]
  if (persona === "heavy-agent-use") {
    return [{ id: "rolling-5h-cap", label: "Rolling 5-hour cap", scope: { kind: "global" }, reset: { every: { hours: 5 } } }]
  }
  if (persona === "team") {
    return spendBy(rows, (row) => row.key)
      .slice(0, MAX_KEY_RULES)
      .map(([key]) => ({ id: `${slugOf(key)}-daily`, label: `Daily cap for ${key}`, scope: { kind: "key" as const, id: key }, reset: "daily" as const }))
  }
  const shapes = [daily]
  if (spanMs >= MIN_WEEKLY_SPAN_MS) shapes.push({ id: "weekly-cap", label: "Weekly cap", scope: { kind: "global" }, reset: "weekly" })
  else notes.add("short_history")
  if (persona === undefined) {
    const total = rows.reduce((sum, row) => sum + row.nanoAiu, 0)
    for (const [plugin, nano] of spendBy(rows, (row) => row.plugin)) {
      if (nano / total >= OWN_RULE_SHARE) {
        shapes.push({ id: `${slugOf(plugin)}-daily`, label: `Daily cap for ${plugin}`, scope: { kind: "plugin", id: plugin }, reset: "daily" })
      }
    }
  }
  return shapes
}

/** `POST /settings/api/budget/suggest`: draft rules sized from sessions' usage (or a range's), each replayed over it. */
export function suggest(
  context: ReportContext,
  body: BudgetSuggestRequest,
  existingIds: ReadonlySet<string>,
): BudgetSuggestResponse | ReportFailure {
  const sessionIds = body.session_ids ?? body.sessionIds
  const picked = sessionIds === undefined ? undefined : new Set(sessionIds)
  const only = (row: ReportRow): boolean => picked === undefined || picked.has(sessionIdOf(row))
  const window = simulationWindow(context, body.range)
  if ("status" in window) return window
  let { fromMs, toMs } = window
  let label = window.label
  if (picked !== undefined && body.range === undefined) {
    // From the sessions' first request, not from before they existed.
    const first = context.rows.filter(only).reduce((min, row) => Math.min(min, row.atMs), context.nowMs - DAY_MS)
    fromMs = startOfUtcDay(first)
    toMs = context.nowMs + 1
    label = "custom"
  }
  const rows = context.rows.filter((row) => only(row) && row.atMs >= fromMs && row.atMs < toMs)
  const range = { fromMs, toMs }
  const total = rows.reduce((sum, row) => sum + row.nanoAiu, 0)
  const display = context.display
  const notes = new Set<"no_spend" | "short_history">()
  const rules: BudgetSuggestResponse["limits"] = []
  if (total === 0) notes.add("no_spend")
  else {
    const taken = new Set(existingIds)
    const unique = (base: string): string => {
      let id = base
      for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`
      taken.add(id)
      return id
    }
    for (const shape of shapesFor(rows, body.persona, toMs - fromMs, notes)) {
      const id = unique(shape.id)
      const base = { id, scope: shape.scope, limitReset: shape.reset, warnAt: 0.8, action: "block" as const }
      const probe: BudgetSimulationResult = simulateDraft(context, { ...base, limit: Number.MAX_SAFE_INTEGER }, range, only, fromMs)
      const quiet = probe.suggested_nano_aiu === null
      const sizedTo = probe.suggested_nano_aiu ?? probe.peak.nano_aiu
      if (sizedTo <= 0) continue
      const rounded = displayToNanoAiu(roundUpNice(nanoAiuToDisplay(sizedTo, display)), display)
      const limit = Math.max(rounded, sizedTo)
      const projected = simulateDraft(context, { ...base, limit }, range, only, fromMs)
      rules.push({
        id,
        label: shape.label,
        scope: shape.scope,
        limit,
        amount: nanoAiuToDisplay(limit, display),
        limit_reset: shape.reset,
        warn_at: base.warnAt,
        action: base.action,
        basis: {
          percentile: quiet ? 1 : 0.9,
          periods_observed: probe.periods_total,
          peak_nano_aiu: probe.peak.nano_aiu,
          sized_to_nano_aiu: sizedTo,
          share: total === 0 ? 0 : probe.matched_nano_aiu / total,
        },
        projection: {
          periods_total: projected.periods_total,
          periods_tripped: projected.periods_tripped,
          refused_requests: projected.refused_requests,
          refused_nano_aiu: projected.refused_nano_aiu,
        },
      })
    }
  }
  return {
    range: { from: iso(fromMs), to: iso(toMs), label: label as BudgetSuggestResponse["range"]["label"] },
    display: { unit: display.unit, credit_usd: display.creditUsd },
    persona: body.persona ?? null,
    sessions_considered: new Set(rows.map((row) => row.sessionId).filter((id) => id !== "")).size,
    requests_considered: rows.reduce((sum, row) => sum + row.requests, 0),
    nano_aiu_considered: total,
    limits: rules,
    notes: [...notes],
  }
}
