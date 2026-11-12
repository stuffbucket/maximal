/**
 * A harness for the budget service tests: an injected clock, config, store,
 * provider windows and usage stream, so nothing touches the real database or
 * module-mocks anything.
 */

import type { ApprovalState, LimitEvent } from "~/lib/budget/approvals"
import type { Presence } from "~/lib/budget/conditions"
import type { FollowedWindow } from "~/lib/budget/periods"
import type { BudgetConfig } from "~/lib/budget/schema"

import { amountOf } from "~/lib/budget/metric"
import { scopeMatches } from "~/lib/budget/scope"
import {
  createBudgetService,
  type BudgetEvent,
  type BudgetIntent,
  type BudgetServiceDeps,
  type BudgetStore,
  type BudgetWarning,
  type SpendEvent,
  type StoredHold,
} from "~/lib/budget/service"

export const AIU = 1_000_000_000
export const NOON = Date.UTC(2026, 10, 11, 12, 0, 0)
export const MIDNIGHT = Date.UTC(2026, 10, 12, 0, 0, 0)

type Limit = NonNullable<BudgetConfig["limits"]>[number]

export function limit(overrides: Partial<Limit> & { id: string }): Limit {
  return {
    scope: { kind: "global" },
    limit: AIU,
    limitReset: "daily",
    action: "block",
    ...overrides,
  }
}

export function event(overrides: Partial<SpendEvent> = {}): SpendEvent {
  return {
    createdAtMs: NOON - 60_000,
    nanoAiu: 0,
    inputTokens: 0,
    outputTokens: 0,
    key: "claude-code",
    provider: "copilot",
    ...overrides,
  }
}

export function intent(overrides: Partial<BudgetIntent> = {}): BudgetIntent {
  return {
    operation: "images.generations",
    key: "claude-code",
    provider: "copilot",
    plugin: "images",
    estimateNanoAiu: 0,
    ...overrides,
  }
}

export interface Harness {
  service: ReturnType<typeof createBudgetService>
  setNow(ms: number): void
  setConfig(config: BudgetConfig | undefined): void
  /** Change what the shell reports; undefined is unknown. */
  setPresence(next: Presence | undefined): void
  setWindow(ref: string, window: FollowedWindow | undefined): void
  /** Record a usage row: stored, then announced, like the real recorder. */
  emit(row: SpendEvent): void
  rows: Array<SpendEvent>
  warnings: Array<BudgetWarning>
  /** What the service handed to `onEvent`. */
  events: Array<BudgetEvent>
  /** Usage listeners currently subscribed. */
  listening(): number
  calls: {
    config: number
    spend: Array<{ startMs: number; endMs: number | null }>
    /** How many of those reads were for every cost (rolling windows). */
    rowReads: number
    requestReads: number
    recover: number
    subscribed: number
    opened: Array<StoredHold>
    closed: Array<{
      id: string
      state: string
      actualNanoAiu?: number
      closedAtMs: number
    }>
  }
  /** Hold every store read until `releaseSpend()`. */
  deferSpend(): { started: Promise<void>; release(): void }
}

// The harness is one closure over the fake store, clock and listeners;
// splitting it would only pass that state around.
// eslint-disable-next-line max-lines-per-function
export function harness(
  limits: Array<Limit>,
  options: {
    spendFails?: boolean
    enabled?: boolean
    filters?: BudgetConfig["filters"]
    /** `none`: no `onWarning` dependency; `throws`: a handler that fails. */
    onWarning?: "none" | "throws"
    /** The approvals the service reads: overrides in force, and who is
     *  asked when a rule asks or reaches its limit. */
    /** What the shell last said about the person (unknown by default). */
    presence?: Presence
    approvals?: {
      overrides?: BudgetServiceDeps["overrides"]
      onAsk?: (event: LimitEvent) => ApprovalState
      onLimitReached?: (event: LimitEvent) => void
    }
  } = {},
): Harness {
  let now = NOON
  let presence: Presence | undefined = options.presence
  let config: BudgetConfig | undefined = {
    limits,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.filters === undefined ? {} : { filters: options.filters }),
  }
  const windows = new Map<string, FollowedWindow>()
  const rows: Array<SpendEvent> = []
  const listeners = new Set<(row: SpendEvent) => void>()
  const warnings: Array<BudgetWarning> = []
  const events: Array<BudgetEvent> = []
  let deferred: { started(): void; gate: Promise<void> } | undefined
  const calls: Harness["calls"] = {
    config: 0,
    spend: [],
    rowReads: 0,
    requestReads: 0,
    recover: 0,
    subscribed: 0,
    opened: [],
    closed: [],
  }

  const store: BudgetStore = {
    async spend(scope, range, metric) {
      calls.spend.push(range)
      if (options.spendFails) throw new Error("database is down")
      // Rows recorded before the read are in it; later ones are not.
      const sum = rows
        .filter(
          (row) =>
            row.createdAtMs >= range.startMs
            && (range.endMs === null || row.createdAtMs < range.endMs)
            && scopeMatches(scope, row),
        )
        .reduce((total, row) => total + amountOf(row, metric), 0)
      if (deferred) {
        deferred.started()
        await deferred.gate
      }
      return sum
    },
    async spendRows(scope, range, metric) {
      calls.spend.push(range)
      calls.rowReads += 1
      if (options.spendFails) throw new Error("database is down")
      const found = rows
        .filter(
          (row) =>
            amountOf(row, metric) > 0
            && row.createdAtMs >= range.startMs
            && (range.endMs === null || row.createdAtMs < range.endMs)
            && scopeMatches(scope, row),
        )
        .map((row) => ({
          createdAtMs: row.createdAtMs,
          nanoAiu: amountOf(row, metric),
        }))
      if (deferred) {
        deferred.started()
        await deferred.gate
      }
      return found
    },
    requestTimes(scope, range) {
      calls.requestReads += 1
      return Promise.resolve(
        rows
          .filter(
            (row) =>
              row.createdAtMs >= range.startMs
              && (range.endMs === null || row.createdAtMs < range.endMs)
              && scopeMatches(scope, row),
          )
          .map((row) => row.createdAtMs)
          .sort((a, b) => a - b),
      )
    },
    recover() {
      calls.recover += 1
      return Promise.resolve()
    },
    openHold(hold) {
      calls.opened.push(hold)
    },
    closeHold(close) {
      calls.closed.push(close)
    },
  }

  const service = createBudgetService({
    clock: () => now,
    config: () => {
      calls.config += 1
      return config
    },
    store,
    windows: {
      lookup: (ref) => windows.get(ref),
      ready: () => Promise.resolve(),
    },
    spendEvents: (listener) => {
      calls.subscribed += 1
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    ...options.approvals,
    presence: () => presence,
    onEvent: (logged) => {
      events.push(logged)
    },
    ...(options.onWarning === "none" ?
      {}
    : {
        onWarning: (warning: BudgetWarning) => {
          warnings.push(warning)
          if (options.onWarning === "throws") throw new Error("handler failed")
        },
      }),
  })

  return {
    service,
    setNow: (ms) => {
      now = ms
    },
    setConfig: (next) => {
      config = next
    },
    setPresence: (next) => {
      presence = next
    },
    setWindow: (ref, window) => {
      if (window) windows.set(ref, window)
      else windows.delete(ref)
    },
    emit: (row) => {
      rows.push(row)
      for (const listener of listeners) listener(row)
    },
    rows,
    warnings,
    events,
    listening: () => listeners.size,
    calls,
    deferSpend: () => {
      const gate = Promise.withResolvers<undefined>()
      const started = Promise.withResolvers<undefined>()
      deferred = {
        started: () => {
          started.resolve(undefined)
        },
        gate: gate.promise,
      }
      return {
        started: started.promise,
        release: () => {
          deferred = undefined
          gate.resolve(undefined)
        },
      }
    },
  }
}
