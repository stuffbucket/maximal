/**
 * The mock sidecar's `/settings/api/budget` surface, shared (through
 * ui-harness-api.ts) by `bun run ui:harness` and Storybook.
 *
 * It is a small working budget service over a made-up spend ledger: limits are
 * created, changed and deleted through the same requests the shell sends,
 * their spend, state and reset are worked out from the ledger with the real
 * period and unit math (`src/lib/budget/periods.ts`, `units.ts`), and every
 * change is announced to listeners so the harness can push `budget.changed`.
 * Browser-safe like its host: web-standard APIs only.
 *
 * A scenario picks a `BudgetSeed`; the ledger is dated relative to "now" so the
 * window always shows a recent week and a current month.
 */
import type {
  BudgetActivityResponse,
  BudgetLimitStatus,
  BudgetStatusResponse,
  ProviderQuotaWindowStatus,
} from "../src/lib/config/settings-types"

import { type FollowedWindow, DAY_MS, HOUR_MS, resolvePeriod, startOfUtcDay, startOfUtcWeek } from "../src/lib/budget/periods"
import { parseUsageRange } from "../src/lib/budget/reports/range"
import { displayToNanoAiu, nanoAiuToDisplay } from "../src/lib/budget/units"
import {
  BudgetLimitPutRequest,
  BudgetSettingsPatchRequest,
  BudgetSimulateRequest,
  BudgetSuggestRequest,
} from "../src/lib/config/settings-types"
import {
  type ReportContext,
  type ReportFilter,
  type ReportLimit,
  buildTimeline,
  rowInScope,
  simulate,
} from "./ui-harness-budget-reports"
import { buildSessions, suggest } from "./ui-harness-budget-sessions"

type Scope = BudgetLimitStatus["scope"]
type LimitReset = BudgetLimitStatus["limit_reset"]
type Unit = BudgetStatusResponse["display"]["unit"]

/** One stored limit, as `config.json` keeps it. */
interface StoredLimit {
  id: string
  label?: string
  scope: Scope
  /** nano-AIU */
  limit: number
  limitReset: LimitReset
  warnAt: number
  action: "block" | "warn" | "ask" | "pause"
}

/** A limit as a scenario describes it: sized so the current period is `fill` spent. */
interface LimitSeed {
  id: string
  label?: string
  scope: Scope
  limitReset: LimitReset
  warnAt?: number
  action: "block" | "warn" | "ask" | "pause"
  /** Share of the limit already spent (1.2 means over it). */
  fill: number
  /** nano-AIU reserved by calls in progress. */
  held?: number
  /** nano-AIU conservatively counted while final billing is unknown. */
  unreconciled?: number
}

export interface BudgetSeed {
  enabled: boolean
  unit: Unit
  /** False reads like a build with no usage database: no spend at all. */
  storageEnabled: boolean
  /** False for a first run: the ledger is empty, so nothing has been spent. */
  spending: boolean
  limits: ReadonlyArray<LimitSeed>
  /** Reusable filters (named sets of models, clients or plugins) a rule's scope can select. */
  filters?: ReadonlyArray<ReportFilter & { name: string }>
  /** Provider windows, dated relative to now. */
  windows: (nowMs: number) => Array<ProviderQuotaWindowStatus>
}

// ---- the made-up ledger ---------------------------------------------------

interface LedgerRow {
  atMs: number
  model: string
  plugin: string | null
  key: string
  provider: string
  nanoAiu: number
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** The session the requests belonged to; "" for none (unattributed). */
  sessionId: string
}

/** What one request of a kind of traffic uses, in tokens. */
interface TokenProfile {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** One kind of traffic and what it costs on an ordinary day (nano-AIU). */
const TRAFFIC: ReadonlyArray<{
  model: string
  plugin: string | null
  key: string
  daily: number
  requests: number
  tokens: TokenProfile
  /** The client the session ids are named for. */
  session: string | null
}> = [
  {
    model: "claude-sonnet-5-5",
    plugin: null,
    key: "claude-code",
    daily: 110_000_000_000,
    requests: 120,
    tokens: { input: 5200, output: 880, cacheRead: 31_000, cacheWrite: 2400 },
    session: "cc",
  },
  {
    model: "claude-opus-5",
    plugin: null,
    key: "claude-code",
    daily: 52_000_000_000,
    requests: 18,
    tokens: { input: 7400, output: 2100, cacheRead: 52_000, cacheWrite: 5200 },
    session: "cc",
  },
  {
    model: "claude-haiku-5-5",
    plugin: null,
    key: "claude-code",
    daily: 14_000_000_000,
    requests: 160,
    tokens: { input: 1800, output: 260, cacheRead: 9000, cacheWrite: 700 },
    session: "cc",
  },
  {
    model: "gpt-6.1-sol",
    plugin: null,
    key: "codex",
    daily: 62_000_000_000,
    requests: 64,
    tokens: { input: 6100, output: 1400, cacheRead: 22_000, cacheWrite: 0 },
    session: "cx",
  },
  {
    model: "gpt-6.1-mini",
    plugin: null,
    key: "codex",
    daily: 9_000_000_000,
    requests: 90,
    tokens: { input: 2200, output: 390, cacheRead: 7000, cacheWrite: 0 },
    session: "cx",
  },
  {
    model: "gemini-3.8-flash",
    plugin: null,
    key: "claude-desktop",
    daily: 7_000_000_000,
    requests: 44,
    tokens: { input: 3100, output: 640, cacheRead: 0, cacheWrite: 0 },
    // Claude Desktop sends no session id, so this lands in an unattributed pseudo-session.
    session: null,
  },
  {
    model: "gpt-image-2",
    plugin: "images",
    key: "claude-code",
    daily: 18_000_000_000,
    requests: 30,
    tokens: { input: 420, output: 1300, cacheRead: 0, cacheWrite: 0 },
    session: "cc",
  },
  {
    model: "gpt-5.6-luna",
    plugin: "decisions",
    key: "claude-code",
    daily: 2_000_000_000,
    requests: 40,
    tokens: { input: 900, output: 80, cacheRead: 0, cacheWrite: 0 },
    session: "cc",
  },
  // A model that costs nothing still has usage to show; the Dashboard lists it too.
  {
    model: "gpt-5-mini",
    plugin: null,
    key: "claude-desktop",
    daily: 0,
    requests: 70,
    tokens: { input: 1500, output: 300, cacheRead: 0, cacheWrite: 0 },
    session: null,
  },
]

/** A steady 0..1 value for a day and a kind of traffic, so a day always reads the same. */
function wobble(day: number, index: number): number {
  const x = Math.sin(day * 12.9898 + index * 78.233) * 43758.5453
  return x - Math.floor(x)
}

/** Working hours, busiest around midday: the weight of each of twelve hours (08:00 to 19:00 UTC). */
const HOUR_WEIGHTS = [0.4, 0.8, 1.2, 1.4, 1.1, 0.7, 1.1, 1.4, 1.5, 1.2, 0.8, 0.4]
const FIRST_HOUR = 8

/** Split `total` by `weights` into whole numbers, none negative, that add up to `total`. */
function split(total: number, weights: ReadonlyArray<number>): Array<number> {
  const sum = weights.reduce((a, b) => a + b, 0)
  const parts = weights.map((weight) => Math.floor((total * weight) / sum))
  let rest = total - parts.reduce((a, b) => a + b, 0)
  // The remainder goes to the heaviest hours first.
  const order = weights.map((_, index) => index).sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0))
  for (let step = 0; rest > 0; step += 1, rest -= 1) {
    const index = order[step % order.length] ?? 0
    parts[index] = (parts[index] ?? 0) + 1
  }
  return parts
}

/**
 * Every day from 35 days ago to today, spread over the working hours (today's
 * over the hours so far, so nothing is dated in the future); weekends are
 * quieter. A day's total is what it always was, so a limit's figures don't
 * depend on how it is cut into hours.
 */
function ledgerFor(nowMs: number): Array<LedgerRow> {
  const today = Math.floor(nowMs / DAY_MS)
  const nowHour = Math.floor((nowMs - today * DAY_MS) / HOUR_MS)
  const rows: Array<LedgerRow> = []
  for (let day = today - 35; day <= today; day += 1) {
    const weekday = new Date(day * DAY_MS).getUTCDay()
    const weekend = weekday === 0 || weekday === 6 ? 0.4 : 1
    // Today's hours end at this one; earlier days keep the working day.
    const hours =
      day === today ?
        Array.from({ length: Math.min(12, nowHour + 1) }, (_, i) => Math.max(0, nowHour - 11) + i)
      : HOUR_WEIGHTS.map((_, i) => FIRST_HOUR + i)
    const weights = hours.map((hour) => HOUR_WEIGHTS[Math.min(11, Math.max(0, hour - FIRST_HOUR))] ?? 0.5)
    TRAFFIC.forEach((traffic, index) => {
      const factor = (0.35 + 0.65 * wobble(day, index)) * weekend
      const nano = split(Math.round(traffic.daily * factor), weights)
      const requests = split(Math.max(1, Math.round(traffic.requests * factor)), weights)
      hours.forEach((hour, slot) => {
        const count = requests[slot] ?? 0
        if (count === 0 && (nano[slot] ?? 0) === 0) return
        const atMs = Math.min(day * DAY_MS + hour * HOUR_MS + 5 * 60_000, nowMs - 1)
        const block = hour < 12 ? "a" : hour < 15 ? "b" : "c"
        rows.push({
          atMs,
          model: traffic.model,
          plugin: traffic.plugin,
          key: traffic.key,
          provider: "copilot",
          nanoAiu: nano[slot] ?? 0,
          requests: count,
          inputTokens: count * traffic.tokens.input,
          outputTokens: count * traffic.tokens.output,
          cacheReadTokens: count * traffic.tokens.cacheRead,
          cacheWriteTokens: count * traffic.tokens.cacheWrite,
          sessionId: traffic.session ? `${traffic.session}-${new Date(day * DAY_MS).toISOString().slice(0, 10)}-${block}` : "",
        })
      })
    })
  }
  return rows
}

// ---- provider windows ----------------------------------------------------

function monthWindow(nowMs: number, percentRemaining: number): ProviderQuotaWindowStatus {
  const now = new Date(nowMs)
  const resetsAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  const previous = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  return {
    provider: "copilot",
    id: "premium_interactions",
    label: "Copilot premium allowance",
    unit: "credits",
    used: Math.round(1500 * (1 - percentRemaining / 100)),
    limit: 1500,
    percent_remaining: percentRemaining,
    resets_at: new Date(resetsAt).toISOString(),
    previous_resets_at: new Date(previous).toISOString(),
    kind: "fixed",
    duration_ms: null,
    scope: null,
    overage: { used: 0, permitted: true },
    observed_at: new Date(nowMs - 90_000).toISOString(),
    source: "header",
  }
}

function chatWindow(nowMs: number, percentRemaining: number): ProviderQuotaWindowStatus {
  return {
    ...monthWindow(nowMs, percentRemaining),
    id: "chat",
    label: "Copilot chat",
    unit: "requests",
    used: null,
    limit: null,
    overage: null,
  }
}

// ---- scenario seeds ------------------------------------------------------

const limitsSeed: BudgetSeed["limits"] = [
  {
    id: "everything",
    label: "Monthly cap",
    scope: { kind: "global" },
    limitReset: { follow: "copilot:premium_interactions" },
    action: "warn",
    fill: 0.46,
  },
  {
    id: "plugin-images-daily",
    label: "Images per day",
    scope: { kind: "plugin", id: "images" },
    limitReset: "daily",
    action: "block",
    fill: 0.86,
    held: 600_000_000,
    unreconciled: 200_000_000,
  },
  {
    id: "key-claude-code-daily",
    scope: { kind: "key", id: "claude-code" },
    limitReset: "daily",
    action: "block",
    fill: 0.31,
  },
  {
    id: "key-codex-weekly",
    scope: { kind: "key", id: "codex" },
    limitReset: "weekly",
    action: "block",
    fill: 1.12,
  },
]

/** Limits that are fine, nearly spent and spent, with activity and a month's allowance. */
export const budgetLimitsSeed: BudgetSeed = {
  enabled: true,
  unit: "usd",
  storageEnabled: true,
  spending: true,
  limits: limitsSeed,
  windows: (nowMs) => [monthWindow(nowMs, 62.4), chatWindow(nowMs, 8)],
}

/**
 * Rules that name models: a daily cap on every Claude model (a filter with a glob) and a weekly
 * warning on one OpenAI model, next to the others. The Models list marks the models these name.
 */
export const budgetFiltersSeed: BudgetSeed = {
  ...budgetLimitsSeed,
  filters: [
    { id: "claude-models", name: "Claude models", kind: "models", members: ["claude-*"] },
    { id: "gpt-sol", name: "GPT-6.1 Sol", kind: "models", members: ["gpt-6.1-sol"] },
  ],
  limits: [
    ...limitsSeed,
    {
      id: "claude-models-daily",
      label: "Claude models per day",
      scope: { kind: "filter", id: "claude-models" },
      limitReset: "daily",
      action: "block",
      fill: 0.58,
    },
    {
      id: "gpt-sol-weekly",
      scope: { kind: "filter", id: "gpt-sol" },
      limitReset: "weekly",
      action: "warn",
      fill: 0.9,
    },
  ],
}

/** The same limits with enforcement switched off: kept, listed, none refuses. */
export const budgetOffSeed: BudgetSeed = { ...budgetLimitsSeed, enabled: false }

/** Nothing configured yet, nothing spent: the first-run state. */
export const budgetEmptySeed: BudgetSeed = {
  enabled: true,
  unit: "usd",
  storageEnabled: true,
  spending: false,
  limits: [],
  windows: () => [],
}

/** No limits yet, but there is spend and a provider allowance to look at. */
export const budgetNoLimitsSeed: BudgetSeed = { ...budgetLimitsSeed, limits: [] }

/** Amounts shown in AI credits. */
export const budgetCreditsSeed: BudgetSeed = { ...budgetLimitsSeed, unit: "credits" }

/** A build with no usage database: every spend reads zero. */
export const budgetStorageOffSeed: BudgetSeed = { ...budgetLimitsSeed, storageEnabled: false }

// ---- the service ---------------------------------------------------------

const SCOPE_ORDER: Record<Scope["kind"], number> = {
  global: 0,
  provider: 1,
  plugin: 2,
  filter: 3,
  key: 4,
}

const ACTIVITY_GROUPS = new Set(["model", "plugin", "key", "provider", "day", "hour"])
const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const validationError = (message: string, details?: unknown): Response =>
  json({ error: { message, type: "validation_error", ...(details === undefined ? {} : { details }) } }, 400)

export interface BudgetMock {
  /** Answers `/settings/api/budget*`; null for any other path. */
  handle: (req: Request) => Promise<Response | null>
  /** The current status (what `budget.changed` carries). */
  status: () => BudgetStatusResponse
  /** Spend since the start of a period, grouped (what `/activity` answers). */
  activity: (period: string, group: string) => BudgetActivityResponse
  /** The ledger and clock the reports read, for tests that check them against the real ones. */
  reports: () => ReportContext
  /** Called after every change a request makes. Returns an unsubscribe. */
  onChange: (listener: (status: BudgetStatusResponse) => void) => () => void
}

export function createBudgetMock(seed: BudgetSeed): BudgetMock {
  const startedAt = Date.now()
  const ledger = seed.storageEnabled && seed.spending ? ledgerFor(startedAt) : []
  const windows = seed.windows(startedAt)
  const state = { enabled: seed.enabled, unit: seed.unit, creditUsd: 0.01 }
  const filters = seed.filters ?? []
  const inScope = (row: LedgerRow, scope: Scope): boolean => rowInScope(row, scope, filters)
  const listeners = new Set<(status: BudgetStatusResponse) => void>()
  const held = new Map<string, number>()
  const unreconciled = new Map<string, number>()

  const followable = (ref: string): FollowedWindow | undefined => {
    const found = windows.find((window) => `${window.provider}:${window.id}` === ref)
    if (!found) return undefined
    return {
      ...(found.resets_at ? { resetsAt: found.resets_at } : {}),
      ...(found.previous_resets_at ? { previousResetsAt: found.previous_resets_at } : {}),
      ...(found.kind ? { kind: found.kind } : {}),
      ...(found.duration_ms ? { durationMs: found.duration_ms } : {}),
    }
  }

  const spend = (scope: Scope, startMs: number, endMs: number | null): number =>
    ledger
      .filter((row) => inScope(row, scope) && row.atMs >= startMs && (endMs === null || row.atMs < endMs))
      .reduce((sum, row) => sum + row.nanoAiu, 0)

  // Size each seeded limit so the current period reads as `fill` spent, in
  // steps that look like amounts a person would type.
  const limits: Array<StoredLimit> = seed.limits.map((entry) => {
    const period = resolvePeriod(entry.limitReset, startedAt, followable)
    const usage = spend(entry.scope, period.startMs, period.endMs)
    const raw = usage > 0 ? usage / entry.fill : 50_000_000_000
    const step = raw >= 500_000_000_000 ? 50_000_000_000 : raw >= 100_000_000_000 ? 5_000_000_000 : 1_000_000_000
    const rounded = entry.fill >= 1 ? Math.floor(raw / step) * step : Math.ceil(raw / step) * step
    if (entry.held) held.set(entry.id, entry.held)
    if (entry.unreconciled) unreconciled.set(entry.id, entry.unreconciled)
    return {
      id: entry.id,
      ...(entry.label ? { label: entry.label } : {}),
      scope: entry.scope,
      limit: Math.max(step, rounded),
      limitReset: entry.limitReset,
      warnAt: entry.warnAt ?? 0.8,
      action: entry.action,
    }
  })

  const display = (): { unit: Unit; creditUsd: number } => ({ unit: state.unit, creditUsd: state.creditUsd })

  function limitStatus(entry: StoredLimit, nowMs: number): BudgetLimitStatus {
    const shown = display()
    const period = resolvePeriod(entry.limitReset, nowMs, followable)
    const usage = spend(entry.scope, period.startMs, period.endMs)
    const uncertain = Math.min(usage, unreconciled.get(entry.id) ?? 0)
    const remaining = Math.max(0, entry.limit - usage)
    const dayStart = startOfUtcDay(nowMs)
    return {
      id: entry.id,
      label: entry.label ?? null,
      scope: entry.scope,
      action: entry.action,
      warn_at: entry.warnAt,
      paused: 0,
      unit: "cost",
      measure: null,
      max_requests: null,
      requests: null,
      when: null,
      enforced: true,
      limit: entry.limit,
      effective_limit: entry.limit,
      limit_reset: entry.limitReset,
      limit_remaining: remaining,
      usage,
      held: held.get(entry.id) ?? 0,
      unreconciled: uncertain,
      usage_daily: spend(entry.scope, dayStart, dayStart + DAY_MS),
      usage_weekly: spend(entry.scope, startOfUtcWeek(nowMs), null),
      unreconciled_daily: uncertain,
      unreconciled_weekly: uncertain,
      period_start: new Date(period.startMs).toISOString(),
      resets_at: period.endMs === null ? null : new Date(period.endMs).toISOString(),
      reset_basis: period.basis,
      reset_estimated: period.estimated,
      state: usage >= entry.limit ? "exhausted" : usage >= entry.limit * entry.warnAt ? "warning" : "ok",
      notify: { warn: "notification", limit: "both" },
      overrides: [],
      approval: null,
      display: {
        limit: nanoAiuToDisplay(entry.limit, shown),
        effective_limit: nanoAiuToDisplay(entry.limit, shown),
        usage: nanoAiuToDisplay(usage, shown),
        unreconciled: nanoAiuToDisplay(uncertain, shown),
        limit_remaining: nanoAiuToDisplay(remaining, shown),
      },
    }
  }

  function status(): BudgetStatusResponse {
    const nowMs = Date.now()
    const budgets = [...limits]
      .sort((a, b) => SCOPE_ORDER[a.scope.kind] - SCOPE_ORDER[b.scope.kind] || a.id.localeCompare(b.id))
      .map((entry) => limitStatus(entry, nowMs))
    const blocking = budgets.filter((budget) => budget.action === "block")
    const spent = blocking.find((budget) => budget.state === "exhausted")
    const tightest = blocking.reduce<BudgetLimitStatus | undefined>(
      (best, budget) => (!best || budget.limit_remaining < best.limit_remaining ? budget : best),
      undefined,
    )
    return {
      enabled: state.enabled,
      display: { unit: state.unit, credit_usd: state.creditUsd },
      storage_enabled: seed.storageEnabled,
      budgets,
      effective_budget: (spent ?? tightest)?.id ?? null,
      provider_windows: windows,
      filters: filters.map((filter) => ({
        id: filter.id,
        name: filter.name,
        kind: filter.kind,
        members: [...filter.members],
        used_by: limits.filter((entry) => entry.scope.kind === "filter" && entry.scope.id === filter.id).map((entry) => entry.id),
      })),
    }
  }

  const emit = (): void => {
    const current = status()
    for (const listener of listeners) listener(current)
  }

  /**
   * What `/activity` answers: the ledger in the query's range, grouped, with the
   * Dashboard's measures per row and in `totals`. Free groups are kept only for
   * `include_free=true`, like the real route.
   */
  function activityFor(query: URLSearchParams): BudgetActivityResponse | { error: string } {
    const group = query.get("group") ?? "model"
    if (!ACTIVITY_GROUPS.has(group)) return { error: "group must be model, plugin, key, provider, day or hour" }
    const nowMs = Date.now()
    const parsed = parseUsageRange(
      {
        range: query.get("range") ?? undefined,
        from: query.get("from") ?? undefined,
        to: query.get("to") ?? undefined,
        period: query.get("period") ?? undefined,
      },
      nowMs,
      "day",
    )
    if (!parsed.ok) return { error: parsed.message }
    const { range } = parsed
    const keyOf = (row: LedgerRow): string | null =>
      group === "model" ? row.model
      : group === "plugin" ? row.plugin
      : group === "key" ? row.key
      : group === "provider" ? row.provider
      : group === "hour" ? `${new Date(row.atMs).toISOString().slice(0, 13)}:00:00Z`
      : new Date(row.atMs).toISOString().slice(0, 10)
    type Sum = { nano: number; requests: number; input: number; output: number; cacheRead: number; cacheWrite: number }
    const empty = (): Sum => ({ nano: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    const add = (sum: Sum, row: LedgerRow): Sum => ({
      nano: sum.nano + row.nanoAiu,
      requests: sum.requests + row.requests,
      input: sum.input + row.inputTokens,
      output: sum.output + row.outputTokens,
      cacheRead: sum.cacheRead + row.cacheReadTokens,
      cacheWrite: sum.cacheWrite + row.cacheWriteTokens,
    })
    const grouped = new Map<string | null, Sum>()
    let all = empty()
    for (const row of ledger) {
      if (row.atMs < range.fromMs || row.atMs >= range.toMs) continue
      all = add(all, row)
      const key = keyOf(row)
      grouped.set(key, add(grouped.get(key) ?? empty(), row))
    }
    const includeFree = query.get("include_free") === "true"
    const shown = display()
    const timeGroup = group === "day" || group === "hour"
    const rows = [...grouped.entries()]
      .filter(([, sum]) => includeFree || sum.nano > 0)
      .sort(([keyA, a], [keyB, b]) =>
        timeGroup ?
          String(keyA).localeCompare(String(keyB))
        : b.nano - a.nano || String(keyA).localeCompare(String(keyB)),
      )
      .map(([key, sum]) => ({
        key,
        nano_aiu: sum.nano,
        requests: sum.requests,
        amount: nanoAiuToDisplay(sum.nano, shown),
        input_tokens: sum.input,
        output_tokens: sum.output,
        cache_read_input_tokens: sum.cacheRead,
        cache_creation_input_tokens: sum.cacheWrite,
        total_tokens: sum.input + sum.output + sum.cacheRead + sum.cacheWrite,
      }))
    return {
      period:
        range.label === "day" || range.label === "week" || range.label === "month" ? range.label : "range",
      group: group as BudgetActivityResponse["group"],
      period_start: new Date(range.fromMs).toISOString(),
      display: { unit: state.unit, credit_usd: state.creditUsd },
      range: { from: new Date(range.fromMs).toISOString(), to: new Date(range.toMs).toISOString(), label: range.label },
      totals: {
        request_count: all.requests,
        input_tokens: all.input,
        output_tokens: all.output,
        cache_read_input_tokens: all.cacheRead,
        cache_creation_input_tokens: all.cacheWrite,
        total_tokens: all.input + all.output + all.cacheRead + all.cacheWrite,
        total_nano_aiu: all.nano,
      },
      rows,
    }
  }

  /** The original `period=day|week|month` form, for callers that name only that. */
  function activity(period: string, group: string): BudgetActivityResponse {
    const result = activityFor(new URLSearchParams({ period, group }))
    if ("error" in result) throw new Error(result.error)
    return result
  }

  const reportContext = (): ReportContext => ({
    rows: ledger,
    filters,
    nowMs: Date.now(),
    findWindow: followable,
    display: display(),
  })

  const reportLimit = (entry: StoredLimit): ReportLimit => ({
    id: entry.id,
    ...(entry.label ? { label: entry.label } : {}),
    scope: entry.scope,
    limit: entry.limit,
    limitReset: entry.limitReset,
    warnAt: entry.warnAt,
    action: entry.action,
  })

  const csvCell = (value: string): string => (/[",\n\r]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value)

  async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url)
    const path = url.pathname
    if (path !== "/settings/api/budget" && !path.startsWith("/settings/api/budget/")) return null
    const method = req.method

    if (path === "/settings/api/budget" && method === "GET") return json(status())

    if (path === "/settings/api/budget" && method === "PATCH") {
      const body = BudgetSettingsPatchRequest.safeParse(await req.json().catch(() => null))
      if (!body.success) return validationError("Invalid budget settings", body.error.issues)
      if (body.data.enabled !== undefined) state.enabled = body.data.enabled
      if (body.data.display_unit !== undefined) state.unit = body.data.display_unit
      emit()
      return json(status())
    }

    const timelinePath = /^\/settings\/api\/budget\/limits\/([^/]+)\/timeline$/.exec(path)
    if (timelinePath && method === "GET") {
      const entry = limits.find((existing) => existing.id === decodeURIComponent(timelinePath[1] ?? ""))
      if (!entry) return json({ error: { message: "Budget limit not found", type: "not_found" } }, 404)
      const params = url.searchParams
      const result = buildTimeline(reportContext(), reportLimit(entry), {
        range: params.get("range") ?? undefined,
        from: params.get("from") ?? undefined,
        to: params.get("to") ?? undefined,
        bucket: params.get("bucket") ?? undefined,
      })
      return "status" in result ? validationError(result.message) : json(result)
    }

    if (path === "/settings/api/budget/sessions" && method === "GET") {
      const params = url.searchParams
      const limit = Number(params.get("limit") ?? 100)
      const result = buildSessions(reportContext(), {
        range: params.get("range") ?? undefined,
        from: params.get("from") ?? undefined,
        to: params.get("to") ?? undefined,
        limit: Number.isFinite(limit) ? limit : 100,
      })
      return "status" in result ? validationError(result.message) : json(result)
    }

    if (path === "/settings/api/budget/suggest" && method === "POST") {
      const body = BudgetSuggestRequest.safeParse(await req.json().catch(() => null))
      if (!body.success) return validationError("Invalid suggestion request", body.error.issues)
      const result = suggest(reportContext(), body.data, new Set(limits.map((entry) => entry.id)))
      return "status" in result ? validationError(result.message) : json(result)
    }

    if (path === "/settings/api/budget/simulate" && method === "POST") {
      const body = BudgetSimulateRequest.safeParse(await req.json().catch(() => null))
      if (!body.success) return validationError("Invalid simulation request", body.error.issues)
      const drafts: Array<ReportLimit> = body.data.limits.map((entry, index) => ({
        id: entry.id ?? `draft-${index + 1}`,
        ...(entry.label === undefined ? {} : { label: entry.label }),
        scope: entry.scope,
        limit: entry.limit ?? displayToNanoAiu(entry.amount ?? 0, display()),
        limitReset: entry.limit_reset,
        warnAt: entry.warn_at ?? 0.8,
        action: entry.action,
      }))
      const result = simulate(reportContext(), body.data, drafts)
      return "status" in result ? validationError(result.message) : json(result)
    }

    const limitPath = /^\/settings\/api\/budget\/limits\/([^/]+)$/.exec(path)
    if (limitPath && method === "PUT") {
      const id = decodeURIComponent(limitPath[1] ?? "")
      if (!ID_PATTERN.test(id) || id.length > 64) {
        return validationError("Limit id must be lowercase letters and digits, separated by '.', '_' or '-'")
      }
      const body = BudgetLimitPutRequest.safeParse(await req.json().catch(() => null))
      if (!body.success) return validationError("Invalid budget limit", body.error.issues)
      const request = body.data
      const entry: StoredLimit = {
        id,
        ...(request.label === undefined ? {} : { label: request.label }),
        scope: request.scope,
        limit: request.limit ?? displayToNanoAiu(request.amount ?? 0, display()),
        limitReset: request.limit_reset,
        warnAt: request.warn_at ?? 0.8,
        action: request.action,
      }
      const index = limits.findIndex((existing) => existing.id === id)
      if (index === -1) limits.push(entry)
      else limits[index] = entry
      emit()
      return json(status())
    }
    if (limitPath && method === "DELETE") {
      const index = limits.findIndex((existing) => existing.id === decodeURIComponent(limitPath[1] ?? ""))
      if (index === -1) return json({ error: { message: "Budget limit not found", type: "not_found" } }, 404)
      limits.splice(index, 1)
      emit()
      return json(status())
    }

    if ((path === "/settings/api/budget/activity" || path === "/settings/api/budget/activity.csv") && method === "GET") {
      const result = activityFor(url.searchParams)
      if ("error" in result) return validationError(result.error)
      if (path.endsWith(".csv")) {
        const lines = [
          `${result.group},nano_aiu,requests,amount_${result.display.unit},input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens,total_tokens`,
        ]
        for (const row of result.rows) {
          lines.push(
            [
              csvCell(row.key ?? ""),
              row.nano_aiu,
              row.requests,
              row.amount,
              row.input_tokens ?? 0,
              row.output_tokens ?? 0,
              row.cache_read_input_tokens ?? 0,
              row.cache_creation_input_tokens ?? 0,
              row.total_tokens ?? 0,
            ].join(","),
          )
        }
        return new Response(`${lines.join("\n")}\n`, {
          status: 200,
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="maximal-budget-${result.group}-${result.range?.label ?? result.period}.csv"`,
          },
        })
      }
      return json(result)
    }

    return json({ error: { message: `harness: unhandled ${method} ${path}` } }, 404)
  }

  return {
    handle,
    status,
    activity,
    reports: reportContext,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
