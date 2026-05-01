/**
 * Hono integration for the web-tools agent loop.
 *
 * Bridges between caozhiyuan's existing handler dispatch and the
 * agent-loop core in web-tools-agent.ts. Provides one entry point
 * (handleWithWebToolsAgent) that handler.ts calls when the incoming
 * payload declares any Anthropic-server-side web tools.
 *
 * Spec: docs/spec/web-tools.md
 */

import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import {
  createChatCompletions,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "./anthropic-types"
import type { FlowBaseOptions } from "./api-flows"

import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { runAgentLoop } from "./web-tools-agent"
import { selectExecutor } from "./web-tools-executor"
import { attachClientShims, type WebToolPolicy } from "./web-tools-rewriter"
import { runStreamingAgent } from "./web-tools-stream"

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

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
