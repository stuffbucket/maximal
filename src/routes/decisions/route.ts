/**
 * `/v1/decisions` (the OpenAI Decisions API): dispatched to the `decisions`
 * operation (today Copilot's `/v1/decisions`, through the built-in handler)
 * and answered with the JSON unchanged.
 *
 * `createDecisionsRoutes(deps)` lets tests inject the operation dispatch (or
 * the built-in upstream call) without a process-wide `mock.module`
 * (docs/architecture.md § Testing gotchas).
 */

import type { OperationDispatch } from "@stuffbucket/maximal-plugin-sdk/gateway"

import { Hono } from "hono"

import { requireGithubAuth } from "~/lib/auth/request-auth"
import { proxyErrorHandler } from "~/lib/errors/proxy-errors"
import {
  type BuiltinOperationDeps,
  createBuiltinOperationDispatch,
} from "~/lib/operations/builtin"
import { runOperation } from "~/routes/passthrough"

export type DecisionsRoutesDeps = Partial<BuiltinOperationDeps> & {
  /** Serves the operation; the built-in Copilot handler by default. */
  operations?: OperationDispatch
}

export function createDecisionsRoutes(deps: DecisionsRoutesDeps = {}): Hono {
  const operations = deps.operations ?? createBuiltinOperationDispatch(deps)

  // Errors propagate to the error handler, which answers in OpenAI's format;
  // the token gate's "not signed in" goes the same way.
  const routes = new Hono()
  routes.onError(proxyErrorHandler("openai"))
  routes.use(requireGithubAuth)

  routes.post("/", async (c) => {
    const payload = await c.req.json<Record<string, unknown>>()
    return c.json(
      await runOperation(operations, {
        operation: "decisions",
        model: payload.model,
        body: payload,
        signal: c.req.raw.signal,
      }),
    )
  })

  return routes
}

export const decisionsRoutes = createDecisionsRoutes()
