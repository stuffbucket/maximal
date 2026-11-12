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
 * - `GET /activity?period=day|week|month&group=model|plugin|key|provider|day`
 *   — spend per group (`BudgetActivityResponse`); `GET /activity.csv` is the
 *   same rows as CSV.
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
  type ActivityPeriod,
} from "~/lib/budget/activity"
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
  BudgetSettingsPatchRequest,
  BudgetStatusResponse,
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

const ACTIVITY_PERIODS: ReadonlySet<string> = new Set(["day", "week", "month"])
const ACTIVITY_GROUPS: ReadonlySet<string> = new Set([
  "model",
  "plugin",
  "key",
  "provider",
  "day",
])

async function activityFor(c: Context) {
  const period = c.req.query("period") ?? "day"
  const group = c.req.query("group") ?? "model"
  if (!ACTIVITY_PERIODS.has(period) || !ACTIVITY_GROUPS.has(group)) {
    return undefined
  }
  return await buildBudgetActivity(getConfig().budget, {
    period: period as ActivityPeriod,
    group: group as ActivityGroup,
  })
}

const ACTIVITY_QUERY_MESSAGE =
  "period must be day, week or month; group must be model, plugin, key, provider or day"

budgetRoutes.get("/activity", async (c) => {
  try {
    const activity = await activityFor(c)
    if (!activity) return validationError(c, ACTIVITY_QUERY_MESSAGE)
    return respondValidated(
      c,
      { schema: BudgetActivityResponse, label: "Budget activity" },
      activity,
    )
  } catch (error) {
    return forwardError(c, error)
  }
})

budgetRoutes.get("/activity.csv", async (c) => {
  try {
    const activity = await activityFor(c)
    if (!activity) return validationError(c, ACTIVITY_QUERY_MESSAGE)
    return c.body(activityCsv(activity), 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="maximal-budget-${activity.group}-${activity.period}.csv"`,
    })
  } catch (error) {
    return forwardError(c, error)
  }
})
