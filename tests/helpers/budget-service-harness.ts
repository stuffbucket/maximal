/**
 * A harness for the budget service tests: an injected clock, config, store,
 * provider windows and usage stream, so nothing touches the real database or
 * module-mocks anything.
 */

import type { FollowedWindow } from "~/lib/budget/periods"
import type { BudgetConfig } from "~/lib/budget/schema"

import { scopeMatches } from "~/lib/budget/scope"
import {
  createBudgetService,
  type BudgetIntent,
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
  setWindow(ref: string, window: FollowedWindow | undefined): void
  /** Record a usage row: stored, then announced, like the real recorder. */
  emit(row: SpendEvent): void
  rows: Array<SpendEvent>
  warnings: Array<BudgetWarning>
  /** Usage listeners currently subscribed. */
  listening(): number
  calls: {
    config: number
    spend: Array<{ startMs: number; endMs: number | null }>
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
    /** `none`: no `onWarning` dependency; `throws`: a handler that fails. */
    onWarning?: "none" | "throws"
  } = {},
): Harness {
  let now = NOON
  let config: BudgetConfig | undefined = {
    limits,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
  }
  const windows = new Map<string, FollowedWindow>()
  const rows: Array<SpendEvent> = []
  const listeners = new Set<(row: SpendEvent) => void>()
  const warnings: Array<BudgetWarning> = []
  let deferred: { started(): void; gate: Promise<void> } | undefined
  const calls: Harness["calls"] = {
    config: 0,
    spend: [],
    recover: 0,
    subscribed: 0,
    opened: [],
    closed: [],
  }

  const store: BudgetStore = {
    async spend(scope, range) {
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
        .reduce((total, row) => total + row.nanoAiu, 0)
      if (deferred) {
        deferred.started()
        await deferred.gate
      }
      return sum
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
