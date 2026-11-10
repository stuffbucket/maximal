/**
 * `/v1/images/generations` and `/v1/images/edits`: relayed to Copilot's
 * endpoints of the same path and answered with its JSON unchanged. An edit
 * may be JSON or a multipart form; a form is re-sent as a form.
 *
 * `createImagesRoutes(deps)` lets tests inject the upstream calls without a
 * process-wide `mock.module` (docs/architecture.md § Testing gotchas).
 */

import { Hono } from "hono"

import { requireGithubAuth } from "~/lib/auth/request-auth"
import { proxyErrorHandler } from "~/lib/errors/proxy-errors"
import {
  createCopilotTokenUsageRecorder,
  normalizeResponsesUsage,
  withCopilotCost,
} from "~/lib/token-usage"
import { admitUpstreamRequest, requestedModel } from "~/routes/passthrough"
import {
  createImageEdit as defaultCreateImageEdit,
  createImageGeneration as defaultCreateImageGeneration,
  type ImageEditBody,
  type ImagesPayload,
  type ImagesResult,
} from "~/services/copilot/create-images"

export interface ImagesRoutesDeps {
  createImageGeneration: typeof defaultCreateImageGeneration
  createImageEdit: typeof defaultCreateImageEdit
}

const defaultDeps: ImagesRoutesDeps = {
  createImageGeneration: defaultCreateImageGeneration,
  createImageEdit: defaultCreateImageEdit,
}

function recordImagesUsage(model: unknown, result: ImagesResult): void {
  createCopilotTokenUsageRecorder({
    endpoint: "images",
    model: requestedModel(model),
  })(
    withCopilotCost(
      normalizeResponsesUsage(result.usage),
      result.copilot_usage,
    ),
  )
}

const isMultipart = (contentType: string | undefined): boolean =>
  contentType?.toLowerCase().startsWith("multipart/form-data") ?? false

export function createImagesRoutes(deps: Partial<ImagesRoutesDeps> = {}): Hono {
  const { createImageGeneration, createImageEdit } = {
    ...defaultDeps,
    ...deps,
  }

  // Errors propagate to the error handler, which answers in OpenAI's format;
  // the token gate's "not signed in" goes the same way.
  const routes = new Hono()
  routes.onError(proxyErrorHandler("openai"))
  routes.use(requireGithubAuth)

  routes.post("/generations", async (c) => {
    const payload = await c.req.json<ImagesPayload>()
    await admitUpstreamRequest()
    const result = await createImageGeneration(payload, {
      signal: c.req.raw.signal,
    })
    recordImagesUsage(payload.model, result)
    return c.json(result)
  })

  routes.post("/edits", async (c) => {
    let body: ImageEditBody
    let model: unknown
    if (isMultipart(c.req.header("content-type"))) {
      const form = await c.req.formData()
      body = form
      model = form.get("model")
    } else {
      const payload = await c.req.json<ImagesPayload>()
      body = payload
      model = payload.model
    }
    await admitUpstreamRequest()
    const result = await createImageEdit(body, { signal: c.req.raw.signal })
    recordImagesUsage(model, result)
    return c.json(result)
  })

  return routes
}

export const imagesRoutes = createImagesRoutes()
