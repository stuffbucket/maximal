import type { Model } from "~/services/copilot/get-models"

import { pricedModelIsPaid } from "~/services/copilot/get-models"

import { isVariantId } from "./anthropic-id-rewrite"

export type ClaudeAutoTier = "fast" | "capable"

export type ClaudeAutoModelSource =
  | "maximal-override"
  | "claude-code-setting"
  | "automatic"
  | "none"

export type ClaudeAutoModelStatus = "ready" | "unavailable" | "unresolved"

export type ClaudeAutoModelReason =
  | "override"
  | "external-setting"
  | "haiku"
  | "sonnet"
  | "small-gpt"
  | "gpt"
  | "override-unavailable"
  | "external-unavailable"
  | "no-match"

export interface ClaudeAutoTierResolution {
  configured: string | null
  effective: string | null
  source: ClaudeAutoModelSource
  status: ClaudeAutoModelStatus
  reason: ClaudeAutoModelReason
}

export interface ClaudeAutoModelResolution {
  fast: ClaudeAutoTierResolution
  capable: ClaudeAutoTierResolution
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

function modelParts(model: Model): {
  id: string
  family: string
  vendor: string
} {
  const sparse = model as {
    id?: unknown
    vendor?: unknown
    capabilities?: { family?: unknown }
  }
  return {
    id: typeof sparse.id === "string" ? sparse.id.toLowerCase() : "",
    family:
      typeof sparse.capabilities?.family === "string" ?
        sparse.capabilities.family.toLowerCase()
      : "",
    vendor:
      typeof sparse.vendor === "string" ? sparse.vendor.toLowerCase() : "",
  }
}

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

function isClaudeClass(model: Model, tier: "haiku" | "sonnet"): boolean {
  const { id, family, vendor } = modelParts(model)
  const isClaude =
    family.includes("claude")
    || id.startsWith("claude")
    || vendor.includes("anthropic")
  return isClaude && (family.includes(tier) || id.includes(tier))
}

function isGptClass(model: Model): boolean {
  const { id, family, vendor } = modelParts(model)
  return (
    id.startsWith("gpt") || family.includes("gpt") || vendor.includes("openai")
  )
}

function isSmallGpt(model: Model): boolean {
  if (!isGptClass(model)) return false
  const { id, family } = modelParts(model)
  return /(?:^|[-_.\s])(?:mini|nano|small)(?:$|[-_.\s])/u.test(
    `${id} ${family}`,
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
): ClaudeAutoTierResolution {
  const buckets: Array<{
    models: Array<Model>
    reason: ClaudeAutoModelReason
  }> =
    tier === "fast" ?
      [
        {
          models: eligible.filter((model) => isClaudeClass(model, "haiku")),
          reason: "haiku",
        },
        {
          models: eligible.filter((model) => isSmallGpt(model)),
          reason: "small-gpt",
        },
        {
          models: eligible.filter((model) => isGptClass(model)),
          reason: "gpt",
        },
      ]
    : [
        {
          models: eligible.filter((model) => isClaudeClass(model, "sonnet")),
          reason: "sonnet",
        },
        {
          models: eligible.filter(
            (model) => isGptClass(model) && !isSmallGpt(model),
          ),
          reason: "gpt",
        },
        {
          models: eligible.filter((model) => isSmallGpt(model)),
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
): ClaudeAutoTierResolution {
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
    return {
      configured: null,
      effective: external,
      source: "claude-code-setting",
      status: selected ? "ready" : "unavailable",
      reason: selected ? "external-setting" : "external-unavailable",
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
