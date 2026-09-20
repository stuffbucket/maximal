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
import type { Model } from "~/services/copilot/get-models"

import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"
import { emitStreamError } from "~/routes/messages/stream-error"
import { getResponsesRequestOptions } from "~/routes/responses/utils"
import { isAsyncIterable, isNonStreaming } from "~/routes/streaming-predicates"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import { createResponses } from "~/services/copilot/create-responses"

import { type FlowBaseOptions } from "../api-flows"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "../non-stream-translation"
import { runAgentLoop } from "./agent"
import { type Executor, selectExecutor } from "./executor"
import { attachClientShims, type WebToolPolicy } from "./rewriter"
import { runStreamingAgent } from "./stream"

export interface WebToolsFlowArgs {
  c: Context
  payload: AnthropicMessagesPayload
  options: FlowBaseOptions
  policy: WebToolPolicy
  selectedModel?: Model
  executor?: Executor
}

export async function handleWithWebToolsAgent(args: WebToolsFlowArgs) {
  const { c, payload, options, policy, selectedModel } = args
  attachClientShims(payload, policy)
  const wantsStream = payload.stream === true

  const callOnce = async (
    turnPayload: AnthropicMessagesPayload,
  ): Promise<AnthropicResponse> => {
    if (selectedModel?.supported_endpoints?.includes("/responses")) {
      const responsesPayload =
        translateAnthropicMessagesToResponsesPayload(turnPayload)
      responsesPayload.stream = false
      const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
      const response = await createResponses(responsesPayload, {
        vision,
        initiator,
        requestId: options.requestId,
        sessionId: options.sessionId,
        compactType: options.compactType,
        subagentMarker: options.subagentMarker,
      })
      if (isAsyncIterable(response)) {
        throw new Error(
          "web-tools agent: expected non-streaming response from Copilot",
        )
      }
      return translateResponsesResultToAnthropic(response)
    }

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

  const executor = args.executor ?? selectExecutor()

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
    try {
      await runStreamingAgent({
        initialPayload: payload,
        policy,
        stream,
        options,
        executor,
        selectedModel,
      })
    } catch (error) {
      await emitStreamError(stream, options.logger, {
        error,
        flow: "web_tools",
      })
    }
  })
}
