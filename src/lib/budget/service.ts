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

import type { BudgetRefusal } from "./errors"
import type { BudgetPeriod, FollowedWindow } from "./periods"
import type { BudgetOperation, BudgetSubject } from "./scope"

import { resolvePeriod } from "./periods"
import {
  DEFAULT_WARN_AT,
  type BudgetConfig,
  type BudgetLimitConfig,
  type BudgetScope,
  type BudgetScopeKind,
} from "./schema"
import { scopeMatches } from "./scope"
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
  resetsAtMs: number | null
}

export type BudgetDecision =
  | { ok: true; hold: BudgetHold; warnings: ReadonlyArray<BudgetWarning> }
  | { ok: false; refusal: BudgetRefusal }

export type BudgetCheck =
  | { ok: true; warnings: ReadonlyArray<BudgetWarning> }
  | { ok: false; refusal: BudgetRefusal }

/** A hold as the database keeps it, while it is open. */
export interface StoredHold {
  id: string
  createdAtMs: number
  operation: BudgetOperation
  provider?: string
  plugin?: string
  tool?: string
  key: string
  estimateNanoAiu: number
}

export interface BudgetStore {
  /** Nano-AIU the scope's usage rows (and orphaned holds) spent in the range. */
  spend(
    scope: BudgetScope,
    range: { startMs: number; endMs: number | null },
  ): Promise<number>
  /** At start: holds a previous run left open become `orphaned`, and old
   *  closed ones are pruned. */
  recover(nowMs: number): Promise<void>
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
}

export interface BudgetService {
  /** Check the limits and, when the call is admitted, hold its estimate. */
  reserve(intent: BudgetIntent): Promise<BudgetDecision>
  /** The same check without a hold. */
  check(intent: BudgetIntent): Promise<BudgetCheck>
  /** Nano-AIU currently held by calls in progress that `scope` covers. */
  heldNanoAiu(scope: BudgetScope): number
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
  newId?: () => string
}

/** Widest scope first, for a stable order. */
const SCOPE_ORDER: Record<BudgetScopeKind, number> = {
  global: 0,
  provider: 1,
  plugin: 2,
  key: 3,
}

interface LedgerEntry {
  /** Scope and period this entry counts; a change reloads it. */
  key: string
  scope: BudgetScope
  period: BudgetPeriod
  committed: number
  ready: boolean
  loading: Promise<void>
  /** Rows recorded while the entry loads. */
  buffered: Array<SpendEvent>
}

interface ActiveLimit {
  limit: BudgetLimitConfig
  entry: LedgerEntry
}

interface OpenHold {
  subject: BudgetSubject
  estimateNanoAiu: number
}

const NO_HOLD = (id: string): BudgetHold => ({
  id,
  estimateNanoAiu: 0,
  commit() {},
  release() {},
})

const estimateOf = (intent: BudgetIntent): number =>
  Math.max(0, Math.round(intent.estimateNanoAiu))

function inPeriod(period: BudgetPeriod, ms: number): boolean {
  return ms >= period.startMs && (period.endMs === null || ms < period.endMs)
}

function scopeKey(scope: BudgetScope): string {
  return scope.kind === "global" ? "global" : `${scope.kind}:${scope.id}`
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
  let started: Promise<void> | undefined
  let unsubscribe: (() => void) | undefined

  function onSpend(event: SpendEvent): void {
    for (const entry of entries.values()) {
      if (!entry.ready) {
        entry.buffered.push(event)
        continue
      }
      if (counts(entry, event)) entry.committed += event.nanoAiu
    }
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
    return deps.store
      .spend(entry.scope, {
        startMs: entry.period.startMs,
        endMs: entry.period.endMs,
      })
      .catch((error: unknown) => {
        consola.warn("Budget: could not read spend; counting from now", error)
        return 0
      })
      .then((sum) => {
        entry.committed = sum
        for (const event of entry.buffered) {
          if (counts(entry, event)) entry.committed += event.nanoAiu
        }
        entry.buffered = []
        entry.ready = true
      })
  }

  /** The entry for each limit that covers `subject`, created or reloaded
   *  when its period or scope changed. */
  function activeFor(subject: BudgetSubject): Array<ActiveLimit> {
    const limits = enforced()
    const nowMs = clock()
    const ids = new Set(limits.map((limit) => limit.id))
    for (const id of entries.keys()) if (!ids.has(id)) entries.delete(id)

    const active: Array<ActiveLimit> = []
    for (const limit of limits) {
      if (!scopeMatches(limit.scope, subject)) continue
      const period = resolvePeriod(limit.limitReset, nowMs, (ref) =>
        deps.windows.lookup(ref),
      )
      const key = `${scopeKey(limit.scope)}|${period.startMs}|${period.endMs}`
      let entry = entries.get(limit.id)
      if (entry?.key !== key) {
        entry = {
          key,
          scope: limit.scope,
          period,
          committed: 0,
          ready: false,
          loading: Promise.resolve(),
          buffered: [],
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

  function heldFor(scope: BudgetScope): number {
    let total = 0
    for (const hold of holds.values()) {
      if (scopeMatches(scope, hold.subject)) total += hold.estimateNanoAiu
    }
    return total
  }

  function refusalFor(
    { limit, entry }: ActiveLimit,
    estimate: number,
  ): BudgetRefusal | undefined {
    const used = entry.committed
    const held = heldFor(limit.scope)
    const total = used + held
    if (total < limit.limit && total + estimate <= limit.limit) return undefined
    const inFlight = used < limit.limit && used + estimate <= limit.limit
    const display = resolveBudgetDisplay(deps.config())
    const nowMs = clock()
    const words = {
      name: limit.label ?? limit.id,
      limit: limit.limit,
      used,
      held,
      requested: estimate,
      resetsAtMs: entry.period.endMs,
      nowMs,
      inFlight,
      display,
    }
    return {
      limitId: limit.id,
      label: limit.label ?? null,
      scope: limit.scope,
      limit: limit.limit,
      used,
      held,
      requested: estimate,
      resetsAtMs: entry.period.endMs,
      resetEstimated: entry.period.estimated,
      inFlight,
      message: refusalMessage(words),
      creditUsd: display.creditUsd,
    }
  }

  function warningFor(
    { limit, entry }: ActiveLimit,
    estimate: number,
  ): BudgetWarning | undefined {
    const total = entry.committed + heldFor(limit.scope) + estimate
    const threshold = limit.limit * (limit.warnAt ?? DEFAULT_WARN_AT)
    if (total < threshold) return undefined
    return {
      limitId: limit.id,
      used: entry.committed,
      limit: limit.limit,
      resetsAtMs: entry.period.endMs,
    }
  }

  function evaluate(
    active: ReadonlyArray<ActiveLimit>,
    estimate: number,
  ): { refusal?: BudgetRefusal; warnings: Array<BudgetWarning> } {
    const refusals: Array<BudgetRefusal> = []
    const warnings: Array<BudgetWarning> = []
    for (const item of active) {
      if (item.limit.action === "block") {
        const refusal = refusalFor(item, estimate)
        if (refusal) {
          refusals.push(refusal)
          continue
        }
      }
      const warning = warningFor(item, estimate)
      if (warning) warnings.push(warning)
    }
    return { refusal: decisive(refusals), warnings }
  }

  /** Tell `onWarning` once per limit and period. */
  function announce(
    active: ReadonlyArray<ActiveLimit>,
    warnings: ReadonlyArray<BudgetWarning>,
  ): void {
    for (const { limit, entry } of active) {
      const warning = warnings.find(({ limitId }) => limitId === limit.id)
      if (!warning) continue
      const key = `${limit.id}@${entry.key}`
      if (warned.has(key)) continue
      warned.add(key)
      try {
        deps.onWarning?.(warning)
      } catch (error) {
        consola.warn("Budget: a warning handler failed", error)
      }
    }
  }

  function openHold(intent: BudgetIntent): BudgetHold {
    const id = newId()
    const estimate = estimateOf(intent)
    const subject: BudgetSubject = {
      key: intent.key,
      ...(intent.plugin === undefined ? {} : { plugin: intent.plugin }),
      ...(intent.provider === undefined ? {} : { provider: intent.provider }),
    }
    holds.set(id, { subject, estimateNanoAiu: estimate })
    // Only a hold that reserves something is worth writing ahead.
    if (estimate > 0) {
      deps.store.openHold({
        id,
        createdAtMs: clock(),
        operation: intent.operation,
        ...subject,
        ...(intent.tool === undefined ? {} : { tool: intent.tool }),
        estimateNanoAiu: estimate,
      })
    }
    const close = (
      state: "committed" | "released",
      actualNanoAiu?: number,
    ): void => {
      if (!holds.delete(id)) return
      if (estimate > 0) {
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
      const { refusal, warnings } = evaluate(active, estimateOf(intent))
      if (refusal) return { ok: false, refusal }
      const hold = openHold(intent)
      announce(active, warnings)
      return { ok: true, hold, warnings }
    },

    async check(intent) {
      const active = await settled(intent)
      const { refusal, warnings } = evaluate(active, estimateOf(intent))
      if (refusal) return { ok: false, refusal }
      announce(active, warnings)
      return { ok: true, warnings }
    },

    heldNanoAiu: heldFor,

    stop() {
      unsubscribe?.()
      unsubscribe = undefined
    },
  }
}
