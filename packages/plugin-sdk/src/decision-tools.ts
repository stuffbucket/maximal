/**
 * Helpers for capability plugins that also offer their model to Claude as a
 * hidden server tool (`decide`, `classify`): the tool is registered only
 * while some binding's provider is signed in and offers the model, and a call
 * goes through that binding's provider.
 */
import type { Context } from "@deepseek-ai/cordis"

import type { ModelBinding, ModelOperation } from "./operations"
import type { UpstreamProvider } from "./providers"
import type { ServerToolCall, ServerToolDefinition } from "./server-tools"
import type { ToolResult } from "./types"

import { withUpstreamModel } from "./relay"

export const textResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
})

export const errorResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
})

/** The first binding whose provider is registered, signed in and offers its model. */
export function availableBinding(
  ctx: Context,
  bindings: ReadonlyArray<ModelBinding & { model: string }>,
):
  | {
      binding: ModelBinding & { model: string }
      provider: UpstreamProvider
    }
  | undefined {
  for (const binding of bindings) {
    const provider = ctx.providers.get(binding.provider)
    if (provider?.available() && provider.model(binding.upstreamModel)) {
      return { binding, provider }
    }
  }
  return undefined
}

/**
 * Keep one server tool registered exactly while a binding is available.
 * `sync()` re-checks (call it at start and on every catalog change). The
 * registration is also withdrawn with the plugin's fiber.
 */
export function serverToolWhileAvailable(
  ctx: Context,
  bindings: ReadonlyArray<ModelBinding & { model: string }>,
  definition: ServerToolDefinition,
): { sync(): void } {
  let registration: (() => void) | undefined
  return {
    sync() {
      const available = availableBinding(ctx, bindings) !== undefined
      if (available && !registration) {
        registration = ctx.serverTools.register(definition)
      } else if (!available && registration) {
        registration()
        registration = undefined
      }
    },
  }
}

/**
 * Send `body` to `path` through the first available binding's provider, under
 * the provider's own model id. Returns the reply, or an `isError` result
 * saying why not. A call the client abandoned rethrows its abort.
 */
export async function callBoundModel(
  ctx: Context,
  bindings: ReadonlyArray<ModelBinding & { model: string }>,
  spec: {
    path: string
    errorMessage: string
    body: Record<string, unknown>
    operation: ModelOperation
    call: ServerToolCall
  },
): Promise<{ reply: Record<string, unknown> } | { error: ToolResult }> {
  const served = availableBinding(ctx, bindings)
  if (!served) {
    return {
      error: errorResult("The decision model isn't available right now."),
    }
  }
  try {
    const invocation = spec.call.nextProviderCall(
      spec.operation,
      served.binding.upstreamModel,
    )
    const reply = await served.provider.postJson<Record<string, unknown>>(
      spec.path,
      withUpstreamModel(spec.body, served.binding.upstreamModel),
      {
        signal: spec.call.signal,
        errorMessage: spec.errorMessage,
        invocation,
      },
    )
    const cost = served.provider.cost(reply, {
      operation: spec.operation,
      model: served.binding.upstreamModel,
    })
    spec.call.reportSpend?.({
      invocationId: invocation.invocationId,
      providerCallId: invocation.providerCallId,
      sequence: invocation.sequence,
      operation: spec.operation,
      model: served.binding.model,
      provider: served.binding.provider,
      result: { usage: {}, ...(cost === undefined ? {} : { cost }) },
    })
    return { reply }
  } catch (error) {
    if (spec.call.signal.aborted) throw error
    const reason = error instanceof Error ? error.message : String(error)
    return { error: errorResult(`${spec.errorMessage}: ${reason}`) }
  }
}
