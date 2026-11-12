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
 * - `GET /filters` — the named filters (`BudgetFiltersResponse`);
 *   `PUT /filters/:id` creates or replaces one (`BudgetFilterPutRequest`),
 *   `DELETE /filters/:id` removes it, a 409 `filter_in_use` while a rule's
 *   scope selects it.
 * - `GET /rules/export` — the rules document (`BudgetRulesDocument`, version
 *   1); `POST /rules/import` — `{ rules, mode, dryRun }`
 *   (`BudgetRulesImportRequest`) answers what would change or changed
 *   (`BudgetRulesImportResponse`); a document that doesn't validate is a 400
 *   listing every problem.
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
 * - `POST /simulate` — replay recorded usage through draft rules
 *   (`BudgetSimulateRequest` / `BudgetSimulateResponse`); applies nothing.
 * - `GET /sessions?range=…&limit=` — what each session cost
 *   (`BudgetSessionsResponse`).
 * - `POST /suggest` — draft rules sized from sessions or a range
 *   (`BudgetSuggestRequest` / `BudgetSuggestResponse`); applies nothing.
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
import { buildBudgetPresets } from "~/lib/budget/presets"
import {
  findProviderWindow,
  listProviderWindows,
} from "~/lib/budget/provider-windows"
import {
  resolveReportRange,
  runSessions,
  runSimulation,
  runSuggest,
  type ReportContext,
} from "~/lib/budget/reports/api"
import {
  bucketCount,
  defaultBucket,
  isBucketSize,
  type BucketSize,
} from "~/lib/budget/reports/buckets"
import { parseUsageRange } from "~/lib/budget/reports/range"
import { buildLimitTimeline } from "~/lib/budget/reports/timeline"
import { exportRules, planImport } from "~/lib/budget/rules"
import { emitBudgetChanged, getOverrideRegistry } from "~/lib/budget/runtime"
import {
  BudgetFilterId,
  BudgetLimitId,
  DEFAULT_WARN_AT,
  NanoAiuAmount,
  type BudgetFilterConfig,
  type BudgetLimitConfig,
  type BudgetScope,
} from "~/lib/budget/schema"
import { filterStatuses } from "~/lib/budget/status"
import { displayToNanoAiu, resolveBudgetDisplay } from "~/lib/budget/units"
import { getConfig, writeConfig } from "~/lib/config/config"
import {
  BudgetActivityResponse,
  BudgetFilterPutRequest,
  BudgetFiltersResponse,
  BudgetLimitPutRequest,
  BudgetPresetsResponse,
  BudgetRulesDocument,
  BudgetRulesImportRequest,
  BudgetRulesImportResponse,
  BudgetSessionsResponse,
  BudgetSettingsPatchRequest,
  BudgetSimulateRequest,
  BudgetSimulateResponse,
  BudgetSuggestRequest,
  BudgetSuggestResponse,
  BudgetTimelineResponse,
} from "~/lib/config/settings-types"
import { forwardError } from "~/lib/errors/error"

import { budgetActionRoutes } from "./budget-actions"
import { respondChanged, respondStatus, validationError } from "./budget-http"
import { respondValidated } from "./respond-validated"

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

/** The id of the filter a scope names when there is no such filter. */
function missingFilter(
  config: AppConfig,
  scope: BudgetScope,
): string | undefined {
  if (scope.kind !== "filter") return undefined
  const known = (config.budget?.filters ?? []).some(
    (filter) => filter.id === scope.id,
  )
  return known ? undefined : scope.id
}

export const budgetRoutes = new Hono()

budgetRoutes.route("/", budgetActionRoutes)

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

    const missing = missingFilter(config, request.scope)
    if (missing !== undefined) {
      return validationError(c, `Unknown filter '${missing}'; create it first`)
    }

    const entry: BudgetLimitConfig = {
      id: id.data,
      ...(request.label === undefined ? {} : { label: request.label }),
      scope: request.scope,
      limit: nanoAiu.data,
      limitReset: request.limit_reset,
      warnAt: request.warn_at ?? DEFAULT_WARN_AT,
      action: request.action,
      ...(request.notify === undefined ? {} : { notify: request.notify }),
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
    // What approvals granted a rule goes with it.
    getOverrideRegistry().removeForLimit(c.req.param("id"))
    return await respondChanged(c)
  } catch (error) {
    return forwardError(c, error)
  }
})

budgetRoutes.get("/filters", (c) => {
  try {
    return respondValidated(
      c,
      { schema: BudgetFiltersResponse, label: "Budget filters" },
      { filters: filterStatuses(getConfig().budget) },
    )
  } catch (error) {
    return forwardError(c, error)
  }
})

budgetRoutes.put("/filters/:id", async (c) => {
  try {
    const id = BudgetFilterId.safeParse(c.req.param("id"))
    if (!id.success) {
      return validationError(
        c,
        "Filter id must be lowercase letters and digits, separated by '.', '_' or '-'",
      )
    }
    const body = BudgetFilterPutRequest.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) {
      return validationError(c, "Invalid budget filter", body.error.issues)
    }
    const config = getConfig()
    const entry: BudgetFilterConfig = {
      id: id.data,
      name: body.data.name,
      kind: body.data.kind,
      members: [...new Set(body.data.members)],
    }
    const filters = [...(config.budget?.filters ?? [])]
    const index = filters.findIndex((filter) => filter.id === id.data)
    if (index === -1) filters.push(entry)
    else filters[index] = entry
    writeConfig({ ...config, budget: { ...config.budget, filters } })
    return await respondChanged(c)
  } catch (error) {
    return forwardError(c, error)
  }
})

budgetRoutes.delete("/filters/:id", async (c) => {
  try {
    const config = getConfig()
    const filters = config.budget?.filters ?? []
    const id = c.req.param("id")
    if (!filters.some((filter) => filter.id === id)) {
      return c.json(
        { error: { message: "Budget filter not found", type: "not_found" } },
        404,
      )
    }
    const usedBy = (config.budget?.limits ?? [])
      .filter((limit) => limit.scope.kind === "filter" && limit.scope.id === id)
      .map((limit) => limit.id)
    if (usedBy.length > 0) {
      return c.json(
        {
          error: {
            message: `Filter '${id}' is used by ${usedBy.length === 1 ? "rule" : "rules"} ${usedBy.join(", ")}. Change or delete ${usedBy.length === 1 ? "it" : "them"} first.`,
            type: "filter_in_use",
            details: { used_by: usedBy },
          },
        },
        409,
      )
    }
    writeConfig({
      ...config,
      budget: {
        ...config.budget,
        filters: filters.filter((filter) => filter.id !== id),
      },
    })
    return await respondChanged(c)
  } catch (error) {
    return forwardError(c, error)
  }
})

budgetRoutes.get("/rules/export", (c) => {
  try {
    return respondValidated(
      c,
      { schema: BudgetRulesDocument, label: "Budget rules" },
      exportRules(getConfig().budget),
    )
  } catch (error) {
    return forwardError(c, error)
  }
})

budgetRoutes.post("/rules/import", async (c) => {
  try {
    const request = BudgetRulesImportRequest.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!request.success) {
      return validationError(
        c,
        "Give rules, mode (merge or replace) and dryRun (true or false)",
        request.error.issues,
      )
    }
    const { rules, mode, dryRun, collisions } = request.data
    const config = getConfig()
    const plan = planImport(config.budget, {
      rules,
      mode,
      ...(collisions === undefined ? {} : { collisions }),
    })
    if (!plan.ok) {
      return validationError(
        c,
        `The rules can't be imported: ${plan.problems.length === 1 ? "1 problem" : `${plan.problems.length} problems`}`,
        plan.problems,
      )
    }
    if (!dryRun) {
      writeConfig({
        ...config,
        budget: {
          ...config.budget,
          limits: plan.next.limits,
          filters: plan.next.filters,
          ...(plan.next.display === undefined ?
            {}
          : { display: { ...config.budget?.display, ...plan.next.display } }),
        },
      })
    }
    const response = respondValidated(
      c,
      { schema: BudgetRulesImportResponse, label: "Budget rules import" },
      { mode, dry_run: dryRun, applied: !dryRun, ...plan.diff },
    )
    if (!dryRun) emitBudgetChanged()
    return response
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
    const parsed = await resolveReportRange(
      {
        range: c.req.query("range"),
        from: c.req.query("from"),
        to: c.req.query("to"),
      },
      nowMs,
      "7d",
    )
    if (!parsed.ok) return validationError(c, parsed.message)
    const { range } = parsed

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

async function reportContext(): Promise<ReportContext> {
  await listProviderWindows()
  return {
    nowMs: Date.now(),
    config: getConfig().budget,
    findWindow: (ref) => findProviderWindow(ref),
  }
}

budgetRoutes.post("/simulate", async (c) => {
  try {
    const body = BudgetSimulateRequest.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) {
      return validationError(c, "Invalid simulation", body.error.issues)
    }
    const result = await runSimulation(body.data, await reportContext())
    if (!result.ok) return validationError(c, result.message)
    return respondValidated(
      c,
      { schema: BudgetSimulateResponse, label: "Budget simulation" },
      result.value,
    )
  } catch (error) {
    return forwardError(c, error)
  }
})

const DEFAULT_SESSIONS = 100
const MAX_SESSIONS = 500

/** The `limit` query: absent is the default; anything but a whole number
 *  from 1 to 500 is undefined. */
function sessionLimit(value: string | undefined): number | undefined {
  if (value === undefined) return DEFAULT_SESSIONS
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_SESSIONS ?
      parsed
    : undefined
}

budgetRoutes.get("/sessions", async (c) => {
  try {
    const requested = c.req.query("limit")
    const limit = sessionLimit(requested)
    if (limit === undefined) {
      return validationError(c, `limit must be 1 to ${MAX_SESSIONS}`)
    }
    const result = await runSessions(
      {
        range: c.req.query("range"),
        from: c.req.query("from"),
        to: c.req.query("to"),
        limit,
      },
      await reportContext(),
    )
    if (!result.ok) return validationError(c, result.message)
    return respondValidated(
      c,
      { schema: BudgetSessionsResponse, label: "Budget sessions" },
      result.value,
    )
  } catch (error) {
    return forwardError(c, error)
  }
})

budgetRoutes.post("/suggest", async (c) => {
  try {
    const body = BudgetSuggestRequest.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) {
      return validationError(c, "Invalid suggestion request", body.error.issues)
    }
    const result = await runSuggest(body.data, await reportContext())
    if (!result.ok) return validationError(c, result.message)
    return respondValidated(
      c,
      { schema: BudgetSuggestResponse, label: "Budget suggestions" },
      result.value,
    )
  } catch (error) {
    return forwardError(c, error)
  }
})
