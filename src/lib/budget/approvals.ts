/**
 * What happens when a rule reaches its limit or warns, as far as the person
 * is concerned: native notices, the menu-bar attention list, and the choices
 * an `ask` rule puts to them.
 *
 * - A rule with `action: "ask"` refuses at its limit like `block`, and asks
 *   once per period (`ask`): a native notice and an attention entry with
 *   "Allow $X more", "Allow for 1 hour" and "Keep blocked". Allowing records
 *   a temporary override (`./overrides`); keeping blocked stops the asking
 *   until the period turns over.
 * - Any rule's first refusal in a period (`reached`) and first warning
 *   (`warned`) go where its `notify` setting says: a notice, an attention
 *   entry with a "Dismiss" action, both, or neither.
 *
 * Entries live in memory: after a restart the next refusal asks again.
 */

import type { PluginAttentionItem } from "~/lib/config/settings-types"

import type { RefusalUnit, SpendMetric } from "./metric"
import type { OverrideRegistry } from "./overrides"
import type { BudgetPeriod } from "./periods"
import type {
  BudgetConfig,
  BudgetLimitConfig,
  BudgetNotifyChannel,
} from "./schema"

import { metricOf } from "./metric"
import { resolveNotify } from "./notify"
import { resolveBudgetDisplay } from "./units"
import { formatUnitAmount } from "./wording"

/** What the shell calls these items; plugin ids can't be this. */
export const ATTENTION_SOURCE_ID = "budget"
const ATTENTION_NAME = "Rules"

/** "Allow $X more" defaults to this fraction of the limit. */
export const ALLOW_MORE_FRACTION = 0.25
export const ALLOW_HOUR_MS = 3_600_000

export type ApprovalChoice = "more" | "hour" | "keep" | "reset" | "resume"
export type ApprovalState = "pending" | "declined"

export interface BudgetNotice {
  code: "rule-ask" | "rule-limit" | "rule-paused" | "rule-warning"
  /** English text; the shell words the notification from it. */
  message: string
  params: Record<string, string>
}

/** A limit that refused a call, or a warning, as the center is told. */
export interface LimitEvent {
  limitId: string
  /** The period the event belongs to, so it is only told once. */
  periodKey: string
  /** What `used` and `limit` are in. */
  unit: RefusalUnit
  /** Used, and the limit in force (extra room included), in `unit`. */
  used: number
  limit: number
  /** When it resets, or for a rolling window when room starts to return. */
  resetsAtMs: number | null
}

export type ApprovalResult =
  | { ok: true }
  | {
      ok: false
      reason: "unknown-limit" | "nothing-asked" | "nothing-paused"
    }

export interface ApprovalCenter {
  /** A call was refused by an `ask` rule: asks once per period. Says
   *  whether a request is waiting or the person already said no. */
  ask(event: LimitEvent): ApprovalState
  /** A call was refused by a rule that doesn't ask. */
  reached(event: LimitEvent): void
  /** A rule crossed its warning threshold. */
  warned(event: LimitEvent): void
  /** A pause rule just held a request (so `heldCount` is above zero). */
  paused(event: LimitEvent): void
  /** Held requests came or went: a rule with none left has nothing to say. */
  heldChanged(): void
  /** What the rule is waiting on, if anything. */
  approval(limitId: string): ApprovalState | null
  /** Apply a decision. `amountNano` overrides the default for `more`. */
  approve(
    limitId: string,
    choice: ApprovalChoice,
    amountNano?: number,
  ): ApprovalResult
  /** Attention items for the shell. */
  items(): Array<PluginAttentionItem>
  /** Run an attention action by id. */
  run(actionId: string): boolean
}

export interface ApprovalCenterDeps {
  clock?: () => number
  config: () => BudgetConfig | undefined
  overrides: OverrideRegistry
  /** Show a native notification. */
  notice: (notice: BudgetNotice) => void
  /** Something a status shows changed. */
  changed: () => void
  /** Requests a pause rule is holding at a limit now. */
  heldCount?: (limitId: string) => number
  /** Make the held requests at a limit look at the budget again. */
  wake?: (limitId: string) => void
  /** Let the held requests through whatever the budget says; how many. */
  resumeHeld?: (limitId: string) => number
  /** Fail the held requests; how many. */
  cancelHeld?: (limitId: string) => number
  /** When extra room granted to `limit` now stops: see `overrideExpiry`. */
  expiryFor: (limit: BudgetLimitConfig) => number | null
}

/** When extra room granted in `period` ends: with the period, or for a
 *  rolling window one window from now; never, for a lifetime period. */
export function overrideExpiry(
  period: BudgetPeriod,
  nowMs: number,
): number | null {
  if (period.rollingMs !== undefined) return nowMs + period.rollingMs
  return period.endMs
}

/** "Allow $X more": a quarter of the limit, at least one nano-AIU. */
export function defaultExtraNanoAiu(limit: number): number {
  return Math.max(1, Math.round(limit * ALLOW_MORE_FRACTION))
}

type EntryKind = "ask" | "limit" | "pause" | "warn"

interface Entry {
  kind: EntryKind
  limitId: string
  /** The rule's label, else its id, as it read when this was noted. */
  label: string
  /** What "Allow more" offers: a quarter of the limit when it was noted, in
   *  the limit's unit (cost or tokens). */
  offeredNanoAiu: number
  offeredUnit: SpendMetric
  periodKey: string
  event: LimitEvent
  /** Listed in the attention items. */
  tray: boolean
  /** Dismissed from the list; kept so the period isn't told again. */
  dismissed: boolean
  expiresAtMs: number | null
}

interface Declined {
  periodKey: string
  untilMs: number | null
}

const entryId = (kind: string, limitId: string): string => `${kind}.${limitId}`

/** `allow-more.ask.images-daily` is verb `allow-more`, kind `ask`, and the
 *  limit id, which may itself contain dots. What names no entry is found to
 *  name nothing when it is looked up. */
function parseAction(actionId: string): {
  verb: string
  kind: string
  limitId: string
} {
  const [verb, kind, ...rest] = actionId.split(".")
  return { verb, kind, limitId: rest.join(".") }
}

const shows = (channel: BudgetNotifyChannel, where: "tray" | "notification") =>
  channel === "both" || channel === where

// The center is one closure over its entries; splitting it would only pass
// that state around.
// eslint-disable-next-line max-lines-per-function
export function createApprovalCenter(deps: ApprovalCenterDeps): ApprovalCenter {
  const clock = deps.clock ?? Date.now
  const entries = new Map<string, Entry>()
  const declined = new Map<string, Declined>()

  const findLimit = (limitId: string): BudgetLimitConfig | undefined =>
    deps.config()?.limits?.find((limit) => limit.id === limitId)

  const money = (amount: number, unit: RefusalUnit): string =>
    formatUnitAmount(amount, unit, resolveBudgetDisplay(deps.config()))

  /** A live entry: its limit still exists and its period hasn't ended. */
  function live(entry: Entry): boolean {
    if (!findLimit(entry.limitId)) return false
    return entry.expiresAtMs === null || clock() < entry.expiresAtMs
  }

  function liveEntry(kind: string, limitId: string): Entry | undefined {
    const entry = entries.get(entryId(kind, limitId))
    if (entry && !live(entry)) {
      entries.delete(entryId(kind, limitId))
      return undefined
    }
    return entry
  }

  function messageFor(entry: Entry): string {
    const { kind, label, event } = entry
    const figures = `${money(event.used, event.unit)} of ${money(event.limit, event.unit)} used`
    if (kind === "ask") {
      return `Rule "${label}" reached its limit: ${figures}. Requests are refused until you allow more. Choose in the Maximal menu or Rules.`
    }
    if (kind === "limit") {
      return `Rule "${label}" reached its limit: ${figures}. Requests are refused until it resets or is raised.`
    }
    if (kind === "pause") {
      const n = deps.heldCount?.(event.limitId) ?? 1
      return `Paused ${n} ${n === 1 ? "request" : "requests"}: rule "${label}" reached its limit (${figures}). Resume, allow more or cancel them from the Maximal menu or Rules.`
    }
    const percent = Math.round((event.used / Math.max(1, event.limit)) * 100)
    return `Rule "${label}" is at ${percent}% of its limit: ${figures}.`
  }

  const CODES = {
    ask: "rule-ask",
    limit: "rule-limit",
    pause: "rule-paused",
    warn: "rule-warning",
  } as const

  /** Record the event once per period and tell the person where the rule's
   *  `notify` setting says. */
  function note(kind: EntryKind, event: LimitEvent): void {
    const limit = findLimit(event.limitId)
    if (!limit) return
    if (liveEntry(kind, event.limitId)?.periodKey === event.periodKey) return
    const channel = resolveNotify(limit)[kind === "warn" ? "warn" : "limit"]
    const entry: Entry = {
      kind,
      limitId: event.limitId,
      label: limit.label ?? limit.id,
      offeredNanoAiu: defaultExtraNanoAiu(limit.limit),
      offeredUnit: metricOf(limit),
      periodKey: event.periodKey,
      event,
      tray: shows(channel, "tray"),
      dismissed: false,
      expiresAtMs: event.resetsAtMs,
    }
    entries.set(entryId(kind, event.limitId), entry)
    if (shows(channel, "notification")) {
      deps.notice({
        code: CODES[kind],
        message: messageFor(entry),
        params: { rule: event.limitId },
      })
    }
    deps.changed()
  }

  function isDeclined(event: LimitEvent): boolean {
    const choice = declined.get(event.limitId)
    if (choice?.periodKey !== event.periodKey) return false
    if (choice.untilMs === null || clock() < choice.untilMs) return true
    declined.delete(event.limitId)
    return false
  }

  function approve(
    limitId: string,
    choice: ApprovalChoice,
    amountNano?: number,
  ): ApprovalResult {
    const limit = findLimit(limitId)
    if (!limit) return { ok: false, reason: "unknown-limit" }
    const asked = liveEntry("ask", limitId)
    const nowMs = clock()
    switch (choice) {
      case "keep": {
        if (!asked) return { ok: false, reason: "nothing-asked" }
        declined.set(limitId, {
          periodKey: asked.periodKey,
          untilMs: asked.expiresAtMs,
        })

        break
      }
      case "more": {
        deps.overrides.add({
          limitId,
          kind: "extra",
          extraNanoAiu: amountNano ?? defaultExtraNanoAiu(limit.limit),
          createdAtMs: nowMs,
          expiresAtMs: deps.expiryFor(limit),
        })
        declined.delete(limitId)

        break
      }
      case "resume": {
        if ((deps.heldCount?.(limitId) ?? 0) === 0) {
          return { ok: false, reason: "nothing-paused" }
        }
        deps.resumeHeld?.(limitId)

        break
      }
      default: {
        // An hour, or until the period resets when it has an end.
        const reset = choice === "reset" ? deps.expiryFor(limit) : null
        deps.overrides.add({
          limitId,
          kind: "unlimited",
          extraNanoAiu: 0,
          createdAtMs: nowMs,
          expiresAtMs: reset ?? nowMs + ALLOW_HOUR_MS,
        })
        declined.delete(limitId)
      }
    }
    entries.delete(entryId("ask", limitId))
    if (choice !== "keep" && choice !== "resume") deps.wake?.(limitId)
    deps.changed()
    return { ok: true }
  }

  /** "Allow $X more", unless the limit is a request cap: more room is in
   *  the limit's unit, so it can't lift one. */
  function moreActions(
    entry: Entry,
    id: string,
  ): PluginAttentionItem["actions"] {
    if (entry.event.unit === "requests") return []
    return [
      {
        id: `allow-more.${id}`,
        label: `Allow ${money(entry.offeredNanoAiu, entry.offeredUnit)} more: ${entry.label}`,
        ...(entry.kind === "ask" ? { kind: "primary" as const } : {}),
      },
    ]
  }

  function attentionItem(entry: Entry): PluginAttentionItem {
    const { kind, limitId, label } = entry
    const id = entryId(kind, limitId)
    const base = { plugin: ATTENTION_SOURCE_ID, name: ATTENTION_NAME }
    if (kind === "pause") {
      return {
        ...base,
        summary: messageFor(entry),
        actions: [
          {
            id: `resume-once.${id}`,
            label: `Resume once: ${label}`,
            kind: "primary",
          },
          ...moreActions(entry, id),
          { id: `resume-reset.${id}`, label: `Resume until reset: ${label}` },
          {
            id: `cancel.${id}`,
            label: `Cancel paused requests: ${label}`,
            kind: "destructive",
          },
        ],
      }
    }
    if (kind !== "ask") {
      return {
        ...base,
        summary: messageFor(entry),
        actions: [{ id: `dismiss.${id}`, label: `Dismiss: ${label}` }],
      }
    }
    return {
      ...base,
      summary: messageFor(entry),
      actions: [
        ...moreActions(entry, id),
        { id: `allow-hour.${id}`, label: `Allow for 1 hour: ${label}` },
        {
          id: `keep-blocked.${id}`,
          label: `Keep blocked: ${label}`,
          kind: "secondary",
        },
      ],
    }
  }

  /** An answer to a request for more room. */
  function runAsk(verb: string, entry: Entry): boolean {
    const { limitId } = entry
    switch (verb) {
      case "allow-more": {
        if (entry.event.unit === "requests") return false
        return approve(limitId, "more").ok
      }
      case "allow-hour": {
        return approve(limitId, "hour").ok
      }
      case "keep-blocked": {
        return approve(limitId, "keep").ok
      }
      default: {
        return false
      }
    }
  }

  /** An answer to requests a pause rule is holding. */
  function runPause(verb: string, entry: Entry): boolean {
    const { limitId } = entry
    switch (verb) {
      case "resume-once": {
        return approve(limitId, "resume").ok
      }
      case "resume-reset": {
        return approve(limitId, "reset").ok
      }
      case "cancel": {
        return (deps.cancelHeld?.(limitId) ?? 0) > 0
      }
      case "allow-more": {
        return entry.event.unit !== "requests" && approve(limitId, "more").ok
      }
      default: {
        return false
      }
    }
  }

  return {
    ask(event) {
      if (isDeclined(event)) return "declined"
      note("ask", event)
      return "pending"
    },
    reached: (event) => {
      note("limit", event)
    },
    warned: (event) => {
      note("warn", event)
    },
    paused: (event) => {
      note("pause", event)
    },
    heldChanged() {
      for (const entry of entries.values()) {
        if (
          entry.kind === "pause"
          && (deps.heldCount?.(entry.limitId) ?? 0) === 0
        ) {
          entries.delete(entryId("pause", entry.limitId))
        }
      }
      deps.changed()
    },
    approval(limitId) {
      if (liveEntry("ask", limitId)) return "pending"
      const choice = declined.get(limitId)
      if (!choice) return null
      if (choice.untilMs !== null && clock() >= choice.untilMs) {
        declined.delete(limitId)
        return null
      }
      return "declined"
    },
    approve,
    items() {
      const items: Array<PluginAttentionItem> = []
      for (const entry of entries.values()) {
        // A pause entry is only worth showing while something is held.
        const nothingHeld =
          entry.kind === "pause" && (deps.heldCount?.(entry.limitId) ?? 0) === 0
        if (!live(entry) || nothingHeld) {
          entries.delete(entryId(entry.kind, entry.limitId))
          continue
        }
        if (entry.tray && !entry.dismissed) items.push(attentionItem(entry))
      }
      return items
    },
    run(actionId) {
      const { verb, kind, limitId } = parseAction(actionId)
      if (verb === "dismiss") {
        const entry = liveEntry(kind, limitId)
        if (!entry || entry.dismissed || !entry.tray || kind === "ask") {
          return false
        }
        entry.dismissed = true
        deps.changed()
        return true
      }
      const entry = liveEntry(kind, limitId)
      if (!entry) return false
      if (kind === "pause") return runPause(verb, entry)
      if (kind !== "ask") return false
      return runAsk(verb, entry)
    },
  }
}
