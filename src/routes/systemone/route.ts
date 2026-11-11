/**
 * `/v1/systemone`: relayed to Copilot's `/v1/systemone` and answered with its
 * JSON unchanged.
 *
 * `createSystemOneRoutes(deps)` lets tests inject the upstream call without a
 * process-wide `mock.module` (docs/architecture.md § Testing gotchas).
 */

import { Hono } from "hono"

import { requireGithubAuth } from "~/lib/auth/request-auth"
import { proxyErrorHandler } from "~/lib/errors/proxy-errors"
import { createCopilotTokenUsageRecorder } from "~/lib/token-usage"
import { admitUpstreamRequest, requestedModel } from "~/routes/passthrough"
import {
  createSystemOne as defaultCreateSystemOne,
  type DecisionsPayload,
} from "~/services/copilot/create-decisions"

export interface SystemOneRoutesDeps {
  createSystemOne: typeof defaultCreateSystemOne
}

export function createSystemOneRoutes(
  deps: Partial<SystemOneRoutesDeps> = {},
): Hono {
  const createSystemOne = deps.createSystemOne ?? defaultCreateSystemOne

  // Errors propagate to the error handler, which answers in OpenAI's format;
  // the token gate's "not signed in" goes the same way.
  const routes = new Hono()
  routes.onError(proxyErrorHandler("openai"))
  routes.use(requireGithubAuth)

  routes.post("/", async (c) => {
    const payload = await c.req.json<DecisionsPayload>()
    await admitUpstreamRequest()
    const result = await createSystemOne(payload, { signal: c.req.raw.signal })
    createCopilotTokenUsageRecorder({
      endpoint: "systemone",
      model: requestedModel(payload.model),
    })({
      input_tokens: result.usage?.input_tokens,
      output_tokens: result.usage?.output_tokens,
    })
    return c.json(result)
  })

  return routes
}

export const systemOneRoutes = createSystemOneRoutes()
