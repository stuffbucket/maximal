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
import { normalizeSdkModelId } from "./models"

export type ClaudeAutoTier = "fast" | "capable" | "classifier"

interface ClaudeAutoModelResolution {
  fast: ClaudeAutoTierState
  capable: ClaudeAutoTierState
  classifier: ClaudeAutoTierState
  eligibleModels: Array<Model>
  classifierEligibleModels: Array<Model>
}

interface TierIds {
  fast?: string
  capable?: string
  classifier?: string
}

interface ResolveClaudeAutoModelsInput {
  models?: Array<Model>
  overrides?: TierIds
  external?: TierIds
  previousAutomatic?: TierIds
  sessionModel?: string
}

/** Copilot endpoints the proxy can send an inference request to. */
export const ROUTABLE_ENDPOINTS: ReadonlySet<string> = new Set([
  "/v1/messages",
  "/responses",
  "/chat/completions",
])

/**
 * Models Maximal may pick for a Claude Code tier: a non-embeddings,
 * non-variant model that calls tools, streams and serves a routable endpoint.
 * Copilot's picker visibility doesn't matter.
 */
export function isClaudeAutoModelEligible(model: Model): boolean {
  const sparse = model as {
    id?: unknown
    supported_endpoints?: unknown
    capabilities?: {
      type?: unknown
      supports?: { tool_calls?: unknown; streaming?: unknown }
    }
  }
  if (typeof sparse.id !== "string" || sparse.id.length === 0) return false
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

const SUPPORTED_CLASSIFIER_VERSIONS = {
  haiku: new Set<string>(["5.5"]),
  sonnet: new Set<string>(["5"]),
  opus: new Set<string>(["4.7", "4.8"]),
  fable: new Set<string>(["5", "5.1"]),
} as const

function normalizedClaudeIdentity(model: Model) {
  const version = typeof model.version === "string" ? model.version : ""
  const family =
    typeof model.capabilities.family === "string" ?
      model.capabilities.family
    : ""
  for (const candidate of [
    version,
    family,
    family && version ? `${family}-${version}` : "",
    model.id,
  ]) {
    const normalized = normalizeSdkModelId(candidate)
    if (normalized) return normalized
  }
  return undefined
}

/** Models Claude Code can use for its client-side Auto permission classifier. */
export function isClaudeCodeClassifierEligible(model: Model): boolean {
  if (!isClaudeAutoModelEligible(model)) return false
  if (isGptClass(model)) return true

  const normalized = normalizedClaudeIdentity(model)
  if (!normalized) return false
  if (normalized.family === "haiku") {
    return SUPPORTED_CLASSIFIER_VERSIONS.haiku.has(normalized.version)
  }
  if (normalized.family === "sonnet") {
    return SUPPORTED_CLASSIFIER_VERSIONS.sonnet.has(normalized.version)
  }
  if (normalized.family === "opus") {
    return SUPPORTED_CLASSIFIER_VERSIONS.opus.has(normalized.version)
  }
  if (normalized.family === "fable") {
    return SUPPORTED_CLASSIFIER_VERSIONS.fable.has(normalized.version)
  }
  return false
}

function isClassifierClaudeFamily(
  model: Model,
  family: "haiku" | "sonnet" | "opus" | "fable",
): boolean {
  return normalizedClaudeIdentity(model)?.family === family
}

function isExplicitlyFree(model: Model): boolean {
  return pricedModelIsPaid(model.billing?.token_prices) === false
}

function chooseFromBucket(bucket: Array<Model>): Model | undefined {
  const stable = bucket.filter((candidate) => !candidate.preview)
  const stablePool = stable.length > 0 ? stable : bucket
  const free = stablePool.filter((candidate) => isExplicitlyFree(candidate))
  return (free.length > 0 ? free : stablePool)[0]
}

function sessionGpt(
  eligible: Array<Model>,
  sessionModel: string | undefined,
): Array<Model> {
  const id = sessionModel?.replace(/\[1m\]$/u, "")
  if (!id) return []
  const selected = eligible.find(
    (model) => model.id === id && isGptClass(model),
  )
  return selected ? [selected] : []
}

function automaticBuckets(
  tier: ClaudeAutoTier,
  eligible: Array<Model>,
  sessionModel: string | undefined,
): Array<{ models: Array<Model>; reason: ClaudeAutoAutomaticReason }> {
  if (tier === "fast") {
    return [
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
  }
  if (tier === "capable") {
    return [
      {
        models: eligible.filter((model) => isClaudeTierClass(model, "sonnet")),
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
  }
  return [
    {
      models: eligible.filter((model) =>
        isClassifierClaudeFamily(model, "haiku"),
      ),
      reason: "haiku",
    },
    { models: sessionGpt(eligible, sessionModel), reason: "gpt" },
    {
      models: eligible.filter((model) => isSmallGptClass(model)),
      reason: "small-gpt",
    },
    {
      models: eligible.filter((model) => isGptClass(model)),
      reason: "gpt",
    },
  ]
}

function automaticResolution(input: {
  tier: ClaudeAutoTier
  eligible: Array<Model>
  previousId: string | undefined
  sessionModel: string | undefined
}): ClaudeAutoTierState {
  const buckets = automaticBuckets(
    input.tier,
    input.eligible,
    input.sessionModel,
  )
  const previousBucket = buckets.find((bucket) =>
    bucket.models.some((model) => model.id === input.previousId),
  )
  if (previousBucket && input.previousId) {
    return {
      configured: null,
      effective: input.previousId,
      source: "automatic",
      status: "ready",
      reason: previousBucket.reason,
    }
  }
  for (const bucket of buckets) {
    const selected = chooseFromBucket(bucket.models)
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

  return automaticResolution({
    tier,
    eligible,
    previousId: input.previousAutomatic?.[tier],
    sessionModel: input.sessionModel,
  })
}

export function resolveClaudeAutoModels(
  input: ResolveClaudeAutoModelsInput,
): ClaudeAutoModelResolution {
  const eligibleModels = (input.models ?? []).filter((model) =>
    isClaudeAutoModelEligible(model),
  )
  const classifierEligibleModels = eligibleModels.filter((model) =>
    isClaudeCodeClassifierEligible(model),
  )
  return {
    fast: resolveTier("fast", eligibleModels, input),
    capable: resolveTier("capable", eligibleModels, input),
    classifier: resolveTier("classifier", classifierEligibleModels, input),
    eligibleModels,
    classifierEligibleModels,
  }
}
