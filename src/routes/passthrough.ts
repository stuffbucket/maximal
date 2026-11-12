/**
 * Shared steps of the pass-through routes (images, decisions, SystemOne),
 * which relay a request to one model operation and its JSON reply back
 * unchanged: resolve the model, admit the request, dispatch, record usage.
 */

import {
  type ModelOperation,
  type OperationDispatch,
  OperationUnavailableError,
  type OperationResult,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import { awaitApproval } from "~/lib/http/approval"
import { checkRateLimit } from "~/lib/http/rate-limit"
import { requestContext } from "~/lib/http/request-context"
import { state } from "~/lib/runtime-state/state"
import { createTokenUsageRecorder } from "~/lib/token-usage"
import { deriveUsageClient } from "~/lib/token-usage/client"
import { COPILOT_PROVIDER_ID } from "~/services/copilot/upstream-request"

/** Wait out the rate limit and, with manual approval on, ask for approval. */
export async function admitUpstreamRequest(): Promise<void> {
  await checkRateLimit(state)
  if (state.manualApprove) await awaitApproval()
}

/** The request's `model`, which token usage is recorded against (the replies
 *  name a different model or none). */
export function requestedModel(model: unknown): string {
  return typeof model === "string" ? model : ""
}

/** The usage endpoint an operation is recorded under. */
const USAGE_ENDPOINTS = {
  "images.generations": "images",
  "images.edits": "images",
  decisions: "decisions",
  systemone: "systemone",
} as const satisfies Record<ModelOperation, string>

/** What served a request: the operation, the model as the client named it, and
 *  the provider that answered. */
export interface ServedOperation {
  operation: ModelOperation
  model: string
  provider: string
}

/**
 * Record one operation's usage: against the request's model (`model`, as the
 * client named it) and the provider that served it. Copilot's rows keep
 * `source: "copilot"`; any other provider's are `source: "provider"`.
 */
export function recordOperationUsage(
  { operation, model, provider }: ServedOperation,
  result: OperationResult,
): void {
  createTokenUsageRecorder({
    endpoint: USAGE_ENDPOINTS[operation],
    model,
    providerName: provider,
    source: provider === COPILOT_PROVIDER_ID ? "copilot" : "provider",
  })({
    ...result.usage,
    total_nano_aiu: result.cost?.amount,
  })
}

export interface OperationCall {
  operation: ModelOperation
  /** The body's `model`, as parsed (any type; non-strings count as none). */
  model: unknown
  /** JSON body, or the client's multipart form. */
  body: Record<string, unknown> | FormData
  signal: AbortSignal
}

/**
 * Serve one pass-through request: the model must resolve (else
 * `OperationUnavailableError`, a 404 on the OpenAI wire), then the request is
 * admitted, dispatched, and its usage recorded. Returns the JSON to relay.
 */
export async function runOperation(
  operations: OperationDispatch,
  call: OperationCall,
): Promise<Record<string, unknown>> {
  const model = requestedModel(call.model)
  const target = operations.resolve(call.operation, model)
  if (!target) throw new OperationUnavailableError(call.operation, model)
  await admitUpstreamRequest()
  const store = requestContext.getStore()
  const result = await operations.dispatch({
    operation: call.operation,
    model,
    body: call.body,
    signal: call.signal,
    origin: {
      kind: "http",
      client: deriveUsageClient(
        store?.usage.apiKeyLabel,
        store?.userAgent ?? "",
      ),
    },
  })
  recordOperationUsage(
    { operation: call.operation, model, provider: target.binding.provider },
    result,
  )
  return result.json
}
