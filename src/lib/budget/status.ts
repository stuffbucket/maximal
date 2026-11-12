/**
 * The budget status snapshot served at `GET /settings/api/budget`: each limit
 * with its spend in the current period, the period's boundaries, its state,
 * and the provider quota windows observed so far. Field names follow
 * OpenRouter's `/api/v1/key` (`limit`, `limit_remaining`, `limit_reset`,
 * `usage`, `usage_daily`, `usage_weekly`).
 *
 * Read-only: nothing here admits, holds or refuses a request.
 */

import type {
  BudgetFilterStatus,
  BudgetLimitStatus,
  BudgetStatusResponse,
  ProviderQuotaWindowStatus,
} from "~/lib/config/settings-types"

import { getNanoAiuSpend, getOldestSpendMs } from "~/lib/token-usage/spend"
import { isTokenUsageStorageEnabled } from "~/lib/token-usage/store"

import type { ApprovalState } from "./approvals"
import type { BudgetOverride } from "./overrides"

import { resolveNotify } from "./notify"
import { effectiveLimit, hasUnlimited } from "./overrides"
import {
  fixedPeriod,
  resolvePeriod,
  rollingPeriodEnd,
  type BudgetPeriod,
  type FollowedWindow,
} from "./periods"
import {
  listProviderWindows,
  providerWindowRef,
  type ObservedProviderWindow,
} from "./provider-windows"
import {
  DEFAULT_WARN_AT,
  type BudgetConfig,
  type BudgetLimitConfig,
  type BudgetScope,
  type BudgetScopeKind,
} from "./schema"
import { resolveScope } from "./scope"
import {
  nanoAiuToDisplay,
  resolveBudgetDisplay,
  type BudgetDisplay,
} from "./units"

/** Status order: the widest scope first. */
const SCOPE_ORDER: Record<BudgetScopeKind, number> = {
  global: 0,
  provider: 1,
  plugin: 2,
  filter: 3,
  key: 4,
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function limitState(
  usage: number,
  limit: number,
  warnAt: number,
): BudgetLimitStatus["state"] {
  if (usage >= limit) return "exhausted"
  if (usage >= limit * warnAt) return "warning"
  return "ok"
}

interface StatusContext {
  nowMs: number
  filters: BudgetConfig["filters"]
  display: BudgetDisplay
  held: (scope: BudgetScope) => number
  overrides: (limitId: string) => ReadonlyArray<BudgetOverride>
  approval: (limitId: string) => ApprovalState | null
}

function overrideStatus(
  override: BudgetOverride,
  display: BudgetDisplay,
): BudgetLimitStatus["overrides"][number] {
  return {
    id: override.id,
    kind: override.kind,
    extra_nano_aiu: override.extraNanoAiu,
    extra: nanoAiuToDisplay(override.extraNanoAiu, display),
    created_at: iso(override.createdAtMs),
    expires_at:
      override.expiresAtMs === null ? null : iso(override.expiresAtMs),
  }
}

async function limitStatus(
  limit: BudgetLimitConfig,
  period: BudgetPeriod,
  { nowMs, display, held, filters, overrides, approval }: StatusContext,
): Promise<BudgetLimitStatus> {
  const scope = resolveScope(limit.scope, filters)
  const granted = overrides(limit.id)
  const cap = effectiveLimit(limit.limit, granted)
  const [[usage, usageDaily, usageWeekly], oldest] = await Promise.all([
    getNanoAiuSpend(scope, [
      period,
      fixedPeriod("daily", nowMs),
      fixedPeriod("weekly", nowMs),
    ]),
    // A rolling window resets when its oldest counted spend ages out.
    period.rollingMs === undefined ?
      undefined
    : getOldestSpendMs(scope, period),
  ])
  const endMs =
    period.rollingMs === undefined ?
      period.endMs
    : rollingPeriodEnd(oldest, period.rollingMs)
  const remaining = Math.max(0, cap - usage)
  const warnAt = limit.warnAt ?? DEFAULT_WARN_AT
  return {
    id: limit.id,
    label: limit.label ?? null,
    scope: limit.scope,
    action: limit.action,
    warn_at: warnAt,
    limit: limit.limit,
    effective_limit: cap,
    limit_reset: limit.limitReset,
    limit_remaining: remaining,
    usage,
    held: held(limit.scope),
    usage_daily: usageDaily,
    usage_weekly: usageWeekly,
    period_start: iso(period.startMs),
    resets_at: endMs === null ? null : iso(endMs),
    reset_basis: period.basis,
    reset_estimated: period.estimated,
    state: hasUnlimited(granted) ? "ok" : limitState(usage, cap, warnAt),
    notify: resolveNotify(limit),
    overrides: granted.map((override) => overrideStatus(override, display)),
    approval: approval(limit.id),
    display: {
      limit: nanoAiuToDisplay(limit.limit, display),
      effective_limit: nanoAiuToDisplay(cap, display),
      usage: nanoAiuToDisplay(usage, display),
      limit_remaining: nanoAiuToDisplay(remaining, display),
    },
  }
}

/** The blocking limit a request would hit first: one already spent, else the
 *  one with the least room. Warn-only limits never refuse, and one that is
 *  allowed for an hour isn't enforced, so neither counts. */
function effectiveBudget(
  budgets: ReadonlyArray<BudgetLimitStatus>,
): string | null {
  const blocking = budgets.filter(
    (budget) =>
      budget.action !== "warn"
      && !budget.overrides.some((override) => override.kind === "unlimited"),
  )
  const spent = blocking.find((budget) => budget.state === "exhausted")
  if (spent) return spent.id
  let tightest: BudgetLimitStatus | undefined
  for (const budget of blocking) {
    if (!tightest || budget.limit_remaining < tightest.limit_remaining) {
      tightest = budget
    }
  }
  return tightest?.id ?? null
}

function windowStatus(
  window: ObservedProviderWindow,
): ProviderQuotaWindowStatus {
  return {
    provider: window.provider,
    id: window.id,
    label: window.label,
    unit: window.unit,
    used: window.used ?? null,
    limit: window.limit ?? null,
    percent_remaining: window.percentRemaining ?? null,
    resets_at: window.resetsAt ?? null,
    previous_resets_at: window.previousResetsAt ?? null,
    kind: window.kind ?? null,
    duration_ms: window.durationMs ?? null,
    scope:
      window.scope ?
        {
          models: window.scope.models ?? null,
          model_class: window.scope.modelClass ?? null,
        }
      : null,
    overage:
      window.overage ?
        {
          used: window.overage.used ?? null,
          permitted: window.overage.permitted ?? null,
        }
      : null,
    observed_at: window.observedAt,
    source: window.source,
  }
}

/** Each filter, with the limits whose scope selects it. */
export function filterStatuses(
  budget: BudgetConfig | undefined,
): Array<BudgetFilterStatus> {
  return (budget?.filters ?? []).map((filter) => ({
    id: filter.id,
    name: filter.name,
    kind: filter.kind,
    members: filter.members,
    used_by: (budget?.limits ?? [])
      .filter(
        (limit) =>
          limit.scope.kind === "filter" && limit.scope.id === filter.id,
      )
      .map((limit) => limit.id),
  }))
}

export interface BudgetStatusOptions {
  nowMs?: number
  /** Defaults to the windows observed so far. */
  windows?: ReadonlyArray<ObservedProviderWindow>
  /** Nano-AIU calls in progress hold for a scope; none by default. */
  held?: (scope: BudgetScope) => number
  /** The overrides in force for a limit; none by default. */
  overrides?: (limitId: string) => ReadonlyArray<BudgetOverride>
  /** What an `ask` rule is waiting on; nothing by default. */
  approval?: (limitId: string) => ApprovalState | null
}

export async function buildBudgetStatus(
  budget: BudgetConfig | undefined,
  options: BudgetStatusOptions = {},
): Promise<BudgetStatusResponse> {
  const nowMs = options.nowMs ?? Date.now()
  const windows = options.windows ?? (await listProviderWindows())
  const byRef = new Map<string, FollowedWindow>(
    windows.map((window) => [providerWindowRef(window), window]),
  )
  const display = resolveBudgetDisplay(budget)
  const limits = [...(budget?.limits ?? [])].sort(
    (a, b) =>
      SCOPE_ORDER[a.scope.kind] - SCOPE_ORDER[b.scope.kind]
      || a.id.localeCompare(b.id),
  )
  const budgets = await Promise.all(
    limits.map((limit) =>
      limitStatus(
        limit,
        resolvePeriod(limit.limitReset, nowMs, (ref) => byRef.get(ref)),
        {
          nowMs,
          display,
          filters: budget?.filters,
          held: options.held ?? (() => 0),
          overrides: options.overrides ?? (() => []),
          approval: options.approval ?? (() => null),
        },
      ),
    ),
  )
  return {
    enabled: budget?.enabled !== false,
    display: { unit: display.unit, credit_usd: display.creditUsd },
    storage_enabled: isTokenUsageStorageEnabled(),
    budgets,
    effective_budget: effectiveBudget(budgets),
    filters: filterStatuses(budget),
    provider_windows: windows.map((window) => windowStatus(window)),
  }
}
