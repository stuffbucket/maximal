/**
 * The wire contracts of `/settings/api/budget` (`GET` status, presets,
 * filters, rules export and import, activity and timelines, and the
 * `PUT`/`PATCH` bodies). `~/lib/config/settings-types` re-exports them, so
 * the shell and the routes import them from there as before.
 */

import { z } from "zod"

import {
  BudgetDisplayUnit,
  BudgetFilterId,
  BudgetFilterKind,
  BudgetFilterMember,
  BudgetLimitAction,
  BudgetLimitId,
  BudgetLimitReset,
  BudgetNotifyChannel,
  BudgetScope,
  BudgetWarnAt,
  CreditUsdRate,
  NanoAiuAmount,
} from "./schema"

// ── Budget (/settings/api/budget) ───────────────────────────────────────
//
// Amounts are integer nano-AIU (10⁻⁹ AI credit); each limit also carries
// them in the display unit (`display.unit`) so the shell never converts.

export const BudgetLimitState = z.enum(["ok", "warning", "exhausted"])

/** Where a rule's warning and its limit being reached are told. */
export const BudgetNotifyStatus = z.object({
  warn: BudgetNotifyChannel,
  limit: BudgetNotifyChannel,
})
export type BudgetNotifyStatus = z.infer<typeof BudgetNotifyStatus>

/** Room or time an approval granted a rule, in force until `expires_at`. */
export const BudgetOverrideStatus = z.object({
  id: z.string(),
  /** `extra`: more room on top of the limit; `unlimited`: not enforced. */
  kind: z.enum(["extra", "unlimited"]),
  /** Extra room, in nano-AIU and the display unit; 0 for `unlimited`. */
  extra_nano_aiu: NanoAiuAmount,
  extra: z.number().min(0),
  created_at: z.string(),
  /** Null: lasts until it is removed (`DELETE /overrides/:id`). */
  expires_at: z.string().nullable(),
})
export type BudgetOverrideStatus = z.infer<typeof BudgetOverrideStatus>

/** One limit with its spend in the current period. */
export const BudgetLimitStatus = z.object({
  id: BudgetLimitId,
  label: z.string().nullable(),
  scope: BudgetScope,
  action: BudgetLimitAction,
  warn_at: BudgetWarnAt,
  limit: NanoAiuAmount,
  /** The limit plus the room `extra` overrides granted; `limit_remaining`,
   *  `state` and a refusal use this one. */
  effective_limit: NanoAiuAmount,
  limit_reset: BudgetLimitReset,
  limit_remaining: NanoAiuAmount,
  /** Spend in the current period. */
  usage: NanoAiuAmount,
  /** Held by calls in progress (their estimates), not yet spent. */
  held: NanoAiuAmount,
  /** Spend since 00:00 UTC today, and since Monday 00:00 UTC. */
  usage_daily: NanoAiuAmount,
  usage_weekly: NanoAiuAmount,
  period_start: z.string(),
  /** Null for a limit that never resets. */
  resets_at: z.string().nullable(),
  /** `provider`: the followed window's reset; `fixed`: daily, weekly or
   *  never; `fallback`: daily, standing in for a window with no usable
   *  reset. */
  reset_basis: z.enum(["fixed", "provider", "fallback"]),
  /** The period boundaries are Maximal's estimate, not the provider's. */
  reset_estimated: z.boolean(),
  state: BudgetLimitState,
  notify: BudgetNotifyStatus,
  /** What approvals granted that is still in force. An `unlimited` one
   *  reads as `ok` whatever the spend. */
  overrides: z.array(BudgetOverrideStatus),
  /** For an `ask` rule: `pending` while a request for more room waits for
   *  the person, `declined` after they chose to keep it blocked. */
  approval: z.enum(["pending", "declined"]).nullable(),
  display: z.object({
    limit: z.number().min(0),
    effective_limit: z.number().min(0),
    usage: z.number().min(0),
    limit_remaining: z.number().min(0),
  }),
})
export type BudgetLimitStatus = z.infer<typeof BudgetLimitStatus>

/** A quota window a provider reported. Its counters are context only. */
export const ProviderQuotaWindowStatus = z.object({
  provider: z.string(),
  id: z.string(),
  label: z.string(),
  unit: z.string(),
  used: z.number().nullable(),
  limit: z.number().nullable(),
  percent_remaining: z.number().nullable(),
  resets_at: z.string().nullable(),
  previous_resets_at: z.string().nullable(),
  kind: z.enum(["fixed", "rolling"]).nullable(),
  duration_ms: z.number().nullable(),
  scope: z
    .object({
      models: z.array(z.string()).nullable(),
      model_class: z.string().nullable(),
    })
    .nullable(),
  overage: z
    .object({
      used: z.number().nullable(),
      permitted: z.boolean().nullable(),
    })
    .nullable(),
  observed_at: z.string(),
  source: z.enum(["header", "endpoint"]),
})
export type ProviderQuotaWindowStatus = z.infer<
  typeof ProviderQuotaWindowStatus
>

/** A reusable filter and the rules whose scope selects it. */
export const BudgetFilterStatus = z.object({
  id: BudgetFilterId,
  name: z.string(),
  kind: BudgetFilterKind,
  members: z.array(BudgetFilterMember),
  /** The ids of the rules scoped to this filter. */
  used_by: z.array(BudgetLimitId),
})
export type BudgetFilterStatus = z.infer<typeof BudgetFilterStatus>

/** GET /settings/api/budget, and the reply to every limit change. */
export const BudgetStatusResponse = z.object({
  /** False when enforcement is switched off: limits are kept and reported,
   *  none refuses a request. */
  enabled: z.boolean(),
  display: z.object({ unit: BudgetDisplayUnit, credit_usd: CreditUsdRate }),
  /** False when there is no usage database: every spend reads 0. */
  storage_enabled: z.boolean(),
  /** Widest scope first: global, provider, plugin, key. */
  budgets: z.array(BudgetLimitStatus),
  /** The blocking limit a request would hit first, or null. */
  effective_budget: BudgetLimitId.nullable(),
  provider_windows: z.array(ProviderQuotaWindowStatus),
  /** The named filters a rule's `filter` scope can select. */
  filters: z.array(BudgetFilterStatus),
})
export type BudgetStatusResponse = z.infer<typeof BudgetStatusResponse>

/** The Dashboard's measures (`GET /token-usage`'s `totals` and `byModel`
 *  rows, field for field) over some rows. */
export const BudgetUsageTotals = z.object({
  request_count: z.number().int().min(0),
  input_tokens: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
  cache_read_input_tokens: z.number().int().min(0),
  cache_creation_input_tokens: z.number().int().min(0),
  total_tokens: z.number().int().min(0),
  total_nano_aiu: NanoAiuAmount,
})
export type BudgetUsageTotals = z.infer<typeof BudgetUsageTotals>

/** GET /settings/api/budget/activity: usage in a range, grouped, biggest
 *  spender first (by day or hour, oldest first). The range is `from`/`to`
 *  (ISO), `range=24h|7d|30d|90d|all` or the original `period=day|week|month`
 *  (since 00:00 UTC today, on Monday or on the 1st; `period` echoes it, and is
 *  `range` for the other forms). Groups that spent nothing are left out
 *  unless `include_free=true`. The token and `totals` fields are always sent;
 *  they are optional here so older mocks still parse. */
export const BudgetActivityResponse = z.object({
  period: z.enum(["day", "week", "month", "range"]),
  group: z.enum(["model", "plugin", "key", "provider", "day", "hour"]),
  /** Where the range starts (00:00 UTC today, on Monday, or on the 1st, for
   *  `period`). */
  period_start: z.string(),
  display: z.object({ unit: BudgetDisplayUnit, credit_usd: CreditUsdRate }),
  /** The range as resolved at request time; `to` is exclusive. `label` is
   *  `custom` for `from`/`to`. */
  range: z
    .object({
      from: z.string(),
      to: z.string(),
      label: z.enum([
        "24h",
        "7d",
        "30d",
        "90d",
        "all",
        "day",
        "week",
        "month",
        "custom",
      ]),
    })
    .optional(),
  /** Everything the range recorded (free groups included), like the
   *  Dashboard's totals row. */
  totals: BudgetUsageTotals.optional(),
  rows: z.array(
    z.object({
      /** The group's value; null for rows with none (no plugin, say). An
       *  hour is `2026-11-11T14:00:00Z`, a day `2026-11-11`. */
      key: z.string().nullable(),
      nano_aiu: NanoAiuAmount,
      requests: z.number().int().min(0),
      /** `nano_aiu` in the display unit. */
      amount: z.number().min(0),
      input_tokens: z.number().int().min(0).optional(),
      output_tokens: z.number().int().min(0).optional(),
      cache_read_input_tokens: z.number().int().min(0).optional(),
      cache_creation_input_tokens: z.number().int().min(0).optional(),
      total_tokens: z.number().int().min(0).optional(),
    }),
  ),
})
export type BudgetActivityResponse = z.infer<typeof BudgetActivityResponse>

export const BudgetTimelineBucket = z.object({
  start: z.string(),
  /** Exclusive; a bucket is cut where a period resets. */
  end: z.string(),
  nano_aiu: NanoAiuAmount,
  requests: z.number().int().min(0),
  /** The rule's spend in its period, through the end of this bucket. */
  cumulative_nano_aiu: NanoAiuAmount,
  /** Requests the rule refused in the bucket (from `budget_events`). */
  refused: z.number().int().min(0),
  /** Start of the period the bucket belongs to. */
  period_start: z.string(),
  /** `nano_aiu` and `cumulative_nano_aiu` in the display unit. */
  amount: z.number().min(0),
  cumulative_amount: z.number().min(0),
})

export const BudgetTimelinePeriod = z.object({
  start: z.string(),
  /** Null for a rule that never resets. */
  end: z.string().nullable(),
  /** The boundaries are a guess (an earlier cycle of a followed window). */
  estimated: z.boolean(),
  /** Spend in the period so far, within the data read. */
  spend_nano_aiu: NanoAiuAmount,
  /** When spend first reached the warning line / the limit; null if never. */
  warned_at: z.string().nullable(),
  crossed_at: z.string().nullable(),
  refused: z.number().int().min(0),
})

export const BudgetTimelineMarker = z.object({
  kind: z.enum(["warned", "crossed", "refused"]),
  at: z.string(),
  period_start: z.string(),
  /** `refused`: how many requests the bucket the marker stands for lost. */
  count: z.number().int().min(0).optional(),
  /** `refused`: what they would have cost (their estimates). */
  estimate_nano_aiu: NanoAiuAmount.optional(),
})

/** GET /settings/api/budget/limits/:id/timeline?range=|from=&to=&bucket=:
 *  how one rule performed over time. Buckets are UTC hours, days or weeks
 *  (`bucket=hour|day|week`; default by the range's length), cut where the
 *  rule's period resets so `cumulative_nano_aiu` never straddles a reset. The
 *  limit line and warning line are constant (`limit`, `warn_line`). */
export const BudgetTimelineResponse = z.object({
  limit: z.object({
    id: BudgetLimitId,
    label: z.string().nullable(),
    scope: BudgetScope,
    action: BudgetLimitAction,
    limit_reset: BudgetLimitReset,
    warn_at: BudgetWarnAt,
    /** The limit and the warning line (`limit * warn_at`, rounded up). */
    limit: NanoAiuAmount,
    warn_line: NanoAiuAmount,
    display: z.object({
      limit: z.number().min(0),
      warn_line: z.number().min(0),
    }),
  }),
  display: z.object({ unit: BudgetDisplayUnit, credit_usd: CreditUsdRate }),
  range: z.object({
    from: z.string(),
    to: z.string(),
    label: z.enum(["24h", "7d", "30d", "90d", "all", "custom"]),
    bucket: z.enum(["hour", "day", "week"]),
  }),
  buckets: z.array(BudgetTimelineBucket),
  periods: z.array(BudgetTimelinePeriod),
  markers: z.array(BudgetTimelineMarker),
  totals: z.object({
    nano_aiu: NanoAiuAmount,
    requests: z.number().int().min(0),
    refused: z.number().int().min(0),
    /** The estimates of the refused requests that carried one. */
    refused_estimate_nano_aiu: NanoAiuAmount,
    periods_crossed: z.number().int().min(0),
  }),
})
export type BudgetTimelineResponse = z.infer<typeof BudgetTimelineResponse>

/** Body of PATCH /settings/api/budget. */
export const BudgetSettingsPatchRequest = z
  .object({
    enabled: z.boolean().optional(),
    display_unit: BudgetDisplayUnit.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "give enabled or display_unit",
  })
export type BudgetSettingsPatchRequest = z.infer<
  typeof BudgetSettingsPatchRequest
>

/** Body of PUT /settings/api/budget/limits/:id, which creates or replaces
 *  the limit. Give the amount as `limit` (nano-AIU) or as `amount` in the
 *  display unit, not both. */
export const BudgetLimitPutRequest = z
  .object({
    label: z.string().trim().min(1).max(128).optional(),
    scope: BudgetScope,
    limit: NanoAiuAmount.optional(),
    amount: z.number().min(0).optional(),
    limit_reset: BudgetLimitReset,
    warn_at: BudgetWarnAt.optional(),
    action: BudgetLimitAction,
    /** Where this rule's notices go; what is left out takes the default
     *  (warn: `notification`, limit: `both`). */
    notify: z
      .object({
        warn: BudgetNotifyChannel.optional(),
        limit: BudgetNotifyChannel.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (body) => (body.limit === undefined) !== (body.amount === undefined),
    {
      message: "give exactly one of limit (nano-AIU) or amount (display unit)",
      path: ["limit"],
    },
  )
export type BudgetLimitPutRequest = z.infer<typeof BudgetLimitPutRequest>

/** One way a rule's period can reset, for the UI to offer. */
export const BudgetResetPreset = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  limit_reset: BudgetLimitReset,
  /** `<provider>:<window id>` for a "Follow ..." preset, else null. */
  window: z.string().nullable(),
})
export type BudgetResetPreset = z.infer<typeof BudgetResetPreset>

/** A rule a persona preset suggests: the fields of a PUT body, plus the
 *  `id` to give it. A `null` scope `id` means "the person picks one". */
export const BudgetPresetLimit = z.object({
  id: BudgetLimitId,
  label: z.string(),
  scope: z.union([
    z.object({ kind: z.literal("global") }),
    z.object({
      kind: z.enum(["key", "plugin", "provider"]),
      id: z.string().nullable(),
    }),
  ]),
  limit: NanoAiuAmount,
  /** `limit` in the display unit. */
  amount: z.number().min(0),
  limit_reset: BudgetLimitReset,
  warn_at: BudgetWarnAt,
  action: BudgetLimitAction,
})
export type BudgetPresetLimit = z.infer<typeof BudgetPresetLimit>

export const BudgetPersonaPreset = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  limits: z.array(BudgetPresetLimit),
})
export type BudgetPersonaPreset = z.infer<typeof BudgetPersonaPreset>

/** GET /settings/api/budget/presets: suggestions only; none is applied. */
export const BudgetPresetsResponse = z.object({
  display: z.object({ unit: BudgetDisplayUnit, credit_usd: CreditUsdRate }),
  resets: z.array(BudgetResetPreset),
  personas: z.array(BudgetPersonaPreset),
})
export type BudgetPresetsResponse = z.infer<typeof BudgetPresetsResponse>

/** Body of PUT /settings/api/budget/filters/:id, which creates or replaces
 *  the filter. */
export const BudgetFilterPutRequest = z
  .object({
    name: z.string().trim().min(1).max(128),
    kind: BudgetFilterKind,
    members: z.array(BudgetFilterMember).min(1).max(256),
  })
  .strict()
export type BudgetFilterPutRequest = z.infer<typeof BudgetFilterPutRequest>

/** GET /settings/api/budget/filters. */
export const BudgetFiltersResponse = z.object({
  filters: z.array(BudgetFilterStatus),
})
export type BudgetFiltersResponse = z.infer<typeof BudgetFiltersResponse>

// ── Rules export and import (/settings/api/budget/rules/*) ──────────────

/** One rule as the rules document carries it: the PUT body's field names,
 *  the amount in nano-AIU, every field explicit. */
export const BudgetRuleLimit = z
  .object({
    id: BudgetLimitId,
    label: z.string().trim().min(1).max(128).optional(),
    scope: BudgetScope,
    limit: NanoAiuAmount,
    limit_reset: BudgetLimitReset,
    warn_at: BudgetWarnAt,
    action: BudgetLimitAction,
    /** Always written on export; an import without it takes the defaults. */
    notify: BudgetNotifyStatus.strict().optional(),
  })
  .strict()
export type BudgetRuleLimit = z.infer<typeof BudgetRuleLimit>

export const BudgetRuleFilter = z
  .object({
    id: BudgetFilterId,
    name: z.string().trim().min(1).max(128),
    kind: BudgetFilterKind,
    members: z.array(BudgetFilterMember).min(1).max(256),
  })
  .strict()
export type BudgetRuleFilter = z.infer<typeof BudgetRuleFilter>

export const BudgetRulesDisplay = z
  .object({ unit: BudgetDisplayUnit, credit_usd: CreditUsdRate })
  .strict()
export type BudgetRulesDisplay = z.infer<typeof BudgetRulesDisplay>

/** The rules document: what `GET /settings/api/budget/rules/export` returns
 *  and `POST .../rules/import` takes. `display` is optional on import. */
export const BudgetRulesDocument = z
  .object({
    version: z.literal(1),
    filters: z.array(BudgetRuleFilter).max(128),
    limits: z.array(BudgetRuleLimit).max(256),
    display: BudgetRulesDisplay.optional(),
  })
  .strict()
export type BudgetRulesDocument = z.infer<typeof BudgetRulesDocument>

/** Body of POST /settings/api/budget/rules/import. `rules` is validated
 *  against `BudgetRulesDocument` by the route (so a bad version or an
 *  unknown scope gets its own message). */
export const BudgetRulesImportRequest = z
  .object({
    rules: z.unknown(),
    /** `merge` adds to what is there; `replace` makes it what the document
     *  says, removing the rest. */
    mode: z.enum(["merge", "replace"]),
    /** True: report what would change and change nothing. */
    dryRun: z.boolean(),
    /** For `merge`: an imported id that is already used by something
     *  different either replaces it (default) or is added under a free id
     *  (`<id>-2`). */
    collisions: z.enum(["replace", "rename"]).optional(),
  })
  .strict()
export type BudgetRulesImportRequest = z.infer<typeof BudgetRulesImportRequest>

/** What an import adds, changes and removes, for one list. */
export interface BudgetRulesChangeSet<T> {
  added: Array<T>
  changed: Array<{ before: T; after: T }>
  /** Only a `replace` import removes. */
  removed: Array<T>
  /** The ids that were already exactly so. */
  unchanged: Array<string>
}

const changeSet = <T extends z.ZodType>(item: T) =>
  z.object({
    added: z.array(item),
    changed: z.array(z.object({ before: item, after: item })),
    removed: z.array(item),
    unchanged: z.array(z.string()),
  })

/** The reply to POST /settings/api/budget/rules/import. */
export const BudgetRulesImportResponse = z.object({
  mode: z.enum(["merge", "replace"]),
  dry_run: z.boolean(),
  /** True once the import was written (never with `dry_run`). */
  applied: z.boolean(),
  filters: changeSet(BudgetRuleFilter),
  limits: changeSet(BudgetRuleLimit),
  /** `replace` takes the document's display unit and credit rate. */
  display: z.object({
    changed: z.boolean(),
    before: BudgetRulesDisplay,
    after: BudgetRulesDisplay,
  }),
  /** Ids a `rename` merge gave imported items. */
  renamed: z.array(
    z.object({
      kind: z.enum(["filter", "limit"]),
      from: z.string(),
      to: z.string(),
    }),
  ),
})
export type BudgetRulesImportResponse = z.infer<
  typeof BudgetRulesImportResponse
>

/** Body of POST /settings/api/budget/limits/:id/approve: decide what to do
 *  about a rule that has reached its limit. `more` allows extra room for the
 *  rest of the period (`extra` in nano-AIU or `amount` in the display unit;
 *  by default a quarter of the limit), `hour` stops enforcing it for an hour,
 *  `keep` leaves it blocked and stops asking until the period turns over. */
export const BudgetApproveRequest = z
  .object({
    choice: z.enum(["more", "hour", "keep"]),
    extra: NanoAiuAmount.optional(),
    amount: z.number().positive().optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.choice === "more"
      || (body.extra === undefined && body.amount === undefined),
    { message: "extra and amount only go with choice more", path: ["choice"] },
  )
  .refine((body) => body.extra === undefined || body.amount === undefined, {
    message: "give extra (nano-AIU) or amount (display unit), not both",
    path: ["extra"],
  })
export type BudgetApproveRequest = z.infer<typeof BudgetApproveRequest>
