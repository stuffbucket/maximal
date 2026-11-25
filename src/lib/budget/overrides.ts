/**
 * Temporary overrides of a limit: what an approval grants.
 *
 * - `extra`: more room on top of the limit, until `expiresAtMs` (the end of
 *   the period it was granted in, so it never outlives it; null for a limit
 *   that never resets).
 * - `unlimited`: the limit isn't enforced until `expiresAtMs`.
 *
 * Pure helpers over a list, and a registry that keeps the live list in memory
 * (the service reads it synchronously on every check) and writes each change
 * through to storage so overrides survive a restart.
 */

import { randomUUID } from "node:crypto"

export type OverrideKind = "extra" | "unlimited"

export interface BudgetOverride {
  id: string
  limitId: string
  kind: OverrideKind
  /** Nano-AIU of extra room for `extra`; 0 for `unlimited`. */
  extraNanoAiu: number
  createdAtMs: number
  /** Null: it lasts until it is removed. */
  expiresAtMs: number | null
}

/** Whether an override still applies at `nowMs`. */
export function isActive(override: BudgetOverride, nowMs: number): boolean {
  return override.expiresAtMs === null || nowMs < override.expiresAtMs
}

/** The limit plus every `extra` override's room. */
export function effectiveLimit(
  limit: number,
  overrides: ReadonlyArray<BudgetOverride>,
): number {
  let total = limit
  for (const override of overrides) {
    if (override.kind === "extra") total += override.extraNanoAiu
  }
  return total
}

export function hasUnlimited(
  overrides: ReadonlyArray<BudgetOverride>,
): boolean {
  return overrides.some((override) => override.kind === "unlimited")
}

/** Where overrides persist. */
export interface OverrideStorage {
  load(): Promise<ReadonlyArray<BudgetOverride>>
  save(override: BudgetOverride): void
  remove(id: string): void
}

export interface OverrideRegistry {
  /** Resolves once the stored overrides are loaded. */
  ready(): Promise<void>
  /** The overrides in force for a limit at `nowMs`. */
  active(limitId: string, nowMs: number): Array<BudgetOverride>
  /** Every override in force at `nowMs`, oldest first. */
  list(nowMs: number): Array<BudgetOverride>
  add(input: Omit<BudgetOverride, "id">): BudgetOverride
  /** True when there was one to remove. */
  remove(id: string): boolean
  /** Remove every override of a limit; the count removed. */
  removeForLimit(limitId: string): number
}

export interface OverrideRegistryDeps {
  storage?: OverrideStorage
  newId?: () => string
}

export function createOverrideRegistry(
  deps: OverrideRegistryDeps = {},
): OverrideRegistry {
  const newId = deps.newId ?? randomUUID
  const overrides = new Map<string, BudgetOverride>()
  let loading: Promise<void> | undefined

  function ready(): Promise<void> {
    loading ??= (async () => {
      const stored = (await deps.storage?.load()) ?? []
      for (const override of stored) {
        // Added since the load began, so it is newer than what was stored.
        if (!overrides.has(override.id)) overrides.set(override.id, override)
      }
    })()
    return loading
  }

  function inForce(nowMs: number): Array<BudgetOverride> {
    return [...overrides.values()]
      .filter((override) => isActive(override, nowMs))
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
  }

  return {
    ready,
    active: (limitId, nowMs) =>
      inForce(nowMs).filter((override) => override.limitId === limitId),
    list: inForce,
    add(input) {
      const override = { ...input, id: newId() }
      overrides.set(override.id, override)
      deps.storage?.save(override)
      return override
    },
    remove(id) {
      if (!overrides.delete(id)) return false
      deps.storage?.remove(id)
      return true
    },
    removeForLimit(limitId) {
      let removed = 0
      for (const override of overrides.values()) {
        if (override.limitId !== limitId) continue
        overrides.delete(override.id)
        deps.storage?.remove(override.id)
        removed += 1
      }
      return removed
    },
  }
}
