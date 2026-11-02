import type {
  ClaudeAutoAutomaticReason,
  ClaudeAutoTierState,
} from "~/lib/models/claude-auto-model-types"
import type { Model } from "~/services/copilot/get-models"

import { pricedModelIsPaid } from "~/services/copilot/get-models"

import { isVariantId } from "./anthropic-id-rewrite"
import {
  isClaudeTierClass,
  isGptClass,
  isSmallGptClass,
} from "./model-identity"

export type ClaudeAutoTier = "fast" | "capable"

interface ClaudeAutoModelResolution {
  fast: ClaudeAutoTierState
  capable: ClaudeAutoTierState
  eligibleModels: Array<Model>
}

interface TierIds {
  fast?: string
  capable?: string
}

interface ResolveClaudeAutoModelsInput {
  models?: Array<Model>
  overrides?: TierIds
  external?: TierIds
  previousAutomatic?: TierIds
}

const ROUTABLE_ENDPOINTS = new Set([
  "/v1/messages",
  "/responses",
  "/chat/completions",
])

export function isClaudeAutoModelEligible(model: Model): boolean {
  const sparse = model as {
    id?: unknown
    model_picker_enabled?: unknown
    supported_endpoints?: unknown
    capabilities?: {
      type?: unknown
      supports?: { tool_calls?: unknown; streaming?: unknown }
    }
  }
  if (typeof sparse.id !== "string" || sparse.id.length === 0) return false
  if (sparse.model_picker_enabled !== true) return false
  if (sparse.capabilities?.type === "embeddings") return false
  if (isVariantId(sparse.id)) return false
  if (sparse.capabilities?.supports?.tool_calls !== true) return false
  if (sparse.capabilities.supports.streaming !== true) return false
  if (!Array.isArray(sparse.supported_endpoints)) return false
  return sparse.supported_endpoints.some(
    (endpoint) =>
      typeof endpoint === "string" && ROUTABLE_ENDPOINTS.has(endpoint),
  )
}

function isExplicitlyFree(model: Model): boolean {
  return pricedModelIsPaid(model.billing?.token_prices) === false
}

function chooseFromBucket(
  bucket: Array<Model>,
  previousId: string | undefined,
): Model | undefined {
  const previous = bucket.find((candidate) => candidate.id === previousId)
  if (previous) return previous

  const stable = bucket.filter((candidate) => !candidate.preview)
  const stablePool = stable.length > 0 ? stable : bucket
  const free = stablePool.filter((candidate) => isExplicitlyFree(candidate))
  return (free.length > 0 ? free : stablePool)[0]
}

function automaticResolution(
  tier: ClaudeAutoTier,
  eligible: Array<Model>,
  previousId: string | undefined,
): ClaudeAutoTierState {
  const buckets: Array<{
    models: Array<Model>
    reason: ClaudeAutoAutomaticReason
  }> =
    tier === "fast" ?
      [
        {
          models: eligible.filter((model) => isClaudeTierClass(model, "haiku")),
          reason: "haiku",
        },
        {
          models: eligible.filter((model) => isSmallGptClass(model)),
          reason: "small-gpt",
        },
        {
          models: eligible.filter((model) => isGptClass(model)),
          reason: "gpt",
        },
      ]
    : [
        {
          models: eligible.filter((model) =>
            isClaudeTierClass(model, "sonnet"),
          ),
          reason: "sonnet",
        },
        {
          models: eligible.filter(
            (model) => isGptClass(model) && !isSmallGptClass(model),
          ),
          reason: "gpt",
        },
        {
          models: eligible.filter((model) => isSmallGptClass(model)),
          reason: "small-gpt",
        },
      ]

  for (const bucket of buckets) {
    const selected = chooseFromBucket(bucket.models, previousId)
    if (selected) {
      return {
        configured: null,
        effective: selected.id,
        source: "automatic",
        status: "ready",
        reason: bucket.reason,
      }
    }
  }

  return {
    configured: null,
    effective: null,
    source: "none",
    status: "unresolved",
    reason: "no-match",
  }
}

function resolveTier(
  tier: ClaudeAutoTier,
  eligible: Array<Model>,
  input: ResolveClaudeAutoModelsInput,
): ClaudeAutoTierState {
  const override = input.overrides?.[tier]?.trim()
  if (override) {
    const selected = eligible.find((model) => model.id === override)
    return selected ?
        {
          configured: override,
          effective: override,
          source: "maximal-override",
          status: "ready",
          reason: "override",
        }
      : {
          configured: override,
          effective: null,
          source: "maximal-override",
          status: "unavailable",
          reason: "override-unavailable",
        }
  }

  const external = input.external?.[tier]?.trim()
  if (external) {
    const selected = eligible.find((model) => model.id === external)
    return selected ?
        {
          configured: null,
          effective: external,
          source: "claude-code-setting",
          status: "ready",
          reason: "external-setting",
        }
      : {
          configured: null,
          effective: external,
          source: "claude-code-setting",
          status: "unavailable",
          reason: "external-unavailable",
        }
  }

  return automaticResolution(tier, eligible, input.previousAutomatic?.[tier])
}

export function resolveClaudeAutoModels(
  input: ResolveClaudeAutoModelsInput,
): ClaudeAutoModelResolution {
  const eligibleModels = (input.models ?? []).filter((model) =>
    isClaudeAutoModelEligible(model),
  )
  return {
    fast: resolveTier("fast", eligibleModels, input),
    capable: resolveTier("capable", eligibleModels, input),
    eligibleModels,
  }
}
