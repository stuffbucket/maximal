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
 *
 * Both changes reply with the new snapshot. Auth-gated by the parent
 * `/settings/api` middleware. Nothing here admits or refuses inference
 * requests.
 */

import type { Context } from "hono"

import { Hono } from "hono"

import type { AppConfig } from "~/lib/config/config"

import {
  BudgetLimitId,
  DEFAULT_WARN_AT,
  NanoAiuAmount,
  type BudgetLimitConfig,
} from "~/lib/budget/schema"
import { buildBudgetStatus } from "~/lib/budget/status"
import { displayToNanoAiu, resolveBudgetDisplay } from "~/lib/budget/units"
import { getConfig, writeConfig } from "~/lib/config/config"
import {
  BudgetLimitPutRequest,
  BudgetStatusResponse,
} from "~/lib/config/settings-types"
import { forwardError } from "~/lib/errors/error"

import { respondValidated } from "./respond-validated"

async function respondStatus(c: Context): Promise<Response> {
  return respondValidated(
    c,
    { schema: BudgetStatusResponse, label: "Budget" },
    await buildBudgetStatus(getConfig().budget),
  )
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
    return await respondStatus(c)
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
    return await respondStatus(c)
  } catch (error) {
    return forwardError(c, error)
  }
})
