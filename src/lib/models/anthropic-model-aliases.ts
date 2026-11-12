import type {
  AnthropicMessagesConfig,
  ModelMappingRule,
} from "~/lib/config/config"
import type { Model } from "~/services/copilot/get-models"

import { resolveClaudeAutoModels } from "./claude-auto-models"
import { type ModelMappingResult, resolveModelMapping } from "./model-mapping"
import { normalizeSdkModelId } from "./models"

interface ResolveAnthropicModelAliasOptions {
  requestedModel: string
  rules: ReadonlyArray<ModelMappingRule>
  config: AnthropicMessagesConfig
  models: ReadonlyArray<Model>
}

function configuredTierIds(config: AnthropicMessagesConfig): {
  fast?: string
  capable?: string
  classifier?: string
} {
  return {
    ...(config.haikuModel ? { fast: config.haikuModel } : {}),
    ...(config.sonnetModel ? { capable: config.sonnetModel } : {}),
    ...(config.autoPermissionModel ?
      { classifier: config.autoPermissionModel }
    : {}),
  }
}

function tierForModel(model: string): "fast" | "capable" | undefined {
  const normalized = normalizeSdkModelId(model)
  if (normalized?.family === "haiku") return "fast"
  if (normalized?.family === "sonnet") return "capable"
  return undefined
}

/**
 * Resolve mappings owned by the root Anthropic Messages ingress. Advanced
 * `modelMappings` rules win first. Otherwise any normalized Haiku or Sonnet
 * identifier uses the configured tier target, regardless of which client sent
 * it. The classifier selection is deliberately not an inbound alias: it tells
 * Claude Code which identifier to send for a client-side permission decision.
 */
export function resolveAnthropicModelAlias({
  requestedModel,
  rules,
  config,
  models,
}: ResolveAnthropicModelAliasOptions): ModelMappingResult {
  const mapping = resolveModelMapping({
    requestedModel,
    rules,
    models,
    endpoint: null,
  })
  if (mapping.status !== "unmatched") return mapping

  const tier = tierForModel(requestedModel)
  if (!tier) return mapping

  const resolution = resolveClaudeAutoModels({
    models: [...models],
    overrides: configuredTierIds(config),
  })[tier]
  if (resolution.status === "unresolved") return mapping

  const target = resolution.effective ?? resolution.configured
  if (!target) return mapping
  return resolveModelMapping({
    requestedModel,
    rules: [{ match: { type: "exact", value: requestedModel }, target }],
    models,
    endpoint: null,
  })
}
