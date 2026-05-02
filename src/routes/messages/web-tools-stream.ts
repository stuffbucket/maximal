/**
 * Streaming agent loop for web-tools (D6b).
 *
 * The non-streaming variant in web-tools-agent.ts buffers each Copilot
 * turn into a complete AnthropicResponse, runs the loop, then synthesizes
 * a single final response. This module instead streams each turn's
 * events to the client in real time, transforming the wire format on
 * the fly:
 *   - tool_use{name in web_*}  →  server_tool_use (type rewrite)
 *   - after that block ends    →  synthesized web_*_tool_result block
 *   - message_delta/stop are buffered until the loop terminates
 *
 * Block indices are remapped from per-turn (0..n) to a monotonic
 * client-facing cursor that crosses turn boundaries.
 *
 * Spec: docs/spec/web-tools.md, section "SSE event sequence".
 */

import type { ConsolaInstance } from "consola"
import type { SSEStreamingApi } from "hono/streaming"

import type { CompactType } from "~/lib/compact"
import type { SubagentMarker } from "~/lib/subagent"

import { debugLazy } from "~/lib/logger"
import {
  createChatCompletions,
  type ChatCompletionChunk,
} from "~/services/copilot/create-chat-completions"

import type {
  AnthropicAssistantContentBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicStreamEventData,
  AnthropicStreamState,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from "./anthropic-types"

import { translateToOpenAI } from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"
import {
  buildResultBlockForOutcome,
  buildToolResultMessage,
  executeToolUse,
  type ExecOutcome,
} from "./web-tools-exec"
import { type Executor } from "./web-tools-executor"
import { isWebToolName, type WebToolPolicy } from "./web-tools-rewriter"
import { newRequestState, type RequestState } from "./web-tools-state"
import { BLOCK_KIND, MAX_AGENT_TURNS, type ToolName } from "./web-tools-vocab"

interface StreamingAgentArgs {
  initialPayload: AnthropicMessagesPayload
  policy: WebToolPolicy
  stream: SSEStreamingApi
  executor: Executor
  options: {
    requestId: string
    sessionId?: string
    compactType?: CompactType
    subagentMarker?: SubagentMarker | null
    logger: ConsolaInstance
  }
}

export async function runStreamingAgent(
  args: StreamingAgentArgs,
): Promise<void> {
  const { executor } = args
  const { logger } = args.options
  const state = newRequestState(args.policy.declarations)
  const messages: Array<AnthropicMessage> = [...args.initialPayload.messages]

  // Cursor for client-facing block indices, monotonic across turns.
  const cursor = { next: 0 }
  let messageStartEmitted = false
  let bufferedFinalEvents: Array<AnthropicStreamEventData> = []

  debugLazy(logger, () => [
    "web-tools stream start",
    JSON.stringify({
      decls: args.policy.declarations.map((d) => d.name),
      max_turns: MAX_AGENT_TURNS,
    }),
  ])

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    debugLazy(logger, () => [
      "web-tools stream turn",
      JSON.stringify({ turn, msgs: messages.length }),
    ])
    const turnPayload: AnthropicMessagesPayload = {
      ...args.initialPayload,
      messages,
      stream: true,
    }

    const turnResult = await runOneStreamingTurn({
      payload: turnPayload,
      options: args.options,
      stream: args.stream,
      cursor,
      messageStartEmitted,
      executor,
      state,
    })
    messageStartEmitted = turnResult.messageStartEmitted
    bufferedFinalEvents = turnResult.bufferedFinal

    if (
      turnResult.stopReason === "tool_use"
      && turnResult.outcomes.length > 0
    ) {
      messages.push(
        { role: "assistant", content: turnResult.assistantContent },
        {
          role: "user",
          content: buildToolResultsMessageContent(turnResult.outcomes),
        },
      )
      continue
    }
    debugLazy(logger, () => [
      "web-tools stream done",
      JSON.stringify({ turns: turn + 1, stop_reason: turnResult.stopReason }),
    ])
    break
  }

  // Emit the buffered terminal events from the last turn.
  for (const ev of bufferedFinalEvents) {
    await writeEvent(args.stream, ev)
  }
}

// ────────────────────────────────────────────────────────────────────
// One streaming turn: Copilot stream → Anthropic events → client (with
// rewriting + execution-on-demand).
// ────────────────────────────────────────────────────────────────────

interface TurnResult {
  stopReason: string | null
  assistantContent: Array<AnthropicAssistantContentBlock>
  outcomes: Array<{ toolUse: AnthropicToolUseBlock; outcome: ExecOutcome }>
  /** message_delta + message_stop captured but NOT yet forwarded; the
   *  caller forwards them only on the final turn. */
  bufferedFinal: Array<AnthropicStreamEventData>
  /** Whether this turn produced a message_start event (so the next
   *  turn knows to suppress its own message_start). */
  messageStartEmitted: boolean
}

interface TurnArgs {
  payload: AnthropicMessagesPayload
  options: StreamingAgentArgs["options"]
  stream: SSEStreamingApi
  cursor: { next: number }
  messageStartEmitted: boolean
  executor: Executor
  state: RequestState
}

interface OpenBlock {
  /** Index assigned to the client. */
  clientIndex: number
  /** Whether this is one of our web tools (we'll execute on stop). */
  isWebTool: boolean
  /** For web-tool blocks: accumulated input_json_delta payload. */
  partialJson: string
  /** Block metadata captured at start, used for execution + accumulator. */
  toolUse?: { id: string; name: ToolName }
  /** Accumulated text/thinking content for non-tool blocks. */
  text: string
  thinking: string
  blockKind: "text" | "tool_use" | "thinking" | "other"
}

async function runOneStreamingTurn(args: TurnArgs): Promise<TurnResult> {
  const openAIPayload = translateToOpenAI(args.payload)
  openAIPayload.stream = true

  const response = await createChatCompletions(openAIPayload, {
    requestId: args.options.requestId,
    sessionId: args.options.sessionId,
    compactType: args.options.compactType,
    subagentMarker: args.options.subagentMarker,
  })

  // Defensive: createChatCompletions might return non-streaming if
  // upstream ignores stream=true. We'd need to handle that; for now
  // throw so we notice.
  if (Object.hasOwn(response, "choices")) {
    throw new Error(
      "web-tools stream: upstream returned non-streaming response despite stream=true",
    )
  }

  const innerState: AnthropicStreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
    thinkingBlockOpen: false,
  }

  const upstreamToClient = new Map<number, OpenBlock>()
  const outcomes: Array<{
    toolUse: AnthropicToolUseBlock
    outcome: ExecOutcome
  }> = []
  const assistantContent: Array<AnthropicAssistantContentBlock> = []
  const bufferedFinal: Array<AnthropicStreamEventData> = []
  let stopReason: string | null = null
  let messageStartEmitted = args.messageStartEmitted

  for await (const rawEvent of response as AsyncIterable<{ data?: string }>) {
    if (rawEvent.data === "[DONE]") break
    if (!rawEvent.data) continue

    const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
    const events = translateChunkToAnthropicEvents(chunk, innerState)

    for (const event of events) {
      const dispatched = await dispatchEvent({
        event,
        upstreamToClient,
        cursor: args.cursor,
        messageStartEmitted,
        stream: args.stream,
        executor: args.executor,
        state: args.state,
        outcomes,
        assistantContent,
        bufferedFinal,
        logger: args.options.logger,
      })
      if (dispatched.stopReason !== undefined)
        stopReason = dispatched.stopReason
      if (event.type === "message_start") messageStartEmitted = true
    }
  }

  return {
    stopReason,
    assistantContent,
    outcomes,
    bufferedFinal,
    messageStartEmitted,
  }
}

// ────────────────────────────────────────────────────────────────────
// Dispatch one Anthropic event: remap, rewrite, forward, execute.
// ────────────────────────────────────────────────────────────────────

interface DispatchArgs {
  event: AnthropicStreamEventData
  upstreamToClient: Map<number, OpenBlock>
  cursor: { next: number }
  messageStartEmitted: boolean
  stream: SSEStreamingApi
  executor: Executor
  state: RequestState
  outcomes: Array<{ toolUse: AnthropicToolUseBlock; outcome: ExecOutcome }>
  assistantContent: Array<AnthropicAssistantContentBlock>
  bufferedFinal: Array<AnthropicStreamEventData>
  logger: ConsolaInstance
}

async function dispatchEvent(
  d: DispatchArgs,
): Promise<{ stopReason?: string | null }> {
  const ev = d.event
  switch (ev.type) {
    case "message_start": {
      if (!d.messageStartEmitted) await writeEvent(d.stream, ev)
      return {}
    }
    case "content_block_start": {
      await handleBlockStart(d, ev)
      return {}
    }
    case "content_block_delta": {
      await handleBlockDelta(d, ev)
      return {}
    }
    case "content_block_stop": {
      await handleBlockStop(d, ev)
      return {}
    }
    case "message_delta": {
      d.bufferedFinal.push(ev)
      return { stopReason: ev.delta.stop_reason ?? null }
    }
    case "message_stop": {
      d.bufferedFinal.push(ev)
      return {}
    }
    case "ping":
    case "error": {
      await writeEvent(d.stream, ev)
      return {}
    }
    default: {
      return {}
    }
  }
}

function classifyBlock(block: { type: string }): OpenBlock["blockKind"] {
  if (block.type === "tool_use") return "tool_use"
  if (block.type === "text") return "text"
  if (block.type === "thinking") return "thinking"
  return "other"
}

function parseToolInput(partialJson: string): Record<string, unknown> {
  if (!partialJson) return {}
  try {
    const parsed: unknown = JSON.parse(partialJson)
    if (
      typeof parsed === "object"
      && parsed !== null
      && !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

async function handleBlockStart(
  d: DispatchArgs,
  ev: Extract<AnthropicStreamEventData, { type: "content_block_start" }>,
): Promise<void> {
  const clientIndex = d.cursor.next++
  const block = ev.content_block

  // Narrow once: `isToolUse` puts `name` and `id` in scope below.
  const isToolUse = block.type === "tool_use"
  const isWebTool = isToolUse && isWebToolName(block.name)

  const open: OpenBlock = {
    clientIndex,
    isWebTool,
    partialJson: "",
    text: "",
    thinking: "",
    blockKind: classifyBlock(block),
    ...(isWebTool ?
      { toolUse: { id: block.id, name: block.name as ToolName } }
    : {}),
  }
  d.upstreamToClient.set(ev.index, open)

  // Rewrite type for our web tools: tool_use → server_tool_use. Wire
  // shape: id, name, input — identical to tool_use. The existing typed
  // event union doesn't model server_tool_use, so we write the rewritten
  // JSON directly to the SSE stream.
  if (isWebTool) {
    const rewritten = {
      type: "content_block_start",
      index: clientIndex,
      content_block: {
        type: BLOCK_KIND.serverToolUse,
        id: block.id,
        name: block.name,
        input: block.input,
      },
    }
    await d.stream.writeSSE({
      event: "content_block_start",
      data: JSON.stringify(rewritten),
    })
    return
  }
  await writeEvent(d.stream, { ...ev, index: clientIndex })
}

async function handleBlockDelta(
  d: DispatchArgs,
  ev: Extract<AnthropicStreamEventData, { type: "content_block_delta" }>,
): Promise<void> {
  const open = d.upstreamToClient.get(ev.index)
  if (!open) return
  const remapped = { ...ev, index: open.clientIndex }
  if (ev.delta.type === "input_json_delta" && open.isWebTool) {
    open.partialJson += ev.delta.partial_json
  } else if (ev.delta.type === "text_delta" && open.blockKind === "text") {
    open.text += ev.delta.text
  } else if (
    ev.delta.type === "thinking_delta"
    && open.blockKind === "thinking"
  ) {
    open.thinking += ev.delta.thinking
  }
  await writeEvent(d.stream, remapped)
}

async function handleBlockStop(
  d: DispatchArgs,
  ev: Extract<AnthropicStreamEventData, { type: "content_block_stop" }>,
): Promise<void> {
  const open = d.upstreamToClient.get(ev.index)
  if (!open) return
  await writeEvent(d.stream, {
    type: "content_block_stop",
    index: open.clientIndex,
  })
  d.upstreamToClient.delete(ev.index)

  // Build assistant-content entry for the loop's next-turn message.
  if (open.blockKind === "text") {
    d.assistantContent.push({ type: "text", text: open.text })
  } else if (open.blockKind === "thinking") {
    // The accumulator can't synthesize a signature; on next turn
    // Copilot would reject thinking blocks without one. Skip.
  } else if (open.blockKind === "tool_use" && open.toolUse) {
    const input = parseToolInput(open.partialJson)
    const toolUseBlock: AnthropicToolUseBlock = {
      type: "tool_use",
      id: open.toolUse.id,
      name: open.toolUse.name,
      input,
    }
    d.assistantContent.push(toolUseBlock)

    if (open.isWebTool && isWebToolName(toolUseBlock.name)) {
      // Execute, emit synthesized result block at the next cursor. The
      // isWebToolName guard narrows `name` to ToolName for the call.
      const narrowed = toolUseBlock as AnthropicToolUseBlock & {
        name: ToolName
      }
      const t0 = Date.now()
      const outcome = await executeToolUse(narrowed, d.executor, d.state)
      const ms = Date.now() - t0
      debugLazy(d.logger, () => [
        "web-tools outcome",
        JSON.stringify({
          tool: toolUseBlock.name,
          id: toolUseBlock.id,
          ok: outcome.ok,
          ...(outcome.ok ? {} : { code: outcome.code }),
          ms,
        }),
      ])
      d.outcomes.push({ toolUse: toolUseBlock, outcome })

      const resultIndex = d.cursor.next++
      const resultBlock = buildResultBlockForOutcome(toolUseBlock.id, outcome)

      await writeEvent(d.stream, {
        type: "content_block_start",
        index: resultIndex,
        content_block: resultBlock as unknown as Extract<
          AnthropicStreamEventData,
          { type: "content_block_start" }
        >["content_block"],
      })
      await writeEvent(d.stream, {
        type: "content_block_stop",
        index: resultIndex,
      })
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// Helpers shared with web-tools-agent.ts.
// ────────────────────────────────────────────────────────────────────

function buildToolResultsMessageContent(
  outcomes: Array<{ toolUse: AnthropicToolUseBlock; outcome: ExecOutcome }>,
): Array<AnthropicToolResultBlock> {
  return outcomes.map(({ toolUse, outcome }) =>
    buildToolResultMessage(toolUse.id, outcome),
  )
}

async function writeEvent(
  stream: SSEStreamingApi,
  event: AnthropicStreamEventData,
): Promise<void> {
  await stream.writeSSE({
    event: event.type,
    data: JSON.stringify(event),
  })
}

// Re-exports for the flow integration site.
