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
 * reads `state.models` (already filtered by `isCatalogModel` in
 * cacheModels) — it never exposes tokens.
 */

import type { Context } from "hono"

import { Hono } from "hono"

import type { AnthropicMessagesConfig } from "~/lib/config/config"
import type { ClaudeAutoModelsUpdateRequest as AutoModelsUpdate } from "~/lib/config/settings-types"
import type { ClaudeAutoTier } from "~/lib/models/claude-auto-models"
import type { Model } from "~/services/copilot/get-models"

import {
  getClaudeAutoModelsState,
  getClaudeCodeSettingsPath,
} from "~/apps/claude-code/config"
import { reconcileClaudeCodeAutoModels } from "~/apps/claude-code/reconcile"
import {
  anthropicMessagesConfig,
  getConfig,
  writeConfig,
} from "~/lib/config/config"
import {
  ClaudeAutoModelsUpdateRequest,
  ModelsListResponse,
  type ModelsListResponse as ModelsListResponseT,
  type ModelSummary as ModelSummaryT,
} from "~/lib/config/settings-types"
import { forwardError, HTTPError } from "~/lib/errors/error"
import {
  isClaudeAutoModelEligible,
  isClaudeCodeClassifierEligible,
} from "~/lib/models/claude-auto-models"
import { cacheModels } from "~/lib/platform/utils"
import { getModelsLoadedAtMs, state } from "~/lib/runtime-state/state"

import { respondValidated } from "./respond-validated"

/** Flatten an upstream `Model` into the UI-shaped summary. Optional
 *  upstream fields collapse to null/false so the contract stays total. */
function toSummary(model: Model): ModelSummaryT {
  // `normalizeModel` (the /models fetch boundary) is the primary defense — it
  // guarantees `capabilities`/`limits`/`supports` are present for everything
  // that flows through `getModels`. These container guards are a deliberate
  // backstop: `state.models` is also writable directly via `setModels`, so an
  // un-normalized entry can still reach this user-facing route (the
  // settings-api-models regression test pins exactly that path). Collapsing
  // missing containers + leaves keeps the response total instead of throwing.
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
    claude_code_auto: getClaudeAutoModelsState(),
  }
}

/** Validate against the contract before responding, so drift between
 *  the runtime shape and the published schema fails loudly in tests
 *  rather than silently in the UI. */
function jsonModels(c: Context) {
  return respondValidated(
    c,
    { schema: ModelsListResponse, label: "Models" },
    buildModelsList(),
  )
}

function httpError(message: string, status: number): HTTPError {
  return new HTTPError(message, new Response(message, { status }))
}

function validateSelection(
  tier: ClaudeAutoTier,
  id: string | null | undefined,
): void {
  if (id === null || id === undefined) return
  const selected = state.models?.data.find((model) => model.id === id)
  const eligible =
    tier === "classifier" ?
      selected && isClaudeCodeClassifierEligible(selected)
    : selected && isClaudeAutoModelEligible(selected)
  if (!eligible) {
    throw httpError(`Model ${id} is not available for ${tier}`, 400)
  }
}

function updateTierConfig(
  current: AnthropicMessagesConfig,
  key: "haikuModel" | "sonnetModel" | "autoPermissionModel",
  value: string | null | undefined,
): AnthropicMessagesConfig {
  if (value === undefined) return current
  const { [key]: _removed, ...without } = current
  return value === null ? without : { ...without, [key]: value }
}

function persistSelections(input: AutoModelsUpdate): void {
  const config = getConfig()
  const {
    fastModel: _legacyFast,
    capableModel: _legacyCapable,
    classifierModel: _legacyClassifier,
    ...claudeCode
  } = config.apps?.claudeCode ?? {}
  let messages = anthropicMessagesConfig(config)
  messages = updateTierConfig(messages, "haikuModel", input.fast)
  messages = updateTierConfig(messages, "sonnetModel", input.capable)
  messages = updateTierConfig(messages, "autoPermissionModel", input.classifier)
  writeConfig({
    ...config,
    anthropicMessages: messages,
    apps: { ...config.apps, claudeCode },
  })
}

export const modelsRoutes = new Hono()

modelsRoutes.get("/", (c) => jsonModels(c))

modelsRoutes.patch("/claude-code-auto", async (c) => {
  try {
    const body: unknown = await c.req.json().catch(() => null)
    const parsed = ClaudeAutoModelsUpdateRequest.safeParse(body)
    if (!parsed.success) {
      throw httpError(
        "Expected Haiku, Sonnet, or classifier model id or null",
        400,
      )
    }
    validateSelection("fast", parsed.data.fast)
    validateSelection("capable", parsed.data.capable)
    validateSelection("classifier", parsed.data.classifier)
    persistSelections(parsed.data)
    const claimed = new Set<ClaudeAutoTier>()
    if (parsed.data.fast !== undefined) claimed.add("fast")
    if (parsed.data.capable !== undefined) claimed.add("capable")
    if (parsed.data.classifier !== undefined) claimed.add("classifier")
    reconcileClaudeCodeAutoModels(getClaudeCodeSettingsPath(), {
      claimAutoModels: claimed,
    })
    return jsonModels(c)
  } catch (error) {
    return forwardError(c, error)
  }
})

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
