/**
 * Wire contracts of the Budget (Rules) reports, re-exported by
 * `~/lib/config/settings-types` (the shell imports them from there): what-if
 * simulation, per-session cost and suggested rules. Amounts are integer
 * nano-AIU, each also given in the display unit.
 */

import { z } from "zod"

import {
  BudgetDisplayUnit,
  BudgetLimitAction,
  BudgetLimitId,
  BudgetLimitReset,
  BudgetScope,
  BudgetWarnAt,
  CreditUsdRate,
  NanoAiuAmount,
} from "./schema"
import { BudgetUsageTotals } from "./wire"

/** The range a report body asks for: a named one, or `from` (and `to`, else
 *  now) as ISO instants. */
export const BudgetReportRangeInput = z.union([
  z.enum(["24h", "7d", "30d", "90d", "all"]),
  z.object({ from: z.string(), to: z.string().optional() }).strict(),
])
export type BudgetReportRangeInput = z.infer<typeof BudgetReportRangeInput>

/** The range as resolved at request time (`to` is exclusive). */
export const BudgetReportRange = z.object({
  from: z.string(),
  to: z.string(),
  label: z.enum(["24h", "7d", "30d", "90d", "all", "custom"]),
})

/** A rule being tried: the fields of a PUT body, `id` optional (the reply
 *  names it `draft-<n>` when absent). Give the amount as `limit` (nano-AIU)
 *  or `amount` (display unit). */
export const BudgetSimulateLimit = z
  .object({
    id: BudgetLimitId.optional(),
    label: z.string().trim().min(1).max(128).optional(),
    scope: BudgetScope,
    limit: NanoAiuAmount.optional(),
    amount: z.number().min(0).optional(),
    limit_reset: BudgetLimitReset,
    warn_at: BudgetWarnAt.optional(),
    action: BudgetLimitAction,
  })
  .strict()
  .refine(
    (body) => (body.limit === undefined) !== (body.amount === undefined),
    {
      message: "give exactly one of limit (nano-AIU) or amount (display unit)",
      path: ["limit"],
    },
  )
export type BudgetSimulateLimit = z.infer<typeof BudgetSimulateLimit>

/** Body of POST /settings/api/budget/simulate. `range` defaults to `30d`. */
export const BudgetSimulateRequest = z
  .object({
    limits: z.array(BudgetSimulateLimit).min(1).max(20),
    range: BudgetReportRangeInput.optional(),
  })
  .strict()
export type BudgetSimulateRequest = z.infer<typeof BudgetSimulateRequest>

export const BudgetSimulatedPeriod = z.object({
  start: z.string(),
  /** Null for a rule that never resets. */
  end: z.string().nullable(),
  estimated: z.boolean(),
  /** What the scope spent in the period with no rule in force. */
  spend_nano_aiu: NanoAiuAmount,
  refused_requests: z.number().int().min(0),
  refused_nano_aiu: NanoAiuAmount,
  warned_at: z.string().nullable(),
  tripped_at: z.string().nullable(),
})

export const BudgetSimulationResult = z.object({
  id: BudgetLimitId,
  label: z.string().nullable(),
  scope: BudgetScope,
  limit: NanoAiuAmount,
  limit_reset: BudgetLimitReset,
  warn_at: BudgetWarnAt,
  action: BudgetLimitAction,
  /** `rolling` rules have no periods: the period fields are null or empty. */
  mode: z.enum(["periods", "rolling"]),
  /** Requests the rule covers in the range, and their cost with no rule. */
  matched_requests: z.number().int().min(0),
  matched_nano_aiu: NanoAiuAmount,
  /** What the rule would have let through. */
  admitted_nano_aiu: NanoAiuAmount,
  refused_requests: z.number().int().min(0),
  refused_nano_aiu: NanoAiuAmount,
  /** The first request that found the spend at the warning line, and at the
   *  limit (for a `warn` rule too, which refuses nothing); null if never. */
  warned_at: z.string().nullable(),
  tripped_at: z.string().nullable(),
  /** The most the scope spent in one period (a rolling rule: in one window)
   *  with no rule in force, and when (the period's start, or the moment). */
  peak: z.object({ nano_aiu: NanoAiuAmount, at: z.string().nullable() }),
  periods_total: z.number().int().min(0).nullable(),
  periods_warned: z.number().int().min(0).nullable(),
  periods_tripped: z.number().int().min(0).nullable(),
  /** The p90 of the periods' spend, so the rule would not have tripped most
   *  periods; null when the scope spent nothing. */
  suggested_nano_aiu: NanoAiuAmount.nullable(),
  display: z.object({
    limit: z.number().min(0),
    matched: z.number().min(0),
    refused: z.number().min(0),
    peak: z.number().min(0),
    suggested: z.number().min(0).nullable(),
  }),
  periods: z.array(BudgetSimulatedPeriod),
})
export type BudgetSimulationResult = z.infer<typeof BudgetSimulationResult>

/** POST /settings/api/budget/simulate: each draft replayed on its own over
 *  the usage in the range, in time order, through the real scope and period
 *  math. Deterministic; nothing is applied. */
export const BudgetSimulateResponse = z.object({
  range: BudgetReportRange,
  display: z.object({ unit: BudgetDisplayUnit, credit_usd: CreditUsdRate }),
  /** Recorded requests the replay read (before each draft's scope). */
  requests_replayed: z.number().int().min(0),
  /** In the order of the request. */
  results: z.array(BudgetSimulationResult),
})
export type BudgetSimulateResponse = z.infer<typeof BudgetSimulateResponse>

export const BudgetSessionModel = z.object({
  model: z.string(),
  requests: z.number().int().min(0),
  nano_aiu: NanoAiuAmount,
  /** `nano_aiu` in the display unit. */
  amount: z.number().min(0),
  /** The model's share of the session's spend (0 to 1). */
  share: z.number().min(0).max(1),
})

export const BudgetSession = z.object({
  /** The recorded session id, or `other:<client>` for requests that carried
   *  none. */
  id: z.string(),
  /** False for an `other:<client>` pseudo-session. */
  attributed: z.boolean(),
  client: z.string(),
  client_label: z.string().nullable(),
  /** The key the session's spend counts under, for a key-scoped rule. */
  key: z.string(),
  started_at: z.string(),
  ended_at: z.string(),
  duration_ms: z.number().int().min(0),
  requests: z.number().int().min(0),
  nano_aiu: NanoAiuAmount,
  amount: z.number().min(0),
  usage: BudgetUsageTotals,
  /** Biggest spender first. */
  models: z.array(BudgetSessionModel),
})

/** GET /settings/api/budget/sessions?range=|from=&to=&limit=: what each
 *  session cost, biggest first. Sessions are the rows that share a
 *  `session_id`; Maximal records no title or project for one. `limit`
 *  (default 100, at most 500) cuts the list, not `totals`. */
export const BudgetSessionsResponse = z.object({
  range: BudgetReportRange,
  display: z.object({ unit: BudgetDisplayUnit, credit_usd: CreditUsdRate }),
  sessions: z.array(BudgetSession),
  total_sessions: z.number().int().min(0),
  totals: BudgetUsageTotals,
})
export type BudgetSessionsResponse = z.infer<typeof BudgetSessionsResponse>

/** The persona presets of GET /settings/api/budget/presets. */
export const BudgetPersonaId = z.enum([
  "trying-things-out",
  "daily-driver",
  "heavy-agent-use",
  "team",
])
export type BudgetPersonaId = z.infer<typeof BudgetPersonaId>

/** Body of POST /settings/api/budget/suggest: the sessions to size rules
 *  from (`session_ids`, or `sessionIds`), or a `range` of all usage; both
 *  narrow it. With `session_ids` and no range, the range runs from the
 *  sessions' first request to now. `range` defaults to `30d` when there are
 *  no sessions. `persona` picks the shape (a preset's id); without one the
 *  suggestion is a daily and weekly cap plus a daily cap for any plugin with
 *  a big share. */
export const BudgetSuggestRequest = z
  .object({
    session_ids: z.array(z.string().min(1).max(200)).min(1).max(200).optional(),
    sessionIds: z.array(z.string().min(1).max(200)).min(1).max(200).optional(),
    range: BudgetReportRangeInput.optional(),
    persona: BudgetPersonaId.optional(),
  })
  .strict()
export type BudgetSuggestRequest = z.infer<typeof BudgetSuggestRequest>

/** A draft rule: the fields of a `BudgetPresetLimit` with a concrete scope,
 *  plus how it was sized and what it would have done. */
export const BudgetSuggestedRule = z.object({
  id: BudgetLimitId,
  label: z.string(),
  scope: BudgetScope,
  limit: NanoAiuAmount,
  /** `limit` in the display unit. */
  amount: z.number().min(0),
  limit_reset: BudgetLimitReset,
  warn_at: BudgetWarnAt,
  action: BudgetLimitAction,
  basis: z.object({
    /** The share of periods the limit fits: 0.9, or 1 (the busiest period)
     *  when most periods were quiet. */
    percentile: z.number().min(0).max(1),
    /** Null for a rolling rule (sampled hourly). */
    periods_observed: z.number().int().min(0).nullable(),
    peak_nano_aiu: NanoAiuAmount,
    /** The figure the limit was sized to, before rounding up. */
    sized_to_nano_aiu: NanoAiuAmount,
    /** The scope's share of all the spend considered (0 to 1). */
    share: z.number().min(0).max(1),
  }),
  /** The rule replayed over the same usage. */
  projection: z.object({
    periods_total: z.number().int().min(0).nullable(),
    periods_tripped: z.number().int().min(0).nullable(),
    refused_requests: z.number().int().min(0),
    refused_nano_aiu: NanoAiuAmount,
  }),
})

/** POST /settings/api/budget/suggest: draft rules sized from real usage, for
 *  the editor to open. Nothing is applied. */
export const BudgetSuggestResponse = z.object({
  range: BudgetReportRange,
  display: z.object({ unit: BudgetDisplayUnit, credit_usd: CreditUsdRate }),
  persona: BudgetPersonaId.nullable(),
  /** Distinct recorded session ids among the usage considered. */
  sessions_considered: z.number().int().min(0),
  requests_considered: z.number().int().min(0),
  nano_aiu_considered: NanoAiuAmount,
  limits: z.array(BudgetSuggestedRule),
  /** `no_spend`: nothing to size against; `short_history`: under two weeks,
   *  so no weekly rule. */
  notes: z.array(z.enum(["no_spend", "short_history"])),
})
export type BudgetSuggestResponse = z.infer<typeof BudgetSuggestResponse>
