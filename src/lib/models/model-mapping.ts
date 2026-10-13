import type { ModelMappingRule } from "~/lib/config/config"
import type { Model } from "~/services/copilot/get-models"

export type InvalidModelMappingReason =
  | "missing"
  | "disabled"
  | "unsupported-endpoint"

export interface ModelMappingErrorBody {
  error: {
    message: string
    type: "invalid_request_error"
  }
}

export type ModelMappingResult =
  | {
      status: "unmatched"
      requestedModel: string
      resolvedModel: string
    }
  | {
      status: "resolved"
      requestedModel: string
      resolvedModel: string
      model: Model
    }
  | {
      status: "invalid-target"
      reason: InvalidModelMappingReason
      requestedModel: string
      resolvedModel: string
    }

function globToRegExp(pattern: string): RegExp {
  let source = ""
  for (const character of pattern) {
    if (character === "*") source += ".*"
    else if (character === "?") source += "."
    else {
      source += character.replaceAll(/[\\^$.*+?()[\]{}|]/gu, String.raw`\$&`)
    }
  }
  return new RegExp(`^(?:${source})$`, "u")
}

function matches(modelId: string, rule: ModelMappingRule): boolean {
  switch (rule.match.type) {
    case "exact": {
      return modelId === rule.match.value
    }
    case "glob": {
      return globToRegExp(rule.match.value).test(modelId)
    }
    case "regex": {
      return new RegExp(`^(?:${rule.match.value})$`, rule.match.flags).test(
        modelId,
      )
    }
    default: {
      return false
    }
  }
}

export function modelMappingErrorBody(
  result: Extract<ModelMappingResult, { status: "invalid-target" }>,
): ModelMappingErrorBody {
  return {
    error: {
      message: `Model mapping for "${result.requestedModel}" targets unavailable model "${result.resolvedModel}".`,
      type: "invalid_request_error",
    },
  }
}

export interface ResolveModelMappingOptions {
  requestedModel: string
  rules: ReadonlyArray<ModelMappingRule>
  models: ReadonlyArray<Model>
  endpoint: string | null
}

export function resolveModelMapping({
  requestedModel,
  rules,
  models,
  endpoint,
}: ResolveModelMappingOptions): ModelMappingResult {
  const rule = rules.find((candidate) => matches(requestedModel, candidate))
  if (!rule) {
    return {
      status: "unmatched",
      requestedModel,
      resolvedModel: requestedModel,
    }
  }

  const model = models.find((candidate) => candidate.id === rule.target)
  if (!model) {
    return {
      status: "invalid-target",
      reason: "missing",
      requestedModel,
      resolvedModel: rule.target,
    }
  }
  if (!model.model_picker_enabled) {
    return {
      status: "invalid-target",
      reason: "disabled",
      requestedModel,
      resolvedModel: rule.target,
    }
  }
  if (endpoint && !model.supported_endpoints?.includes(endpoint)) {
    return {
      status: "invalid-target",
      reason: "unsupported-endpoint",
      requestedModel,
      resolvedModel: rule.target,
    }
  }

  return {
    status: "resolved",
    requestedModel,
    resolvedModel: model.id,
    model,
  }
}
