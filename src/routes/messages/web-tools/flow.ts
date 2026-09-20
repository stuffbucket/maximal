/**
 * Hono entry point that routes a web-tools-bearing /v1/messages
 * request through the agent loop (streaming or non-streaming).
 */

import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/lib/models/anthropic-types"

import { isNonStreaming } from "~/routes/streaming-predicates"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"

import { type FlowBaseOptions } from "../api-flows"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "../non-stream-translation"
import { runAgentLoop } from "./agent"
import { selectExecutor } from "./executor"
import { attachClientShims, type WebToolPolicy } from "./rewriter"
import { runStreamingAgent } from "./stream"

export interface WebToolsFlowArgs {
  c: Context
  payload: AnthropicMessagesPayload
  options: FlowBaseOptions
  policy: WebToolPolicy
}

export async function handleWithWebToolsAgent(args: WebToolsFlowArgs) {
  const { c, payload, options, policy } = args
  attachClientShims(payload, policy)
  const wantsStream = payload.stream === true

  const callOnce = async (
    turnPayload: AnthropicMessagesPayload,
  ): Promise<AnthropicResponse> => {
    const openAIPayload = translateToOpenAI(turnPayload)
    openAIPayload.stream = false
    const response = await createChatCompletions(openAIPayload, {
      requestId: options.requestId,
      sessionId: options.sessionId,
      compactType: options.compactType,
      subagentMarker: options.subagentMarker,
    })
    if (!isNonStreaming(response)) {
      throw new Error(
        "web-tools agent: expected non-streaming response from Copilot",
      )
    }
    return translateToAnthropic(response)
  }

  const executor = selectExecutor()

  if (!wantsStream) {
    const finalResponse = await runAgentLoop({
      initialPayload: payload,
      policy,
      executor,
      callOnce,
      logger: options.logger,
    })
    return c.json(finalResponse)
  }

  // Streaming path — true streaming during agent execution. Each
  // Copilot inner call streams; client sees text + server_tool_use +
  // result blocks as they happen, not buffered to the end.
  return streamSSE(c, async (stream) => {
    await runStreamingAgent({
      initialPayload: payload,
      policy,
      stream,
      options,
      executor,
    })
  })
}
