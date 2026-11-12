/**
 * The budget service: holds and decisions over the configured limits.
 *
 * A caller about to make a billed call `reserve`s an estimate. Every enabled
 * limit whose scope covers the call is checked: `spent + held + estimate`
 * must fit under it, else the call is refused (a `block` limit) or warned
 * about (a `warn` limit, or a `block` one past its warning threshold). The
 * admitted call holds its estimate until it `commit`s (the hold is dropped;
 * the actual cost reaches the ledger through the usage row the caller
 * records) or `release`s (the call failed before it was billed).
 *
 * Spend comes from one source: `token_usage_events`. Each limit keeps a
 * ledger entry for its current period, loaded from the database when the
 * period starts (and when its scope or provider window changes) and kept
 * current from the usage rows recorded after, so a check never waits on the
 * database's write queue. Rows recorded while an entry loads are buffered and
 * added to it. A call with no estimate (chat, and server tools today) is
 * admitted while `spent + held < limit`: it can go over by what is in flight.
 *
 * Everything the service touches is injected: the clock, the config, the
 * database store, the provider windows and the usage stream. Between the
 * check and the hold there is no await, so concurrent callers can't both
 * claim the same room.
 */

import consola from "consola"
import { randomUUID } from "node:crypto"

import type { ApprovalState, LimitEvent } from "./approvals"
import type { BudgetRefusal } from "./errors"
import type { BudgetOverride } from "./overrides"
import type { BudgetPeriod, FollowedWindow } from "./periods"
import type { BudgetOperation, BudgetSubject, ResolvedScope } from "./scope"

import { limitApplies, type Presence } from "./conditions"
import {
  amountOf,
  metricOf,
  type Estimate,
  type RefusalUnit,
  type SpendMetric,
} from "./metric"
import { effectiveLimit, hasUnlimited } from "./overrides"
import { resolvePeriod, rollingPeriodEnd } from "./periods"
import {
  DEFAULT_WARN_AT,
  type BudgetConfig,
  type BudgetLimitConfig,
  type BudgetScope,
  type BudgetScopeKind,
} from "./schema"
import { resolveScope, scopeMatches } from "./scope"
import { resolveBudgetDisplay } from "./units"
import { refusalMessage } from "./wording"

/** What a caller knows before a billed call. */
export interface BudgetIntent extends BudgetSubject {
  operation: BudgetOperation
  /** The server tool's name, for `server_tool`. */
  tool?: string
  /** Best estimate of the call's cost in nano-AIU; 0 when it can't be
   *  estimated (the call is then admitted while its limits have room). */
  estimateNanoAiu: number
  /** Best estimate of the call's prompt and reply tokens, when the request
   *  says (a `max_tokens`); a token limit holds it. Absent means unknown. */
  estimateInputTokens?: number
  estimateOutputTokens?: number
}

export interface BudgetHold {
  readonly id: string
  /** What is held: the estimate, 0 when no limit covers the call. */
  readonly estimateNanoAiu: number
  /** The call finished (billed or not): drop the hold. Idempotent. */
  commit(actual?: { nanoAiu?: number }): void
  /** The call failed before it was billed, or was abandoned: drop the hold.
   *  Idempotent. */
  release(reason: "upstream-error" | "aborted" | "client-gone"): void
}

export interface BudgetWarning {
  limitId: string
  used: number
  limit: number
  /** What `used` and `limit` are in. */
  unit: SpendMetric
  resetsAtMs: number | null
}

export type BudgetDecision =
  | { ok: true; hold: BudgetHold; warnings: ReadonlyArray<BudgetWarning> }
  | { ok: false; refusal: BudgetRefusal }

export type BudgetCheck =
  | { ok: true; warnings: ReadonlyArray<BudgetWarning> }
  | { ok: false; refusal: BudgetRefusal }

export type BudgetEventKind = "approved" | "refused" | "warned"

/** A decision about one limit worth logging (`budget_events`): a call it
 *  refused, the first call to cross its warning threshold in a period, or a
 *  billed call admitted with an estimate held. */
export interface BudgetEvent {
  kind: BudgetEventKind
  atMs: number
  limitId: string
  scope: BudgetScope
  key: string
  operation: BudgetOperation
  estimateNanoAiu: number
  usedNanoAiu: number
  limitNanoAiu: number
}

/** A hold as the database keeps it, while it is open. */
export interface StoredHold {
  id: string
  createdAtMs: number
  operation: BudgetOperation
  provider?: string
  plugin?: string
  tool?: string
  model?: string
  key: string
  estimateNanoAiu: number
  estimateInputTokens: number
  estimateOutputTokens: number
}

export interface BudgetStore {
  /** What the scope's usage rows (and orphaned holds) spent in the range, in
   *  nano-AIU or the tokens of `metric`. */
  spend(
    scope: ResolvedScope,
    range: { startMs: number; endMs: number | null },
    metric: SpendMetric,
  ): Promise<number>
  /** At start: holds a previous run left open become `orphaned`, and old
   *  closed ones are pruned. */
  recover(nowMs: number): Promise<void>
  /** Every cost the scope's usage rows (and orphaned holds) incurred in the
   *  range, for a rolling window that counts each as it ages. */
  spendRows(
    scope: ResolvedScope,
    range: { startMs: number; endMs: number | null },
    metric: SpendMetric,
  ): Promise<ReadonlyArray<{ createdAtMs: number; nanoAiu: number }>>
  /** When each request the scope's usage rows recorded in the range was
   *  made, for a limit that caps requests. */
  requestTimes(
    scope: ResolvedScope,
    range: { startMs: number; endMs: number | null },
  ): Promise<ReadonlyArray<number>>
  openHold(hold: StoredHold): void
  closeHold(close: {
    id: string
    state: "committed" | "released"
    actualNanoAiu?: number
    closedAtMs: number
  }): void
}

/** One recorded usage row, as the ledger reads it. */
export interface SpendEvent extends BudgetSubject {
  createdAtMs: number
  nanoAiu: number
  /** Prompt tokens, cache reads included (`~/lib/budget/metric`). */
  inputTokens: number
  outputTokens: number
}

export interface BudgetService {
  /** Check the limits and, when the call is admitted, hold its estimate. */
  reserve(intent: BudgetIntent): Promise<BudgetDecision>
  /** The same check without a hold. */
  check(intent: BudgetIntent): Promise<BudgetCheck>
  /** What calls in progress hold that `scope` covers, in nano-AIU or the
   *  tokens of `metric`. */
  heldNanoAiu(scope: BudgetScope, metric?: SpendMetric): number
  /** Stop listening to usage; for tests and shutdown. */
  stop(): void
}

export interface BudgetServiceDeps {
  clock?: () => number
  config: () => BudgetConfig | undefined
  store: BudgetStore
  /** The provider windows limits follow; `ready` resolves once the persisted
   *  ones are loaded. */
  windows: {
    lookup(ref: string): FollowedWindow | undefined
    ready(): Promise<void>
  }
  /** Subscribe to recorded usage rows. Returns an unsubscribe. */
  spendEvents: (listener: (event: SpendEvent) => void) => () => void
  /** Called once per limit and period when a call first crosses the
   *  limit's warning threshold. */
  onWarning?: (warning: BudgetWarning) => void
  /** Called for each refusal, first warning and approved hold, to log it. */
  onEvent?: (event: BudgetEvent) => void
  /** The temporary overrides approvals granted: `ready` resolves once the
   *  stored ones are loaded. */
  overrides?: {
    ready?(): Promise<void>
    active(limitId: string, nowMs: number): ReadonlyArray<BudgetOverride>
  }
  /** Whether the person is away, for limits that apply only then. Without
   *  it, no such limit applies. */
  presence?: () => Presence | undefined
  /** An `ask` limit refused a call (not merely for calls in flight): asks
   *  the person, and says whether a request is waiting or they said no. */
  onAsk?: (event: LimitEvent) => ApprovalState
  /** Another limit refused a call, once per limit and period. */
  onLimitReached?: (event: LimitEvent) => void
  newId?: () => string
}

/** Said to the caller of an `ask` rule that refused: what to do next. */
const APPROVAL_REQUESTED =
  "Approval was requested in Maximal: allow more in the menu-bar list or the Rules window, then retry."

/** Widest scope first, for a stable order. */
const SCOPE_ORDER: Record<BudgetScopeKind, number> = {
  global: 0,
  provider: 1,
  plugin: 2,
  filter: 3,
  key: 4,
}

interface LedgerEntry {
  /** Scope and period this entry counts; a change reloads it. */
  key: string
  scope: ResolvedScope
  period: BudgetPeriod
  /** What the entry counts: nano-AIU, or one of the token measures. */
  metric: SpendMetric
  committed: number
  ready: boolean
  loading: Promise<void>
  /** Rows recorded while the entry loads. */
  buffered: Array<SpendEvent>
  /** A rolling window's counted costs; `committed` is their sum. Rows age
   *  out when the window moves (`advance`). */
  costs?: Array<{ createdAtMs: number; nanoAiu: number }>
  /** When each request in the period was made; kept for a limit that caps
   *  requests. */
  requests?: Array<number>
}

interface ActiveLimit {
  limit: BudgetLimitConfig
  entry: LedgerEntry
}

interface OpenHold {
  subject: BudgetSubject
  estimate: Estimate
}

const NO_HOLD = (id: string): BudgetHold => ({
  id,
  estimateNanoAiu: 0,
  commit() {},
  release() {},
})

function readFailed(error: unknown): [] {
  consola.warn("Budget: could not read spend; counting from now", error)
  return []
}

const whole = (value: number | undefined): number =>
  Math.max(0, Math.round(value ?? 0))

const estimateOf = (intent: BudgetIntent): number =>
  whole(intent.estimateNanoAiu)

const estimatesOf = (intent: BudgetIntent): Estimate => ({
  nanoAiu: estimateOf(intent),
  inputTokens: whole(intent.estimateInputTokens),
  outputTokens: whole(intent.estimateOutputTokens),
})

function inPeriod(period: BudgetPeriod, ms: number): boolean {
  return ms >= period.startMs && (period.endMs === null || ms < period.endMs)
}

function scopeKey(scope: ResolvedScope): string {
  if (scope.kind === "global") return "global"
  if (scope.kind === "members") {
    return `${scope.field}=${JSON.stringify(scope.members)}`
  }
  return `${scope.kind}:${scope.id}`
}

/** What a ledger entry counts: its scope and period. A rolling window's
 *  period moves with the clock, so only its length identifies it. */
function entryKeyOf(
  scope: ResolvedScope,
  period: BudgetPeriod,
  limit: BudgetLimitConfig,
): string {
  const counted = `${metricOf(limit)}${limit.maxRequests === undefined ? "" : "+requests"}`
  if (period.rollingMs !== undefined) {
    return `${scopeKey(scope)}|rolling:${period.rollingMs}|${counted}`
  }
  return `${scopeKey(scope)}|${period.startMs}|${period.endMs}|${counted}`
}

/** When a request cap resets: with the period, or for a rolling window the
 *  moment its oldest counted request ages out. */
function requestsResetMs(entry: LedgerEntry): number | null {
  if (entry.period.rollingMs === undefined) return entry.period.endMs
  let oldest: number | undefined
  for (const at of entry.requests ?? []) {
    if (oldest === undefined || at < oldest) oldest = at
  }
  return rollingPeriodEnd(oldest, entry.period.rollingMs)
}

/** When the entry's period resets: its end, or for a rolling window the
 *  moment its oldest counted cost ages out (null with none). */
function resetMsOf(entry: LedgerEntry): number | null {
  if (entry.period.rollingMs === undefined) return entry.period.endMs
  let oldest: number | undefined
  for (const cost of entry.costs ?? []) {
    if (oldest === undefined || cost.createdAtMs < oldest) {
      oldest = cost.createdAtMs
    }
  }
  return rollingPeriodEnd(oldest, entry.period.rollingMs)
}

/** The refusal that decides: one a reset must clear beats one that
 *  in-flight calls will clear, and the later reset beats the earlier. */
function decisive(
  refusals: ReadonlyArray<BudgetRefusal>,
): BudgetRefusal | undefined {
  const resetAt = (refusal: BudgetRefusal) =>
    refusal.resetsAtMs ?? Number.POSITIVE_INFINITY
  return [...refusals].sort(
    (a, b) =>
      Number(a.inFlight) - Number(b.inFlight) || resetAt(b) - resetAt(a),
  )[0]
}

// The service is one closure over its ledger and holds; splitting it would
// only pass that state around.
// eslint-disable-next-line max-lines-per-function
export function createBudgetService(deps: BudgetServiceDeps): BudgetService {
  const clock = deps.clock ?? Date.now
  const newId = deps.newId ?? randomUUID
  const entries = new Map<string, LedgerEntry>()
  const holds = new Map<string, OpenHold>()
  const warned = new Set<string>()
  const reached = new Set<string>()
  let started: Promise<void> | undefined
  let unsubscribe: (() => void) | undefined

  function onSpend(event: SpendEvent): void {
    for (const entry of entries.values()) {
      if (!entry.ready) {
        entry.buffered.push(event)
        continue
      }
      if (counts(entry, event)) add(entry, event)
    }
  }

  function add(entry: LedgerEntry, event: SpendEvent): void {
    const amount = amountOf(event, entry.metric)
    entry.committed += amount
    if (amount > 0) {
      entry.costs?.push({ createdAtMs: event.createdAtMs, nanoAiu: amount })
    }
    entry.requests?.push(event.createdAtMs)
  }

  function counts(entry: LedgerEntry, event: SpendEvent): boolean {
    return (
      inPeriod(entry.period, event.createdAtMs)
      && scopeMatches(entry.scope, event)
    )
  }

  function start(): Promise<void> {
    started ??= (async () => {
      await deps.windows.ready()
      await deps.overrides?.ready?.()
      await deps.store.recover(clock())
      unsubscribe = deps.spendEvents(onSpend)
    })()
    return started
  }

  function enforced(): ReadonlyArray<BudgetLimitConfig> {
    const budget = deps.config()
    if (budget?.enabled === false) return []
    return budget?.limits ?? []
  }

  function load(entry: LedgerEntry): Promise<void> {
    // The read starts here, synchronously: rows recorded from now on are
    // buffered, and rows recorded before are queued ahead of the read.
    const range = { startMs: entry.period.startMs, endMs: entry.period.endMs }
    const { metric } = entry
    const rolling = entry.costs !== undefined
    const read: Promise<Array<{ createdAtMs: number; nanoAiu: number }>> =
      rolling ?
        deps.store
          .spendRows(entry.scope, range, metric)
          .then((rows) => [...rows])
      : deps.store
          .spend(entry.scope, range, metric)
          .then((sum) => [{ createdAtMs: range.startMs, nanoAiu: sum }])
    const times: Promise<Array<number>> | undefined =
      entry.requests === undefined ?
        undefined
      : deps.store.requestTimes(entry.scope, range).then((rows) => [...rows])
    return Promise.all([read.catch(readFailed), times?.catch(readFailed)]).then(
      ([costs, requestTimes]) => {
        entry.committed = costs.reduce((sum, cost) => sum + cost.nanoAiu, 0)
        if (rolling) entry.costs = costs
        if (requestTimes !== undefined) entry.requests = requestTimes
        for (const event of entry.buffered) {
          if (counts(entry, event)) add(entry, event)
        }
        entry.buffered = []
        entry.ready = true
      },
    )
  }

  /** A rolling window moved on: costs older than it stop counting. */
  function advance(entry: LedgerEntry, period: BudgetPeriod): void {
    entry.period = period
    if (!entry.ready || entry.costs === undefined) return
    entry.costs = entry.costs.filter(
      (cost) => cost.createdAtMs >= period.startMs,
    )
    entry.committed = entry.costs.reduce((sum, cost) => sum + cost.nanoAiu, 0)
    entry.requests = entry.requests?.filter((at) => at >= period.startMs)
  }

  /** The entry for each limit that covers `subject`, created or reloaded
   *  when its period or scope changed. */
  function activeFor(subject: BudgetSubject): Array<ActiveLimit> {
    const limits = enforced()
    const nowMs = clock()
    const ids = new Set(limits.map((limit) => limit.id))
    for (const id of entries.keys()) if (!ids.has(id)) entries.delete(id)

    const filters = deps.config()?.filters
    const active: Array<ActiveLimit> = []
    for (const limit of limits) {
      const scope = resolveScope(limit.scope, filters)
      if (!scopeMatches(scope, subject)) continue
      const period = resolvePeriod(limit.limitReset, nowMs, (ref) =>
        deps.windows.lookup(ref),
      )
      const key = entryKeyOf(scope, period, limit)
      let entry = entries.get(limit.id)
      if (entry?.key === key) {
        if (period.rollingMs !== undefined) advance(entry, period)
      } else {
        entry = {
          key,
          scope,
          period,
          metric: metricOf(limit),
          committed: 0,
          ready: false,
          loading: Promise.resolve(),
          buffered: [],
          ...(period.rollingMs === undefined ? {} : { costs: [] }),
          ...(limit.maxRequests === undefined ? {} : { requests: [] }),
        }
        entries.set(limit.id, entry)
        entry.loading = load(entry)
      }
      active.push({ limit, entry })
    }
    return active.sort(
      (a, b) =>
        SCOPE_ORDER[a.limit.scope.kind] - SCOPE_ORDER[b.limit.scope.kind]
        || a.limit.id.localeCompare(b.limit.id),
    )
  }

  /** Active limits with every entry loaded. After the last await the caller
   *  checks and holds synchronously. */
  async function settled(subject: BudgetSubject): Promise<Array<ActiveLimit>> {
    if (enforced().length === 0) return []
    // Subscribed before any entry loads, so no recorded row falls between.
    await start()
    while (true) {
      const active = activeFor(subject)
      const pending = active.filter(({ entry }) => !entry.ready)
      if (pending.length === 0) return active
      await Promise.all(pending.map(({ entry }) => entry.loading))
    }
  }

  function heldFor(scope: ResolvedScope, metric: SpendMetric): number {
    let total = 0
    for (const hold of holds.values()) {
      if (scopeMatches(scope, hold.subject)) {
        total += amountOf(hold.estimate, metric)
      }
    }
    return total
  }

  /** A refusal's fields and sentence, in `unit`. */
  function refusalOf(
    { limit, entry }: ActiveLimit,
    figures: {
      unit: RefusalUnit
      limit: number
      used: number
      held: number
      requested: number
      resetsAtMs: number | null
      inFlight: boolean
    },
  ): BudgetRefusal {
    const display = resolveBudgetDisplay(deps.config())
    const words = {
      name: limit.label ?? limit.id,
      ...figures,
      nowMs: clock(),
      display,
      ...(entry.period.rollingMs === undefined ?
        {}
      : { rollingMs: entry.period.rollingMs }),
    }
    return {
      limitId: limit.id,
      label: limit.label ?? null,
      scope: limit.scope,
      ...figures,
      resetEstimated: entry.period.estimated,
      message: refusalMessage(words),
      creditUsd: display.creditUsd,
    }
  }

  function refusalFor(
    item: ActiveLimit,
    estimates: Estimate,
    cap: number,
  ): BudgetRefusal | undefined {
    const { entry } = item
    const estimate = amountOf(estimates, entry.metric)
    const used = entry.committed
    const held = heldFor(entry.scope, entry.metric)
    const total = used + held
    if (total < cap && total + estimate <= cap) return undefined
    return refusalOf(item, {
      unit: entry.metric,
      limit: cap,
      used,
      held,
      requested: estimate,
      resetsAtMs: resetMsOf(entry),
      inFlight: used < cap && used + estimate <= cap,
    })
  }

  /** The request cap, when this call would be one request too many. */
  function requestsRefusal(item: ActiveLimit): BudgetRefusal | undefined {
    const max = item.limit.maxRequests
    const used = item.entry.requests?.length ?? 0
    if (max === undefined || used < max) return undefined
    return refusalOf(item, {
      unit: "requests",
      limit: max,
      used,
      held: 0,
      requested: 1,
      resetsAtMs: requestsResetMs(item.entry),
      inFlight: false,
    })
  }

  function warningFor(
    { limit, entry }: ActiveLimit,
    estimates: Estimate,
    cap: number,
  ): BudgetWarning | undefined {
    const total =
      entry.committed
      + heldFor(entry.scope, entry.metric)
      + amountOf(estimates, entry.metric)
    const threshold = cap * (limit.warnAt ?? DEFAULT_WARN_AT)
    if (total < threshold) return undefined
    return {
      limitId: limit.id,
      used: entry.committed,
      limit: cap,
      unit: entry.metric,
      resetsAtMs: resetMsOf(entry),
    }
  }

  function evaluate(
    active: ReadonlyArray<ActiveLimit>,
    intent: BudgetIntent,
  ): { refusal?: BudgetRefusal; warnings: Array<BudgetWarning> } {
    const estimates = estimatesOf(intent)
    const refusals: Array<BudgetRefusal> = []
    const warnings: Array<BudgetWarning> = []
    for (const item of active) {
      // A limit that applies only while the person is away sits out the rest.
      if (!limitApplies(item.limit.when, deps.presence?.())) continue
      const overrides = deps.overrides?.active(item.limit.id, clock()) ?? []
      // An hour's allowance: the limit isn't enforced, nor warned about.
      if (hasUnlimited(overrides)) continue
      const cap = effectiveLimit(item.limit.limit, overrides)
      if (item.limit.action !== "warn") {
        const found = [
          refusalFor(item, estimates, cap),
          requestsRefusal(item),
        ].filter((refusal) => refusal !== undefined)
        if (found.length > 0) {
          for (const refusal of found) refusals.push(refused(item, refusal))
          logEvent("refused", item, intent)
          continue
        }
        reached.delete(`${item.limit.id}@${item.entry.key}`)
      }
      const warning = warningFor(item, estimates, cap)
      if (warning) warnings.push(warning)
    }
    return { refusal: decisive(refusals), warnings }
  }

  /** Tell the person a limit refused a call, and for an `ask` limit add
   *  whether approval is waiting. Calls in flight clearing on their own
   *  aren't the limit being reached. */
  function refused(
    { limit, entry }: ActiveLimit,
    refusal: BudgetRefusal,
  ): BudgetRefusal {
    if (refusal.inFlight) return refusal
    const event: LimitEvent = {
      limitId: limit.id,
      periodKey: entry.key,
      unit: refusal.unit,
      used: refusal.used,
      limit: refusal.limit,
      resetsAtMs: refusal.resetsAtMs,
    }
    try {
      if (limit.action === "ask") {
        const approval = deps.onAsk?.(event)
        if (approval === undefined) return refusal
        return {
          ...refusal,
          approval,
          message:
            approval === "pending" ?
              `${refusal.message} ${APPROVAL_REQUESTED}`
            : refusal.message,
        }
      }
      const key = `${limit.id}@${entry.key}`
      if (!reached.has(key)) {
        reached.add(key)
        deps.onLimitReached?.(event)
      }
    } catch (error) {
      consola.warn("Budget: a limit handler failed", error)
    }
    return refusal
  }

  /** Hand a decision to `onEvent`; a failing logger never fails a call. */
  function logEvent(
    kind: BudgetEventKind,
    { limit, entry }: ActiveLimit,
    intent: BudgetIntent,
  ): void {
    try {
      deps.onEvent?.({
        kind,
        atMs: clock(),
        limitId: limit.id,
        scope: limit.scope,
        key: intent.key,
        operation: intent.operation,
        // In the limit's own unit: nano-AIU, or tokens for a token limit.
        estimateNanoAiu: amountOf(estimatesOf(intent), entry.metric),
        usedNanoAiu: entry.committed,
        limitNanoAiu: effectiveLimit(
          limit.limit,
          deps.overrides?.active(limit.id, clock()) ?? [],
        ),
      })
    } catch (error) {
      consola.warn("Budget: an event handler failed", error)
    }
  }

  /** Tell `onWarning` once per limit and period. A rolling window has no
   *  period to start over, so a limit that drops back under its threshold
   *  is armed again. */
  function announce(
    active: ReadonlyArray<ActiveLimit>,
    warnings: ReadonlyArray<BudgetWarning>,
    intent: BudgetIntent,
  ): void {
    for (const item of active) {
      const { limit, entry } = item
      const warning = warnings.find(({ limitId }) => limitId === limit.id)
      const key = `${limit.id}@${entry.key}`
      if (!warning) {
        warned.delete(key)
        continue
      }
      if (warned.has(key)) continue
      warned.add(key)
      logEvent("warned", item, intent)
      try {
        deps.onWarning?.(warning)
      } catch (error) {
        consola.warn("Budget: a warning handler failed", error)
      }
    }
  }

  function openHold(intent: BudgetIntent): BudgetHold {
    const id = newId()
    const estimates = estimatesOf(intent)
    const estimate = estimates.nanoAiu
    const reserves =
      estimate > 0 || estimates.inputTokens > 0 || estimates.outputTokens > 0
    const subject: BudgetSubject = {
      key: intent.key,
      ...(intent.plugin === undefined ? {} : { plugin: intent.plugin }),
      ...(intent.provider === undefined ? {} : { provider: intent.provider }),
      ...(intent.model === undefined ? {} : { model: intent.model }),
    }
    holds.set(id, { subject, estimate: estimates })
    // Only a hold that reserves something is worth writing ahead.
    if (reserves) {
      deps.store.openHold({
        id,
        createdAtMs: clock(),
        operation: intent.operation,
        ...subject,
        ...(intent.tool === undefined ? {} : { tool: intent.tool }),
        estimateNanoAiu: estimate,
        estimateInputTokens: estimates.inputTokens,
        estimateOutputTokens: estimates.outputTokens,
      })
    }
    const close = (
      state: "committed" | "released",
      actualNanoAiu?: number,
    ): void => {
      if (!holds.delete(id)) return
      if (reserves) {
        deps.store.closeHold({
          id,
          state,
          ...(actualNanoAiu === undefined ? {} : { actualNanoAiu }),
          closedAtMs: clock(),
        })
      }
    }
    return {
      id,
      estimateNanoAiu: estimate,
      commit: (actual) => {
        close("committed", actual?.nanoAiu)
      },
      release: () => {
        close("released")
      },
    }
  }

  return {
    async reserve(intent) {
      const active = await settled(intent)
      if (active.length === 0) {
        return { ok: true, hold: NO_HOLD(newId()), warnings: [] }
      }
      // No await from here: the check and the hold are one step.
      const { refusal, warnings } = evaluate(active, intent)
      if (refusal) return { ok: false, refusal }
      const hold = openHold(intent)
      if (hold.estimateNanoAiu > 0) {
        for (const item of active) logEvent("approved", item, intent)
      }
      announce(active, warnings, intent)
      return { ok: true, hold, warnings }
    },

    async check(intent) {
      const active = await settled(intent)
      const { refusal, warnings } = evaluate(active, intent)
      if (refusal) return { ok: false, refusal }
      announce(active, warnings, intent)
      return { ok: true, warnings }
    },

    heldNanoAiu: (scope, metric = "nano_aiu") =>
      heldFor(resolveScope(scope, deps.config()?.filters), metric),

    stop() {
      unsubscribe?.()
      unsubscribe = undefined
    },
  }
}
