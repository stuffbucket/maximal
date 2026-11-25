/**
 * Draft rules from real usage: size each rule to what the usage actually
 * looked like, in the shape a persona preset (`~/lib/budget/presets`) suggests.
 *
 * The amount of a rule is the p90 of the spend its scope had in each of its
 * periods (a rolling window: sampled hourly), rounded up to two significant
 * figures in the display unit, so the rule would not have tripped most
 * periods. A scope that spent in fewer than one period in ten has a p90 of 0;
 * its rule is sized to its busiest period instead. Each draft carries the replay of itself over that usage
 * (`projection`), so the person sees what it would have refused before
 * opening it in the editor. Nothing is applied here.
 *
 * Pure: usage rows, clock and provider windows come in as arguments.
 */

import type { BudgetPersonaId } from "~/lib/config/settings-types"

import type { BudgetLimitReset, BudgetScope } from "../schema"
import type { BudgetDisplay } from "../units"
import type { SimulationContext, UsageEventRow } from "./simulate"

import { slugOf } from "../presets"
import { displayToNanoAiu, nanoAiuToDisplay } from "../units"
import { simulateDraft } from "./simulate"

/** A plugin or key that carries at least this share of the spend gets a rule
 *  of its own when no persona narrows the shape. */
const OWN_RULE_SHARE = 0.2
/** Per-key rules stop here, so a long-lived install doesn't get a wall. */
const MAX_KEY_RULES = 10
/** Weekly sizing needs more than a week of history to say anything. */
const MIN_WEEKLY_SPAN_MS = 14 * 86_400_000

export type SuggestionNote = "no_spend" | "short_history"

export interface SuggestedRule {
  id: string
  label: string
  scope: BudgetScope
  /** Nano-AIU. */
  limitNanoAiu: number
  limitReset: BudgetLimitReset
  warnAt: number
  action: "block" | "warn"
  basis: {
    /** The share of periods the amount fits: 0.9, or 1 (the busiest period)
     *  when most periods were quiet and the p90 is 0. */
    percentile: number
    /** Periods (rolling: hourly samples) the amount was sized against;
     *  null for a rolling window. */
    periodsObserved: number | null
    /** The most the scope spent in one period (window), and the figure the
     *  amount was sized to before rounding. */
    peakNanoAiu: number
    sizedToNanoAiu: number
    /** This scope's share of all the spend considered (0 to 1). */
    share: number
  }
  /** The rule replayed over the same usage. */
  projection: {
    periodsTotal: number | null
    periodsTripped: number | null
    refusedRequests: number
    refusedNanoAiu: number
  }
}

export interface SuggestionResult {
  rules: Array<SuggestedRule>
  notes: Array<SuggestionNote>
}

export interface SuggestInputs {
  rows: ReadonlyArray<UsageEventRow>
  persona?: BudgetPersonaId
  display: BudgetDisplay
  context: SimulationContext
  /** Ids already in use, so a draft doesn't collide. */
  existingIds: ReadonlySet<string>
}

interface Shape {
  id: string
  label: string
  scope: BudgetScope
  reset: BudgetLimitReset
}

const GLOBAL: BudgetScope = { kind: "global" }

/** The two significant figures at or above `value` (a display amount). */
export function roundUpNice(value: number): number {
  if (!(value > 0)) return 0
  const step = 10 ** (Math.floor(Math.log10(value)) - 1)
  // `toPrecision` strips the float noise `ceil(v / step) * step` leaves.
  return Number((Math.ceil(value / step - 1e-9) * step).toPrecision(12))
}

function spendBy(
  rows: ReadonlyArray<UsageEventRow>,
  pick: (row: UsageEventRow) => string | undefined,
): Array<[string, number]> {
  const totals = new Map<string, number>()
  for (const row of rows) {
    const key = pick(row)
    if (key === undefined) continue
    totals.set(key, (totals.get(key) ?? 0) + row.nanoAiu)
  }
  return [...totals.entries()]
    .filter(([, nano]) => nano > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

function shapesFor(
  inputs: SuggestInputs,
  spanMs: number,
  notes: Set<SuggestionNote>,
): Array<Shape> {
  const { rows, persona } = inputs
  const daily: Shape = {
    id: "daily-cap",
    label: "Daily cap",
    scope: GLOBAL,
    reset: "daily",
  }
  if (persona === "trying-things-out") return [daily]
  if (persona === "heavy-agent-use") {
    return [
      {
        id: "rolling-5h-cap",
        label: "Rolling 5-hour cap",
        scope: GLOBAL,
        reset: { every: { hours: 5 } },
      },
    ]
  }
  if (persona === "team") {
    return spendBy(rows, (row) => row.key)
      .slice(0, MAX_KEY_RULES)
      .map(([key]) => ({
        id: `${slugOf(key)}-daily`,
        label: `Daily cap for ${key}`,
        scope: { kind: "key", id: key },
        reset: "daily",
      }))
  }
  const shapes = [daily]
  if (spanMs >= MIN_WEEKLY_SPAN_MS) {
    shapes.push({
      id: "weekly-cap",
      label: "Weekly cap",
      scope: GLOBAL,
      reset: "weekly",
    })
  } else {
    notes.add("short_history")
  }
  if (persona === undefined) {
    const total = rows.reduce((sum, row) => sum + row.nanoAiu, 0)
    for (const [plugin, nano] of spendBy(rows, (row) => row.plugin)) {
      if (nano / total >= OWN_RULE_SHARE) {
        shapes.push({
          id: `${slugOf(plugin)}-daily`,
          label: `Daily cap for ${plugin}`,
          scope: { kind: "plugin", id: plugin },
          reset: "daily",
        })
      }
    }
  }
  return shapes
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  taken.add(id)
  return id
}

function draftRule(
  shape: Shape,
  id: string,
  basis: { inputs: SuggestInputs; totalNanoAiu: number },
): SuggestedRule | undefined {
  const { inputs, totalNanoAiu } = basis
  const { rows, display, context } = inputs
  const base = {
    id,
    scope: shape.scope,
    limitReset: shape.reset,
    warnAt: 0.8,
    action: "block" as const,
  }
  // Replay with a limit nothing reaches, only to read the scope's spend.
  const probe = simulateDraft(
    { ...base, limit: Number.MAX_SAFE_INTEGER },
    rows,
    context,
  )
  // Mostly quiet periods make the p90 0: size to the busiest one instead.
  const quiet = probe.suggestedNanoAiu === null
  const sizedTo = probe.suggestedNanoAiu ?? probe.peakNanoAiu
  if (sizedTo <= 0) return undefined
  const rounded = displayToNanoAiu(
    roundUpNice(nanoAiuToDisplay(sizedTo, display)),
    display,
  )
  const limitNanoAiu = Math.max(rounded, sizedTo)
  const projected = simulateDraft(
    { ...base, limit: limitNanoAiu },
    rows,
    context,
  )
  return {
    id,
    label: shape.label,
    scope: shape.scope,
    limitNanoAiu,
    limitReset: shape.reset,
    warnAt: base.warnAt,
    action: base.action,
    basis: {
      percentile: quiet ? 1 : 0.9,
      periodsObserved: probe.periodsTotal,
      peakNanoAiu: probe.peakNanoAiu,
      sizedToNanoAiu: sizedTo,
      share: totalNanoAiu === 0 ? 0 : probe.matchedNanoAiu / totalNanoAiu,
    },
    projection: {
      periodsTotal: projected.periodsTotal,
      periodsTripped: projected.periodsTripped,
      refusedRequests: projected.refusedRequests,
      refusedNanoAiu: projected.refusedNanoAiu,
    },
  }
}

/** Draft rules sized to the usage in `inputs.rows`. */
export function suggestRules(inputs: SuggestInputs): SuggestionResult {
  const notes = new Set<SuggestionNote>()
  const total = inputs.rows.reduce((sum, row) => sum + row.nanoAiu, 0)
  if (total === 0) return { rules: [], notes: ["no_spend"] }
  const spanMs = inputs.context.toMs - inputs.context.fromMs
  const taken = new Set(inputs.existingIds)
  const rules: Array<SuggestedRule> = []
  for (const shape of shapesFor(inputs, spanMs, notes)) {
    const rule = draftRule(shape, uniqueId(shape.id, taken), {
      inputs,
      totalNanoAiu: total,
    })
    if (rule) rules.push(rule)
  }
  return { rules, notes: [...notes] }
}
