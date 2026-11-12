/**
 * Hono entry point that routes a web-tools-bearing /v1/messages
 * request through the agent loop (streaming or non-streaming).
 */

import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"
import type { Model } from "~/services/copilot/get-models"

import { emitStreamError } from "~/routes/messages/stream-error"

import { type FlowBaseOptions } from "../api-flows"
import { runAgentLoop } from "./agent"
import { type Executor, selectExecutor } from "./executor"
import { attachClientShims, type WebToolPolicy } from "./rewriter"
import { runStreamingAgent } from "./stream"
import {
  buildCallOnce,
  prepareNativeMessagesPayload,
  buildTurnUpstream,
  selectTurnTransport,
  type TransportPolicy,
  type WebToolsUpstreamDeps,
} from "./transport"

export interface WebToolsFlowArgs {
  c: Context
  payload: AnthropicMessagesPayload
  options: FlowBaseOptions
  policy: WebToolPolicy
  /** Catalog entry for the resolved model; picks each turn's transport. */
  selectedModel?: Model
  executor?: Executor
  /** Which transports this request may use. Omitted: today's web-tools
   *  choice (`/responses` or chat completions), see {@link TransportPolicy}. */
  transportPolicy?: TransportPolicy
  /** Upstream-call seam; production omits it and gets the real calls. */
  deps?: Partial<WebToolsUpstreamDeps>
}

export async function handleWithWebToolsAgent(args: WebToolsFlowArgs) {
  const { c, payload, options, policy, selectedModel } = args
  attachClientShims(payload, policy)
  const wantsStream = payload.stream === true

  const transport = selectTurnTransport(selectedModel, args.transportPolicy)
  if (transport === "messages") {
    prepareNativeMessagesPayload(payload, selectedModel)
  }
  const upstream = buildTurnUpstream({
    transport,
    options,
    // Only the `messages` transport sends it, filtered as on the Messages flow.
    anthropicBetaHeader: c.req.header("anthropic-beta"),
    deps: args.deps,
  })

  const executor = args.executor ?? selectExecutor()

  if (!wantsStream) {
    const finalResponse = await runAgentLoop({
      initialPayload: payload,
      policy,
      executor,
      callOnce: buildCallOnce(upstream),
      logger: options.logger,
    })
    return c.json(finalResponse)
  }

  // Streaming path — true streaming during agent execution. Each
  // Copilot inner call streams; client sees text + server_tool_use +
  // result blocks as they happen, not buffered to the end.
  return streamSSE(c, async (stream) => {
    try {
      await runStreamingAgent({
        initialPayload: payload,
        policy,
        stream,
        options,
        executor,
        transport,
        deps: upstream.deps,
        anthropicBetaHeader: upstream.anthropicBetaHeader,
      })
    } catch (error) {
      await emitStreamError(stream, options.logger, {
        error,
        flow: "web_tools",
      })
    }
  })
}
