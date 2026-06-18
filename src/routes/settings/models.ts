/**
 * /settings/api/models — read-only view of the cached model catalog,
 * plus a manual refresh.
 *
 * The catalog itself is fetched from Copilot's `/models` at boot and
 * refreshed lazily on activity (src/lib/refresh-models.ts). That timer
 * is a freshness *optimization*, not a correctness guarantee — its
 * clock-start is uncorrelated with when Copilot actually changes the
 * list. So this route also exposes `POST /refresh`, which forces a
 * `cacheModels()` now and returns the fresh list. The UI surfaces the
 * cache's age next to that button so staleness is visible and
 * actionable rather than silent.
 *
 * Auth-gated by the parent `/settings/api` middleware. This route only
 * reads `state.models` (already filtered to model_picker_enabled ||
 * embeddings by cacheModels) — it never exposes tokens.
 */

import type { Context } from "hono"

import { Hono } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { forwardError } from "~/lib/error"
import {
  ModelsListResponse,
  type ModelsListResponse as ModelsListResponseT,
  type ModelSummary as ModelSummaryT,
} from "~/lib/settings-types"
import { getModelsLoadedAtMs, state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

/** Flatten an upstream `Model` into the UI-shaped summary. Optional
 *  upstream fields collapse to null/false so the contract stays total. */
function toSummary(model: Model): ModelSummaryT {
  // Copilot's catalog is not uniform: some entries omit `capabilities`,
  // `limits`, or `supports` entirely. The static type claims they're
  // required, so a single malformed model used to throw here and blank
  // the whole list. Treat every nested object as optional and collapse
  // missing fields to null/false so the contract stays total.
  const capabilities =
    (model as { capabilities?: Partial<Model["capabilities"]> }).capabilities
    ?? {}
  const limits = capabilities.limits ?? {}
  const supports = capabilities.supports ?? {}
  return {
    id: model.id,
    name: model.name,
    vendor: model.vendor,
    family: capabilities.family ?? "",
    type: capabilities.type ?? "",
    preview: model.preview,
    context_window_tokens: limits.max_context_window_tokens ?? null,
    max_output_tokens: limits.max_output_tokens ?? null,
    capabilities: {
      vision: supports.vision ?? false,
      tool_calls: supports.tool_calls ?? false,
      streaming: supports.streaming ?? false,
      // "Reasoning" is true when the model declares adaptive thinking or
      // any reasoning_effort ladder — either signals extended thinking.
      reasoning:
        (supports.adaptive_thinking ?? false)
        || (supports.reasoning_effort?.length ?? 0) > 0,
    },
  }
}

/** Build the list response from current state. Models are sorted by
 *  type then name so the grouped UI renders deterministically. */
function buildModelsList(): ModelsListResponseT {
  const models = (state.models?.data ?? []).map((model) => toSummary(model))
  models.sort(
    (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
  )
  const loadedAtMs = getModelsLoadedAtMs()
  return {
    models,
    count: models.length,
    loaded_at: loadedAtMs === null ? null : new Date(loadedAtMs).toISOString(),
  }
}

/** Validate against the contract before responding, so drift between
 *  the runtime shape and the published schema fails loudly in tests
 *  rather than silently in the UI. */
function jsonModels(c: Context) {
  const parsed = ModelsListResponse.safeParse(buildModelsList())
  if (!parsed.success) {
    return c.json(
      {
        error: {
          message: "Models payload failed schema validation",
          type: "internal_error",
          details: parsed.error.issues,
        },
      },
      500,
    )
  }
  return c.json(parsed.data)
}

export const modelsRoutes = new Hono()

modelsRoutes.get("/", (c) => jsonModels(c))

modelsRoutes.post("/refresh", async (c) => {
  try {
    // Force a fresh fetch now, bypassing the activity timer. On upstream
    // failure cacheModels throws and we keep the stale cache; forwardError
    // relays the upstream status so the UI can explain what went wrong.
    await cacheModels()
    return jsonModels(c)
  } catch (error) {
    return forwardError(c, error)
  }
})
