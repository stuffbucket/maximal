/**
 * /settings/api/budget actions: what the person does about a rule at its
 * limit, and asking a provider for its allowance.
 *
 * - `POST /limits/:id/approve` — `{ choice: "more" | "hour" | "keep" }`
 *   (`BudgetApproveRequest`); replies with the new status. `more` records
 *   extra room for the rest of the period, `hour` stops enforcing the rule
 *   for an hour, `keep` leaves it blocked and stops asking until the period
 *   turns over (409 `nothing_asked` when the rule hasn't asked).
 * - `DELETE /overrides/:id` — end an approval early.
 * - `POST /providers/:provider/refresh` — read the provider's allowance now
 *   and reply with the new status; at most one per provider in 30 s (429
 *   `rate_limited`, `Retry-After`); 404 for an unknown provider, 400
 *   `unsupported` for one with no allowance to read, 502 `refresh_failed`
 *   when the provider can't be reached.
 * - `POST /attention/:actionId` — an attention action the tray lists (the
 *   same one `POST /settings/api/plugins/budget/actions/:actionId` runs).
 */

import { Hono } from "hono"

import { runCoreAttentionAction } from "~/lib/attention"
import { ATTENTION_SOURCE_ID } from "~/lib/budget/approvals"
import {
  getApprovalCenter,
  getOverrideRegistry,
  refreshProviderAllowance,
} from "~/lib/budget/runtime"
import { BudgetLimitId, NanoAiuAmount } from "~/lib/budget/schema"
import { displayToNanoAiu, resolveBudgetDisplay } from "~/lib/budget/units"
import { getConfig } from "~/lib/config/config"
import {
  BudgetApproveRequest,
  PluginActionResponse,
} from "~/lib/config/settings-types"
import { forwardError } from "~/lib/errors/error"

import {
  errorBody,
  respondChanged,
  respondStatus,
  validationError,
} from "./budget-http"
import { respondValidated } from "./respond-validated"

export const budgetActionRoutes = new Hono()

budgetActionRoutes.post("/limits/:id/approve", async (c) => {
  try {
    const id = BudgetLimitId.safeParse(c.req.param("id"))
    if (!id.success) return validationError(c, "Not a rule id")
    const body = BudgetApproveRequest.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) {
      return validationError(
        c,
        "Give choice (more, hour or keep)",
        body.error.issues,
      )
    }
    const { choice, extra, amount } = body.data
    let extraNano: number | undefined
    const given =
      extra
      ?? (amount === undefined ? undefined : (
        displayToNanoAiu(amount, resolveBudgetDisplay(getConfig().budget))
      ))
    if (given !== undefined) {
      const parsed = NanoAiuAmount.safeParse(given)
      if (!parsed.success || parsed.data === 0) {
        return validationError(c, "The extra amount is out of range")
      }
      extraNano = parsed.data
    }
    const result = getApprovalCenter().approve(id.data, choice, extraNano)
    if (!result.ok) {
      if (result.reason === "unknown-limit") {
        return errorBody(c, 404, {
          type: "not_found",
          message: "Budget limit not found",
        })
      }
      return errorBody(c, 409, {
        type: "nothing_asked",
        message: `Rule '${id.data}' has no request waiting to keep blocked`,
      })
    }
    return await respondChanged(c)
  } catch (error) {
    return forwardError(c, error)
  }
})

budgetActionRoutes.delete("/overrides/:id", async (c) => {
  try {
    if (!getOverrideRegistry().remove(c.req.param("id"))) {
      return errorBody(c, 404, {
        type: "not_found",
        message: "Budget override not found",
      })
    }
    return await respondChanged(c)
  } catch (error) {
    return forwardError(c, error)
  }
})

budgetActionRoutes.post("/providers/:provider/refresh", async (c) => {
  try {
    const provider = c.req.param("provider")
    const result = await refreshProviderAllowance(provider)
    if (result.ok) return await respondStatus(c)
    if (result.reason === "unknown-provider") {
      return errorBody(c, 404, {
        type: "not_found",
        message: `Unknown provider '${provider}'`,
      })
    }
    if (result.reason === "unsupported") {
      return errorBody(c, 400, {
        type: "unsupported",
        message: `Provider '${provider}' doesn't report an allowance to refresh`,
      })
    }
    if (result.reason === "rate-limited") {
      c.header("Retry-After", String(result.retryAfterSeconds))
      return errorBody(c, 429, {
        type: "rate_limited",
        message: `The ${provider} allowance was read moments ago; try again in ${result.retryAfterSeconds} s`,
        retry_after_seconds: result.retryAfterSeconds,
      })
    }
    return errorBody(c, 502, {
      type: "refresh_failed",
      message: `Couldn't read the ${provider} allowance: ${result.message}`,
    })
  } catch (error) {
    return forwardError(c, error)
  }
})

budgetActionRoutes.post("/attention/:actionId", (c) => {
  try {
    const ran = runCoreAttentionAction(
      ATTENTION_SOURCE_ID,
      c.req.param("actionId"),
    )
    if (!ran) {
      return errorBody(c, 404, {
        type: "not_found",
        message: "Nothing is waiting on that action",
      })
    }
    c.status(202)
    return respondValidated(
      c,
      { schema: PluginActionResponse, label: "budget attention action" },
      { ok: true },
    )
  } catch (error) {
    return forwardError(c, error)
  }
})
