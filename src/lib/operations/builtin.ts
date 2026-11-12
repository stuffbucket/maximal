/**
 * The core's built-in operation handlers: Copilot's image endpoints
 * (`/v1/images/*`), as an `OperationDispatch` the image routes use until a
 * plugin serves them. (Decisions and SystemOne moved into capability plugins.)
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

import {
  type ModelOperation,
  type OperationDispatch,
  type OperationRequest,
  OperationUnavailableError,
  type OperationResult,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import { extractCopilotCost, normalizeResponsesUsage } from "~/lib/token-usage"
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
): Partial<Record<ModelOperation, Handler>> {
  return {
    "images.generations": async ({ body, signal }) =>
      imagesResult(
        await deps.createImageGeneration(jsonBody(body), { signal }),
      ),
    "images.edits": async ({ body, signal }) =>
      imagesResult(await deps.createImageEdit(body, { signal })),
  }
}

const bind = (model: string) => ({
  provider: COPILOT_PROVIDER_ID,
  upstreamModel: model,
})

const noUnsubscribe = (): void => {}

/**
 * A dispatch whose handlers call Copilot directly. For the operations it has
 * (images) it resolves every model to the `copilot` provider under the name
 * the client sent; `servedModels` is empty because the built-ins serve
 * whatever the catalog does.
 */
export function createBuiltinOperationDispatch(
  deps: Partial<BuiltinOperationDeps> = {},
): OperationDispatch {
  const handlers = builtinHandlers({
    createImageGeneration: defaultCreateImageGeneration,
    createImageEdit: defaultCreateImageEdit,
    ...deps,
  })
  return {
    resolve: (operation, model) =>
      handlers[operation] ?
        { pluginId: BUILTIN_PLUGIN_ID, binding: bind(model) }
      : undefined,
    dispatch: (request) => {
      const handler = handlers[request.operation]
      if (!handler) {
        return Promise.reject(
          new OperationUnavailableError(request.operation, request.model),
        )
      }
      return handler({ ...request, binding: bind(request.model) })
    },
    servedModels: () => [],
    subscribe: () => noUnsubscribe,
  }
}
