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

import { streamSSE, type SSEStreamingApi } from "hono/streaming"

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
import { InProcessFetchExecutor } from "./web-tools-executor"
import { attachClientShims, type WebToolPolicy } from "./web-tools-rewriter"

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
  const executor = new InProcessFetchExecutor()
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

  const finalResponse = await runAgentLoop({
    initialPayload: payload,
    policy,
    executor,
    callOnce,
  })

  if (!wantsStream) {
    return c.json(finalResponse)
  }
  return streamSSE(c, async (stream) => {
    await emitSynthesizedStream(stream, finalResponse)
  })
}

// ────────────────────────────────────────────────────────────────────
// Stream emitter — turns a finalized AnthropicResponse into the SSE
// event sequence Anthropic clients expect. Text blocks are emitted as
// one big text_delta; tool_use / server_tool_use / web_*_tool_result
// blocks are emitted whole inside content_block_start (no deltas).
// ────────────────────────────────────────────────────────────────────

async function writeEvent(
  stream: SSEStreamingApi,
  type: string,
  data: object,
): Promise<void> {
  await stream.writeSSE({
    event: type,
    data: JSON.stringify({ type, ...data }),
  })
}

async function emitSynthesizedStream(
  stream: SSEStreamingApi,
  response: AnthropicResponse,
): Promise<void> {
  const { content, ...shell } = response

  await writeEvent(stream, "message_start", {
    message: {
      ...shell,
      content: [],
      stop_reason: null,
      stop_sequence: null,
    },
  })

  const blocks = Array.isArray(content) ? content : []
  for (const [i, block] of blocks.entries()) {
    if (block.type === "text") {
      await writeEvent(stream, "content_block_start", {
        index: i,
        content_block: { type: "text", text: "" },
      })
      if (block.text) {
        await writeEvent(stream, "content_block_delta", {
          index: i,
          delta: { type: "text_delta", text: block.text },
        })
      }
    } else {
      // Everything else is emitted whole inside content_block_start.
      // Anthropic server-side tool blocks (server_tool_use,
      // web_*_tool_result) follow this pattern; tool_use we emit whole
      // for simplicity since the model never streams partial input back
      // to itself in this synthesized path.
      await writeEvent(stream, "content_block_start", {
        index: i,
        content_block: block,
      })
    }
    await writeEvent(stream, "content_block_stop", { index: i })
  }

  await writeEvent(stream, "message_delta", {
    delta: {
      stop_reason: response.stop_reason,
      stop_sequence: response.stop_sequence,
    },
    usage: { output_tokens: response.usage.output_tokens },
  })

  await writeEvent(stream, "message_stop", {})
}
