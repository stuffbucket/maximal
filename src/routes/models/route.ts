import { Hono } from "hono"

import { forwardError } from "~/lib/errors/error"
import { isVariantId } from "~/lib/models/anthropic-id-rewrite"
import { cacheModels } from "~/lib/platform/utils"
import { state } from "~/lib/runtime-state/state"

import {
  anthropicModelList,
  openAiModelList,
  prefersAnthropicModels,
} from "./wire-models"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    // Drop Copilot variant ids (`-high`, `-xhigh`, `-1m`, `-1m-internal`).
    // Anthropic exposes those as request-time parameters, not separate
    // ids; keeping them in the listing makes Claude Desktop's picker
    // show duplicate "Opus 4.7" entries. The handlers route the right
    // upstream variant when output_config.effort or the 1M-context beta
    // header is set.
    const models = (state.models?.data ?? []).filter(
      (model) => !isVariantId(model.id),
    )

    // Serve the shape the client's protocol expects. Anthropic clients
    // (Claude Desktop, the anthropic SDK) are detected via the
    // `anthropic-version` header / user-agent; everything else gets the
    // historical OpenAI default. Both shapes are built by explicit mappers
    // (`wire-models.ts`) so no raw Copilot field (billing, policy, …) leaks.
    return c.json(
      prefersAnthropicModels(c.req.raw.headers) ?
        anthropicModelList(models)
      : openAiModelList(models),
    )
  } catch (error) {
    return await forwardError(c, error)
  }
})
