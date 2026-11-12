/**
 * /settings/api/budget — spend limits and their status.
 *
 * - `GET /` — the status snapshot (`BudgetStatusResponse`): every limit with
 *   its spend this period and when it resets, plus the provider quota windows
 *   observed so far.
 * - `PUT /limits/:id` — create or replace a limit (`BudgetLimitPutRequest`).
 *   The amount comes as nano-AIU (`limit`) or in the display unit (`amount`),
 *   converted once here and stored as nano-AIU in `config.json`.
 * - `DELETE /limits/:id` — remove a limit.
 * - `PATCH /` — `enabled` (enforcement on or off) and `display_unit`
 *   (`BudgetSettingsPatchRequest`).
 * - `GET /presets` — reset presets and persona presets
 *   (`BudgetPresetsResponse`): suggestions the UI turns into draft rules,
 *   never applied here.
 * - `GET /activity?group=model|plugin|key|provider|day|hour` over a range:
 *   `range=24h|7d|30d|90d|all`, `from`/`to` (ISO) or `period=day|week|month`
 *   — usage per group (`BudgetActivityResponse`), the Dashboard's measures;
 *   `include_free=true` keeps groups that spent nothing. `GET /activity.csv`
 *   is the same rows as CSV.
 * - `GET /limits/:id/timeline?range=…&bucket=hour|day|week` — how one rule
 *   performed over time (`BudgetTimelineResponse`).
 *
 * Every change replies with the new snapshot and pushes it as
 * `budget.changed`. Auth-gated by the parent `/settings/api` middleware.
 * Enforcement itself lives in the routes that spend (`~/lib/budget/service`).
 */

import type { Context } from "hono"

import { Hono } from "hono"

import type { AppConfig } from "~/lib/config/config"

import {
  activityCsv,
  buildBudgetActivity,
  type ActivityGroup,
} from "~/lib/budget/activity"
import { DAY_MS } from "~/lib/budget/periods"
import { buildBudgetPresets } from "~/lib/budget/presets"
import {
  findProviderWindow,
  listProviderWindows,
} from "~/lib/budget/provider-windows"
import {
  bucketCount,
  defaultBucket,
  isBucketSize,
  type BucketSize,
} from "~/lib/budget/reports/buckets"
import { parseUsageRange } from "~/lib/budget/reports/range"
import { buildLimitTimeline } from "~/lib/budget/reports/timeline"
import { getFirstUsageMs } from "~/lib/budget/reports/usage"
import { currentBudgetStatus, emitBudgetChanged } from "~/lib/budget/runtime"
import {
  BudgetLimitId,
  DEFAULT_WARN_AT,
  NanoAiuAmount,
  type BudgetLimitConfig,
} from "~/lib/budget/schema"
import { displayToNanoAiu, resolveBudgetDisplay } from "~/lib/budget/units"
import { getConfig, writeConfig } from "~/lib/config/config"
import {
  BudgetActivityResponse,
  BudgetLimitPutRequest,
  BudgetPresetsResponse,
  BudgetSettingsPatchRequest,
  BudgetStatusResponse,
  BudgetTimelineResponse,
} from "~/lib/config/settings-types"
import { forwardError } from "~/lib/errors/error"

import { respondValidated } from "./respond-validated"

async function respondStatus(c: Context): Promise<Response> {
  return respondValidated(
    c,
    { schema: BudgetStatusResponse, label: "Budget" },
    await currentBudgetStatus(),
  )
}

/** The reply to a change, which also tells the shell. */
async function respondChanged(c: Context): Promise<Response> {
  const response = await respondStatus(c)
  emitBudgetChanged()
  return response
}

function validationError(
  c: Context,
  message: string,
  details?: unknown,
): Response {
  return c.json(
    {
      error: {
        message,
        type: "validation_error",
        ...(details === undefined ? {} : { details }),
      },
    },
    400,
  )
}

function notFound(c: Context): Response {
  return c.json(
    { error: { message: "Budget limit not found", type: "not_found" } },
    404,
  )
}

function withLimits(
  config: AppConfig,
  limits: Array<BudgetLimitConfig>,
): AppConfig {
  return { ...config, budget: { ...config.budget, limits } }
}

export const budgetRoutes = new Hono()

budgetRoutes.get("/", async (c) => {
  try {
    return await respondStatus(c)
  } catch (error) {
    return forwardError(c, error)
  }
})

budgetRoutes.put("/limits/:id", async (c) => {
  try {
    const id = BudgetLimitId.safeParse(c.req.param("id"))
    if (!id.success) {
      return validationError(
        c,
        "Limit id must be lowercase letters and digits, separated by '.', '_' or '-'",
      )
    }
    const body = BudgetLimitPutRequest.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) {
      return validationError(c, "Invalid budget limit", body.error.issues)
    }

    const config = getConfig()
    const request = body.data
    const nanoAiu = NanoAiuAmount.safeParse(
      request.limit
        ?? displayToNanoAiu(
          request.amount ?? 0,
          resolveBudgetDisplay(config.budget),
        ),
    )
    if (!nanoAiu.success) {
      return validationError(c, "Limit amount is out of range")
    }

    const entry: BudgetLimitConfig = {
      id: id.data,
      ...(request.label === undefined ? {} : { label: request.label }),
      scope: request.scope,
      limit: nanoAiu.data,
      limitReset: request.limit_reset,
      warnAt: request.warn_at ?? DEFAULT_WARN_AT,
      action: request.action,
    }
    const limits = [...(config.budget?.limits ?? [])]
    const index = limits.findIndex((limit) => limit.id === id.data)
    if (index === -1) limits.push(entry)
    else limits[index] = entry
    writeConfig(withLimits(config, limits))
    return await respondChanged(c)
  } catch (error) {
    return forwardError(c, error)
  }
})

budgetRoutes.delete("/limits/:id", async (c) => {
  try {
    const config = getConfig()
    const limits = config.budget?.limits ?? []
    const next = limits.filter((limit) => limit.id !== c.req.param("id"))
    if (next.length === limits.length) return notFound(c)
    writeConfig(withLimits(config, next))
    return await respondChanged(c)
  } catch (error) {
    return forwardError(c, error)
  }
})

budgetRoutes.patch("/", async (c) => {
  try {
    const body = BudgetSettingsPatchRequest.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) {
      return validationError(c, "Invalid budget settings", body.error.issues)
    }
    const config = getConfig()
    const { enabled, display_unit: unit } = body.data
    writeConfig({
      ...config,
      budget: {
        ...config.budget,
        ...(enabled === undefined ? {} : { enabled }),
        ...(unit === undefined ?
          {}
        : { display: { ...config.budget?.display, unit } }),
      },
    })
    return await respondChanged(c)
  } catch (error) {
    return forwardError(c, error)
  }
})

budgetRoutes.get("/presets", async (c) => {
  try {
    const config = getConfig()
    const keyLabels = (config.auth?.apiKeyEntries ?? [])
      .filter((entry) => entry.enabled)
      .map((entry) => entry.label)
    return respondValidated(
      c,
      { schema: BudgetPresetsResponse, label: "Budget presets" },
      buildBudgetPresets({
        display: resolveBudgetDisplay(config.budget),
        windows: await listProviderWindows(),
        keyLabels,
      }),
    )
  } catch (error) {
    return forwardError(c, error)
  }
})

const ACTIVITY_GROUPS: ReadonlySet<string> = new Set([
  "model",
  "plugin",
  "key",
  "provider",
  "day",
  "hour",
])

const ACTIVITY_QUERY_MESSAGE =
  "group must be model, plugin, key, provider, day or hour"

type ActivityQuery =
  | { ok: true; activity: BudgetActivityResponse }
  | { ok: false; message: string }

async function activityFor(c: Context): Promise<ActivityQuery> {
  const group = c.req.query("group") ?? "model"
  if (!ACTIVITY_GROUPS.has(group)) {
    return { ok: false, message: ACTIVITY_QUERY_MESSAGE }
  }
  const parsed = parseUsageRange(
    {
      range: c.req.query("range"),
      from: c.req.query("from"),
      to: c.req.query("to"),
      period: c.req.query("period"),
    },
    Date.now(),
    "day",
  )
  if (!parsed.ok) return parsed
  const activity = await buildBudgetActivity(getConfig().budget, {
    range: parsed.range,
    group: group as ActivityGroup,
    includeFree: c.req.query("include_free") === "true",
  })
  return { ok: true, activity }
}

budgetRoutes.get("/activity", async (c) => {
  try {
    const result = await activityFor(c)
    if (!result.ok) return validationError(c, result.message)
    return respondValidated(
      c,
      { schema: BudgetActivityResponse, label: "Budget activity" },
      result.activity,
    )
  } catch (error) {
    return forwardError(c, error)
  }
})

budgetRoutes.get("/activity.csv", async (c) => {
  try {
    const result = await activityFor(c)
    if (!result.ok) return validationError(c, result.message)
    const { activity } = result
    const span = activity.range?.label ?? activity.period
    return c.body(activityCsv(activity), 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="maximal-budget-${activity.group}-${span}.csv"`,
    })
  } catch (error) {
    return forwardError(c, error)
  }
})

/** More buckets than this is a chart nobody can read: pick a coarser one. */
const MAX_TIMELINE_BUCKETS = 2000

budgetRoutes.get("/limits/:id/timeline", async (c) => {
  try {
    const config = getConfig()
    const limit = config.budget?.limits?.find(
      (candidate) => candidate.id === c.req.param("id"),
    )
    if (!limit) return notFound(c)

    const nowMs = Date.now()
    const parsed = parseUsageRange(
      {
        range: c.req.query("range"),
        from: c.req.query("from"),
        to: c.req.query("to"),
      },
      nowMs,
      "7d",
    )
    if (!parsed.ok) return validationError(c, parsed.message)
    let { range } = parsed
    if (range.label === "all") {
      // Everything recorded: from the first row, not the epoch.
      const firstMs = await getFirstUsageMs()
      range = {
        ...range,
        fromMs: Math.min(firstMs ?? nowMs - DAY_MS, nowMs - 1),
      }
    }

    const requested = c.req.query("bucket")
    if (requested !== undefined && !isBucketSize(requested)) {
      return validationError(c, "bucket must be hour, day or week")
    }
    const bucket: BucketSize =
      isBucketSize(requested) ? requested : (
        defaultBucket(range.toMs - range.fromMs)
      )
    if (bucketCount(bucket, range.fromMs, range.toMs) > MAX_TIMELINE_BUCKETS) {
      return validationError(
        c,
        `that range has more than ${MAX_TIMELINE_BUCKETS} ${bucket} buckets; use a larger bucket or a shorter range`,
      )
    }

    await listProviderWindows()
    const timeline = await buildLimitTimeline({
      limit,
      config: config.budget,
      range,
      bucket,
      nowMs,
      findWindow: (ref) => findProviderWindow(ref),
    })
    return respondValidated(
      c,
      { schema: BudgetTimelineResponse, label: "Budget timeline" },
      timeline,
    )
  } catch (error) {
    return forwardError(c, error)
  }
})
