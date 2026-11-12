/**
 * Hono entry point that routes a web-tools-bearing /v1/messages
 * request through the agent loop (streaming or non-streaming).
 */

import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"
import type { UsageTokens } from "~/lib/token-usage"
import type { Model } from "~/services/copilot/get-models"

import { emitStreamError } from "~/routes/messages/stream-error"

import type { ServerToolPlan } from "../server-tools/types"

import { type FlowBaseOptions } from "../api-flows"
import { applyServerToolDeclarations } from "../server-tools/plan"
import { runAgentLoop } from "./agent"
import { type Executor, selectExecutor } from "./executor"
import { planWebTools } from "./listings"
import { type WebToolPolicy } from "./rewriter"
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
  /** The server tools this request offers, from `planServerTools`. Absent:
   *  the web tools `policy` declares. */
  serverTools?: ServerToolPlan
  /** Told the request's total usage once the loop finished. Web-tools
   *  requests leave it out and record nothing here, as before. */
  recordUsage?: (usage: UsageTokens) => void
  /** Which transports this request may use. Omitted: today's web-tools
   *  choice (`/responses` or chat completions), see {@link TransportPolicy}. */
  transportPolicy?: TransportPolicy
  /** Upstream-call seam; production omits it and gets the real calls. */
  deps?: Partial<WebToolsUpstreamDeps>
}

export async function handleWithWebToolsAgent(args: WebToolsFlowArgs) {
  const { c, payload, options, policy, selectedModel } = args
  const executor = args.executor ?? selectExecutor()
  const serverTools =
    args.serverTools ?? planWebTools({ payload, policy, executor })
  applyServerToolDeclarations(payload, serverTools)
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

  if (!wantsStream) {
    try {
      const finalResponse = await runAgentLoop({
        initialPayload: payload,
        policy,
        executor,
        callOnce: buildCallOnce(upstream),
        logger: options.logger,
        serverTools,
        recordUsage: args.recordUsage,
      })
      return c.json(finalResponse)
    } finally {
      serverTools.release()
    }
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
        serverTools,
        recordUsage: args.recordUsage,
      })
    } catch (error) {
      await emitStreamError(stream, options.logger, {
        error,
        flow: "web_tools",
      })
    } finally {
      serverTools.release()
    }
  })
}
