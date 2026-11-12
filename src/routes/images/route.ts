/**
 * `/v1/images/generations` and `/v1/images/edits`: dispatched to the
 * `images.generations` / `images.edits` operations (today Copilot's endpoints
 * of the same path, through the built-in handlers) and answered with the
 * JSON unchanged. An edit may be JSON or a multipart form; a form is re-sent
 * as a form.
 *
 * `createImagesRoutes(deps)` lets tests inject the operation dispatch (or the
 * built-in upstream calls) without a process-wide `mock.module`
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

export type ImagesRoutesDeps = Partial<BuiltinOperationDeps> & {
  /** Serves the operations; the built-in Copilot handlers by default. */
  operations?: OperationDispatch
}

const isMultipart = (contentType: string | undefined): boolean =>
  contentType?.toLowerCase().startsWith("multipart/form-data") ?? false

export function createImagesRoutes(deps: ImagesRoutesDeps = {}): Hono {
  const operations = deps.operations ?? createBuiltinOperationDispatch(deps)

  // Errors propagate to the error handler, which answers in OpenAI's format;
  // the token gate's "not signed in" goes the same way.
  const routes = new Hono()
  routes.onError(proxyErrorHandler("openai"))
  routes.use(requireGithubAuth)

  routes.post("/generations", async (c) => {
    const payload = await c.req.json<Record<string, unknown>>()
    return c.json(
      await runOperation(operations, {
        operation: "images.generations",
        model: payload.model,
        body: payload,
        signal: c.req.raw.signal,
      }),
    )
  })

  routes.post("/edits", async (c) => {
    let body: Record<string, unknown> | FormData
    let model: unknown
    if (isMultipart(c.req.header("content-type"))) {
      const form = await c.req.formData()
      body = form
      model = form.get("model")
    } else {
      const payload = await c.req.json<Record<string, unknown>>()
      body = payload
      model = payload.model
    }
    return c.json(
      await runOperation(operations, {
        operation: "images.edits",
        model,
        body,
        signal: c.req.raw.signal,
      }),
    )
  })

  return routes
}

export const imagesRoutes = createImagesRoutes()
