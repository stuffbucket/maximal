/**
 * Helpers for capability plugins whose operations relay a request to one
 * path of an upstream provider and answer with its JSON unchanged (the
 * decisions, SystemOne and image plugins): the provider call, the body's
 * model rewrite, usage normalization and the Settings status for a set of
 * bindings.
 */
import type { Context } from "@deepseek-ai/cordis"

import type {
  ModelBinding,
  OperationRequest,
  OperationResult,
} from "./operations"
import type { PluginStatus } from "./types"

import { OperationUnavailableError } from "./gateway"

/** How one operation reaches its provider path. */
export interface RelaySpec {
  /** The provider path, e.g. `/v1/decisions`. */
  path: string
  /** The error message the provider's `HTTPError` carries. */
  errorMessage: string
  /** Normalizes the reply's own usage object. */
  usage(reply: Record<string, unknown>): OperationResult["usage"]
}

const tokens = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ?
    Math.max(0, Math.floor(value))
  : undefined

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ?
    (value as Record<string, unknown>)
  : {}

/**
 * Usage in OpenAI's Responses shape (`input_tokens`,
 * `input_tokens_details.cached_tokens`, `output_tokens`, `total_tokens`) as
 * the app records it: input net of cached tokens, cached tokens apart.
 */
export function responsesUsage(usage: unknown): OperationResult["usage"] {
  const raw = record(usage)
  const cached = tokens(record(raw.input_tokens_details).cached_tokens) ?? 0
  const total = tokens(raw.total_tokens)
  return {
    input_tokens: Math.max(0, (tokens(raw.input_tokens) ?? 0) - cached),
    output_tokens: tokens(raw.output_tokens) ?? 0,
    cache_read_input_tokens: cached,
    ...(total === undefined ? {} : { total_tokens: total }),
  }
}

/** Usage that is just `input_tokens` and `output_tokens`, as the reply gave them. */
export function plainUsage(usage: unknown): OperationResult["usage"] {
  const raw = record(usage)
  return {
    input_tokens: tokens(raw.input_tokens),
    output_tokens: tokens(raw.output_tokens),
  }
}

/**
 * The body with its `model` set to the upstream's own id. A body that already
 * names it is returned as is (relayed unchanged); a form is copied, so the
 * client's own form is never mutated.
 */
export function withUpstreamModel(
  body: Record<string, unknown> | FormData,
  upstreamModel: string,
): Record<string, unknown> | FormData {
  if (body instanceof FormData) {
    if (body.get("model") === upstreamModel) return body
    const copy = new FormData()
    for (const [name, value] of body.entries()) {
      if (name !== "model") copy.append(name, value)
    }
    copy.set("model", upstreamModel)
    return copy
  }
  return body.model === upstreamModel ? body : { ...body, model: upstreamModel }
}

/**
 * Serve one request through the binding's provider: `postJson` to the spec's
 * path, the reply unchanged, usage normalized and the provider's cost. A
 * binding whose provider isn't registered counts as unavailable (404 on the
 * wire), not as a server fault.
 */
export async function relayOperation(
  ctx: Context,
  request: OperationRequest,
  spec: RelaySpec,
): Promise<OperationResult> {
  const provider = ctx.providers.get(request.binding.provider)
  if (!provider) {
    throw new OperationUnavailableError(request.operation, request.model)
  }
  const { invocationId, providerCallId, sequence } = request
  const json = await provider.postJson<Record<string, unknown>>(
    spec.path,
    withUpstreamModel(request.body, request.binding.upstreamModel),
    {
      signal: request.signal,
      errorMessage: spec.errorMessage,
      invocation: {
        invocationId,
        providerCallId,
        sequence,
        operation: request.operation,
        model: request.binding.upstreamModel,
      },
    },
  )
  const cost = provider.cost(json, {
    operation: request.operation,
    model: request.binding.upstreamModel,
  })
  return {
    json,
    usage: spec.usage(json),
    ...(cost ? { cost } : {}),
    invocationId,
    providerCallId,
    sequence,
  }
}

/**
 * The Settings status for a plugin's bindings: ready when each one's provider
 * is signed in and offers the model; otherwise what's missing, in the order
 * "no such provider", "provider not signed in", "model not offered".
 */
export function bindingsStatus(
  ctx: Context,
  bindings: ReadonlyArray<ModelBinding & { model: string }>,
  served: string,
): PluginStatus {
  for (const binding of bindings) {
    const provider = ctx.providers.get(binding.provider)
    if (!provider) {
      return {
        state: "error",
        code: "provider-missing",
        summary: `There is no "${binding.provider}" provider for ${binding.model}.`,
      }
    }
    if (!provider.available()) {
      return {
        state: "needs-setup",
        code: "signin-needed",
        summary: `Sign in to ${provider.displayName} to use ${binding.model}.`,
      }
    }
    if (!provider.model(binding.upstreamModel)) {
      return {
        state: "needs-setup",
        code: "model-not-offered",
        summary: `${binding.upstreamModel} isn't offered to this ${provider.displayName} account.`,
        detail:
          "It may need a different plan, or the model list hasn't loaded yet.",
      }
    }
  }
  return {
    state: "ready",
    code: "ready",
    summary: `Serving ${bindings.map((binding) => binding.model).join(", ")} on ${served}.`,
  }
}
