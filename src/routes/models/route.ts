import { Hono } from "hono"

import { forwardId, isVariantId } from "~/lib/anthropic-id-rewrite"
import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

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
    // Return ONLY the documented fields (see docs/spec/wire/models-wire-prd.md).
    // Spreading the raw Copilot model (`...model`) leaked internal fields —
    // `billing`, `capabilities`, `policy`, `model_picker_*`, `supported_endpoints`,
    // etc. — to every client. That both breaks the documented contract and can
    // make a strict client validator (e.g. Claude Desktop's model picker) reject
    // the entries and render an empty list. Build each entry explicitly.
    const models = state.models?.data
      .filter((model) => !isVariantId(model.id))
      .map((model) => ({
        id: forwardId(model.id),
        object: "model",
        type: "model",
        created: 0,
        created_at: new Date(0).toISOString(),
        owned_by: model.vendor,
        display_name: model.name,
      }))

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
