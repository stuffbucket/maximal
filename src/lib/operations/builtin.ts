/**
 * The core's built-in operation handlers: today's Copilot bindings for the
 * pass-through routes (`/v1/images/*`, `/v1/decisions`, `/v1/systemone`), as an
 * `OperationDispatch` the routes use when no plugin serves them.
 *
 * Each handler relays the body to the Copilot endpoint of the same path and
 * returns its JSON unchanged, with usage normalized the way the routes
 * recorded it before dispatch existed. The built-in dispatch resolves any
 * model name (Copilot decides what it serves), so behaviour is identical with
 * no plugins.
 *
 * Every upstream call is injectable: tests pass fakes through the route
 * factories instead of a process-wide `mock.module`.
 */

import type {
  ModelOperation,
  OperationDispatch,
  OperationRequest,
  OperationResult,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import { extractCopilotCost, normalizeResponsesUsage } from "~/lib/token-usage"
import {
  createDecisions as defaultCreateDecisions,
  createSystemOne as defaultCreateSystemOne,
} from "~/services/copilot/create-decisions"
import {
  createImageEdit as defaultCreateImageEdit,
  createImageGeneration as defaultCreateImageGeneration,
  type ImagesResult,
} from "~/services/copilot/create-images"
import { COPILOT_PROVIDER_ID } from "~/services/copilot/upstream-request"

/** The id the built-in handlers resolve to in place of a plugin. */
export const BUILTIN_PLUGIN_ID = "core"

export interface BuiltinOperationDeps {
  createImageGeneration: typeof defaultCreateImageGeneration
  createImageEdit: typeof defaultCreateImageEdit
  createDecisions: typeof defaultCreateDecisions
  createSystemOne: typeof defaultCreateSystemOne
}

type Handler = (request: OperationRequest) => Promise<OperationResult>

/** The JSON body of an operation whose request is never a form. */
function jsonBody(body: OperationRequest["body"]): Record<string, unknown> {
  if (body instanceof FormData) {
    throw new TypeError("This operation takes a JSON body.")
  }
  return body
}

const optional = (value: number | null | undefined): number | undefined =>
  value ?? undefined

function responsesUsage(
  usage: Parameters<typeof normalizeResponsesUsage>[0],
): OperationResult["usage"] {
  const tokens = normalizeResponsesUsage(usage)
  return {
    input_tokens: optional(tokens.input_tokens),
    output_tokens: optional(tokens.output_tokens),
    cache_read_input_tokens: optional(tokens.cache_read_input_tokens),
    total_tokens: optional(tokens.total_tokens),
  }
}

function imagesResult(result: ImagesResult): OperationResult {
  const amount = extractCopilotCost(result.copilot_usage)
  return {
    json: result,
    usage: responsesUsage(result.usage),
    ...(amount === undefined ?
      {}
    : { cost: { unit: "nano_aiu", amount, estimated: false } }),
  }
}

function builtinHandlers(
  deps: BuiltinOperationDeps,
): Record<ModelOperation, Handler> {
  return {
    "images.generations": async ({ body, signal }) =>
      imagesResult(
        await deps.createImageGeneration(jsonBody(body), { signal }),
      ),
    "images.edits": async ({ body, signal }) =>
      imagesResult(await deps.createImageEdit(body, { signal })),
    decisions: async ({ body, signal }) => {
      const result = await deps.createDecisions(jsonBody(body), {
        signal,
      })
      return { json: result, usage: responsesUsage(result.usage) }
    },
    systemone: async ({ body, signal }) => {
      const result = await deps.createSystemOne(jsonBody(body), {
        signal,
      })
      return {
        json: result,
        usage: {
          input_tokens: result.usage?.input_tokens,
          output_tokens: result.usage?.output_tokens,
        },
      }
    },
  }
}

const bind = (model: string) => ({
  provider: COPILOT_PROVIDER_ID,
  upstreamModel: model,
})

const noUnsubscribe = (): void => {}

/**
 * A dispatch whose handlers call Copilot directly. It resolves every model to
 * the `copilot` provider under the name the client sent; `servedModels` is
 * empty because the built-ins serve whatever the catalog does.
 */
export function createBuiltinOperationDispatch(
  deps: Partial<BuiltinOperationDeps> = {},
): OperationDispatch {
  const handlers = builtinHandlers({
    createImageGeneration: defaultCreateImageGeneration,
    createImageEdit: defaultCreateImageEdit,
    createDecisions: defaultCreateDecisions,
    createSystemOne: defaultCreateSystemOne,
    ...deps,
  })
  return {
    resolve: (_operation, model) => ({
      pluginId: BUILTIN_PLUGIN_ID,
      binding: bind(model),
    }),
    dispatch: (request) =>
      handlers[request.operation]({ ...request, binding: bind(request.model) }),
    servedModels: () => [],
    subscribe: () => noUnsubscribe,
  }
}
