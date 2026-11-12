/**
 * `/v1/systemone`: dispatched to the `systemone` operation (served by the
 * systemone capability plugin) and answered with the JSON unchanged.
 *
 * `createSystemOneRoutes(deps)` lets tests inject the operation dispatch
 * without a process-wide `mock.module` (docs/architecture.md § Testing gotchas).
 */

import type { OperationDispatch } from "@stuffbucket/maximal-plugin-sdk/gateway"

import { Hono } from "hono"

import { requireGithubAuth } from "~/lib/auth/request-auth"
import { proxyErrorHandler } from "~/lib/errors/proxy-errors"
import { pluginOperations } from "~/lib/plugins/gateway"
import { runOperation } from "~/routes/passthrough"

export interface SystemOneRoutesDeps {
  /** Serves the operation; the running plugin gateway's by default. */
  operations?: OperationDispatch
}

export function createSystemOneRoutes(deps: SystemOneRoutesDeps = {}): Hono {
  const operations = deps.operations ?? pluginOperations

  // Errors propagate to the error handler, which answers in OpenAI's format;
  // the token gate's "not signed in" goes the same way.
  const routes = new Hono()
  routes.onError(proxyErrorHandler("openai"))
  routes.use(requireGithubAuth)

  routes.post("/", async (c) => {
    const payload = await c.req.json<Record<string, unknown>>()
    return c.json(
      await runOperation(operations, {
        operation: "systemone",
        model: payload.model,
        body: payload,
        signal: c.req.raw.signal,
      }),
    )
  })

  return routes
}

export const systemOneRoutes = createSystemOneRoutes()
