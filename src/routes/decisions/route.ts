/**
 * `/v1/decisions` (the OpenAI Decisions API): relayed to Copilot's
 * `/v1/decisions` and answered with its JSON unchanged.
 *
 * `createDecisionsRoutes(deps)` lets tests inject the upstream call without a
 * process-wide `mock.module` (docs/architecture.md § Testing gotchas).
 */

import { Hono } from "hono"

import { requireGithubAuth } from "~/lib/auth/request-auth"
import { proxyErrorHandler } from "~/lib/errors/proxy-errors"
import {
  createCopilotTokenUsageRecorder,
  normalizeResponsesUsage,
} from "~/lib/token-usage"
import { admitUpstreamRequest, requestedModel } from "~/routes/passthrough"
import {
  createDecisions as defaultCreateDecisions,
  type DecisionsPayload,
} from "~/services/copilot/create-decisions"

export interface DecisionsRoutesDeps {
  createDecisions: typeof defaultCreateDecisions
}

export function createDecisionsRoutes(
  deps: Partial<DecisionsRoutesDeps> = {},
): Hono {
  const createDecisions = deps.createDecisions ?? defaultCreateDecisions

  // Errors propagate to the error handler, which answers in OpenAI's format;
  // the token gate's "not signed in" goes the same way.
  const routes = new Hono()
  routes.onError(proxyErrorHandler("openai"))
  routes.use(requireGithubAuth)

  routes.post("/", async (c) => {
    const payload = await c.req.json<DecisionsPayload>()
    await admitUpstreamRequest()
    const result = await createDecisions(payload, { signal: c.req.raw.signal })
    createCopilotTokenUsageRecorder({
      endpoint: "decisions",
      model: requestedModel(payload.model),
    })(normalizeResponsesUsage(result.usage))
    return c.json(result)
  })

  return routes
}

export const decisionsRoutes = createDecisionsRoutes()
