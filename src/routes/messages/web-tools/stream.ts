/**
 * Streaming agent loop for web-tools.
 *
 * Each Copilot inner call streams; events transform on the fly:
 *   tool_use{planned tool, anthropic-* render} →  server_tool_use (type rewrite)
 *   after that block ends                      →  synthesized web_*_tool_result
 *   tool_use{planned tool, hidden render}      →  swallowed: start, deltas,
 *                                                 stop, and no result block
 *   message_delta/stop                         →  buffered until the loop
 *                                                 terminates
 *
 * Block indices remap from per-turn (0..n) to a monotonic client-facing
 * cursor that crosses turn boundaries.
 *
 * Index-bookkeeping discipline (cribbed from ollama/ollama
 * middleware/anthropic.go's WebSearchAnthropicWriter):
 *   - Track open block via (clientIndex, isWebTool) per upstream index
 *   - A hidden call takes no client index, so the client's indices stay
 *     contiguous
 *   - Synthesized result blocks emit at the next free client cursor,
 *     start-then-stop with the full block as the start payload
 *     (no input_json_delta — Anthropic SSE emits these whole)
 *   - On followup turns, the per-turn upstream index resets to 0 but
 *     the client cursor must keep climbing
 *   - message_delta / message_stop on intermediate turns are swallowed;
 *     only the final turn's terminals reach the client (but every turn's
 *     usage is summed into that final message_delta — each turn is a
 *     separately-billed upstream call)
 *   - while a gap produces no content (tool execution, the next upstream
 *     turn's round-trip) periodic `ping` events keep the stream visibly alive
 */

import type { ConsolaInstance } from "consola"
import type { SSEStreamingApi } from "hono/streaming"

import type {
  AnthropicAssistantContentBlock,
  AnthropicMessage,
  AnthropicMessageDeltaEvent,
  AnthropicMessagesPayload,
  AnthropicStreamEventData,
  AnthropicStreamState,
  AnthropicToolUseBlock,
} from "~/lib/models/anthropic-types"
import type { CompactType } from "~/lib/models/compact"
import type { SubagentMarker } from "~/lib/runtime-state/subagent"

import { debugLazy } from "~/lib/platform/logger"
import { normalizeAnthropicUsage, type UsageTokens } from "~/lib/token-usage"
import {
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import { translateAnthropicMessagesToResponsesPayload } from "~/routes/messages/responses-translation"
import { getResponsesRequestOptions } from "~/routes/responses/utils"
import { isAsyncIterable, isNonStreaming } from "~/routes/streaming-predicates"

import type {
  PlannedServerTool,
  ServerToolPlan,
  ServerToolRun,
} from "../server-tools/types"

import { translateToOpenAI } from "../non-stream-translation"
import { translateChunkToAnthropicEvents } from "../stream-translation"
import { type Executor } from "./executor"
import { planWebTools } from "./listings"
import { type WebToolPolicy } from "./rewriter"
import {
  buildTurnUpstream,
  type TurnTransport,
  type TurnUpstream,
  type WebToolsUpstreamDeps,
} from "./transport"
import { BLOCK_KIND, MAX_AGENT_TURNS } from "./vocab"

/** The upstream chat-completions function. Exported so tests can
 *  type their stub without `as unknown as ...` casts. */
export type UpstreamCall = WebToolsUpstreamDeps["createChatCompletions"]

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
  /** How each turn reaches Copilot (`./transport`). Defaults to `chat`. */
  transport?: TurnTransport
  /** Upstream-call seam; missing entries are the real Copilot calls. Pass
   *  stubs to drive synthetic upstream streams. */
  deps?: Partial<WebToolsUpstreamDeps>
  /** The client's `anthropic-beta`, sent only by the `messages` transport. */
  anthropicBetaHeader?: string
  /** Keepalive-ping interval for silent gaps (tool execution, next upstream
   *  turn). Test seam; defaults to {@link HEARTBEAT_INTERVAL_MS}. */
  heartbeatIntervalMs?: number
  /** The server tools this request offers. Absent: the web tools `policy`
   *  declares, run by `executor`. */
  serverTools?: ServerToolPlan
  /** Told the whole request's usage once, when the stream finished. Absent
   *  for web-tools requests, which have never recorded it here. */
  recordUsage?: (usage: UsageTokens) => void
}

export async function runStreamingAgent(
  args: StreamingAgentArgs,
): Promise<void> {
  const { logger } = args.options
  const plan =
    args.serverTools
    ?? planWebTools({
      payload: args.initialPayload,
      policy: args.policy,
      executor: args.executor,
    })
  const messages: Array<AnthropicMessage> = [...args.initialPayload.messages]

  // Cursor for client-facing block indices, monotonic across turns.
  const cursor = { next: 0 }
  let messageStartEmitted = false
  let bufferedFinalEvents: Array<AnthropicStreamEventData> = []
  let lastTurn: TurnResult | undefined
  // Every intermediate turn is a real, separately-billed Copilot call. Only
  // the last turn's terminal events reach the client, so its lone usage count
  // would under-report the whole request. Sum every turn's usage and stamp the
  // total onto the terminal message_delta before it goes out.
  const usageTotal: DeltaUsage = { input_tokens: 0, output_tokens: 0 }
  const heartbeatIntervalMs = args.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
  const upstream = buildTurnUpstream({
    transport: args.transport,
    options: args.options,
    anthropicBetaHeader: args.anthropicBetaHeader,
    deps: args.deps,
  })

  debugLazy(logger, () => [
    "web-tools stream start",
    JSON.stringify({
      decls: [...plan.tools.keys()],
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
      plan,
      upstream,
      heartbeatIntervalMs,
    })
    lastTurn = turnResult
    messageStartEmitted = turnResult.messageStartEmitted
    bufferedFinalEvents = turnResult.bufferedFinal
    accumulateTurnUsage(usageTotal, turnResult.bufferedFinal)

    // A turn that also called a client tool goes back to the client as it
    // stands: only the client has that tool's result. Our own calls ran
    // already and the client saw what their render shows.
    if (
      turnResult.stopReason === "tool_use"
      && turnResult.outcomes.length > 0
      && !turnResult.callsClientTool
    ) {
      const toolResults = turnResult.outcomes.map(({ run }) => run.toolResult)
      messages.push(
        { role: "assistant", content: turnResult.assistantContent },
        { role: "user", content: toolResults },
      )
      continue
    }
    debugLazy(logger, () => [
      "web-tools stream done",
      JSON.stringify({ turns: turn + 1, stop_reason: turnResult.stopReason }),
    ])
    break
  }

  // The loop ran out of turns while the model was still calling only hidden
  // tools: no tool call is left for the client to answer.
  const endedOnHiddenCalls =
    lastTurn !== undefined
    && lastTurn.stopReason === "tool_use"
    && lastTurn.outcomes.length > 0
    && !lastTurn.callsClientTool
    && lastTurn.outcomes.every(({ run }) => run.clientBlock === undefined)

  // Emit the buffered terminal events from the last turn, stamping the summed
  // cross-turn usage onto the final message_delta so the client bills for every
  // turn, not just the last one.
  for (const ev of bufferedFinalEvents) {
    if (ev.type === "message_delta") {
      ev.usage = usageTotal
      if (endedOnHiddenCalls) ev.delta.stop_reason = "end_turn"
    }
    await writeEvent(args.stream, ev)
  }
  args.recordUsage?.(normalizeAnthropicUsage(usageTotal))
}

/**
 * Fold one turn's terminal `message_delta.usage` into the running total. Each
 * agent turn is a separately-billed upstream call; summing keeps the single
 * client-facing usage report honest. Missing fields default to 0; optional
 * cache counts are only surfaced once a turn actually reports them.
 */
function accumulateTurnUsage(
  total: NonNullable<AnthropicMessageDeltaEvent["usage"]>,
  turnEvents: Array<AnthropicStreamEventData>,
): void {
  for (const ev of turnEvents) {
    if (ev.type !== "message_delta" || !ev.usage) continue
    const u = ev.usage
    total.input_tokens = (total.input_tokens ?? 0) + (u.input_tokens ?? 0)
    total.output_tokens += u.output_tokens
    if (u.cache_read_input_tokens !== undefined) {
      total.cache_read_input_tokens =
        (total.cache_read_input_tokens ?? 0) + u.cache_read_input_tokens
    }
    if (u.cache_creation_input_tokens !== undefined) {
      total.cache_creation_input_tokens =
        (total.cache_creation_input_tokens ?? 0) + u.cache_creation_input_tokens
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// One streaming turn: Copilot stream → Anthropic events → client (with
// rewriting + execution-on-demand).
// ────────────────────────────────────────────────────────────────────

interface TurnResult {
  stopReason: string | null
  assistantContent: Array<AnthropicAssistantContentBlock>
  outcomes: Array<TurnOutcome>
  /** The model also called a tool that is the client's. */
  callsClientTool: boolean
  /** message_delta + message_stop captured but NOT yet forwarded; the
   *  caller forwards them only on the final turn. */
  bufferedFinal: Array<AnthropicStreamEventData>
  /** Whether this turn produced a message_start event (so the next
   *  turn knows to suppress its own message_start). */
  messageStartEmitted: boolean
}

interface TurnOutcome {
  toolUse: AnthropicToolUseBlock
  run: ServerToolRun
}

interface TurnArgs {
  payload: AnthropicMessagesPayload
  options: StreamingAgentArgs["options"]
  stream: SSEStreamingApi
  cursor: { next: number }
  messageStartEmitted: boolean
  plan: ServerToolPlan
  upstream: TurnUpstream
  heartbeatIntervalMs: number
}

interface OpenBlock {
  /** Index assigned to the client; -1 for a hidden call, which has none. */
  clientIndex: number
  /** The planned server tool this block calls, when it is one of ours
   *  (we'll execute on stop). */
  serverTool?: PlannedServerTool
  /** For server-tool blocks: accumulated input_json_delta payload. */
  partialJson: string
  /** Block metadata captured at start, used for execution + accumulator. */
  toolUse?: { id: string; name: string }
  /** Accumulated text/thinking content for non-tool blocks. */
  text: string
  thinking: string
  /** Accumulated `signature_delta` for a thinking block. */
  signature: string
  /** The block as `content_block_start` opened it (kept for blocks that are
   *  replayed whole, e.g. `redacted_thinking`). */
  startBlock: { type: string }
  blockKind: "text" | "tool_use" | "thinking" | "other"
}

async function runOneStreamingTurn(args: TurnArgs): Promise<TurnResult> {
  const upstreamToClient = new Map<number, OpenBlock>()
  const outcomes: Array<TurnOutcome> = []
  const assistantContent: Array<AnthropicAssistantContentBlock> = []
  const bufferedFinal: Array<AnthropicStreamEventData> = []
  let stopReason: string | null = null
  const calls = { client: false }
  let messageStartEmitted = args.messageStartEmitted

  for await (const event of createTurnEventStream(args)) {
    const dispatched = await dispatchEvent({
      event,
      upstreamToClient,
      cursor: args.cursor,
      messageStartEmitted,
      stream: args.stream,
      plan: args.plan,
      calls,
      outcomes,
      assistantContent,
      bufferedFinal,
      logger: args.options.logger,
      heartbeatIntervalMs: args.heartbeatIntervalMs,
      replaysThinking: args.upstream.transport === "messages",
    })
    if (dispatched.stopReason !== undefined) {
      stopReason = dispatched.stopReason
    }
    if (event.type === "message_start") messageStartEmitted = true
  }

  return {
    stopReason,
    assistantContent,
    outcomes,
    callsClientTool: calls.client,
    bufferedFinal,
    messageStartEmitted,
  }
}

async function* createTurnEventStream(
  args: TurnArgs,
): AsyncGenerator<AnthropicStreamEventData> {
  switch (args.upstream.transport) {
    case "messages": {
      yield* createMessagesTurnEventStream(args)
      return
    }
    case "responses": {
      yield* createResponsesTurnEventStream(args)
      return
    }
    default: {
      yield* createChatTurnEventStream(args)
    }
  }
}

async function* createChatTurnEventStream(
  args: TurnArgs,
): AsyncGenerator<AnthropicStreamEventData> {
  const openAIPayload = translateToOpenAI(args.payload)
  openAIPayload.stream = true
  const response = await withHeartbeat(
    {
      stream: args.stream,
      messageStartEmitted: args.messageStartEmitted,
      intervalMs: args.heartbeatIntervalMs,
    },
    () =>
      args.upstream.deps.createChatCompletions(
        openAIPayload,
        args.upstream.callOptions,
      ),
  )

  if (isNonStreaming(response)) {
    throw new Error(
      "web-tools stream: upstream returned non-streaming response despite stream=true",
    )
  }

  const streamState: AnthropicStreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
    thinkingBlockOpen: false,
  }

  for await (const rawEvent of response as AsyncIterable<{ data?: string }>) {
    if (rawEvent.data === "[DONE]") break
    if (!rawEvent.data) continue

    const chunk: unknown = JSON.parse(rawEvent.data)
    yield* translateChunkToAnthropicEvents(chunk, streamState)
  }
}

async function* createResponsesTurnEventStream(
  args: TurnArgs,
): AsyncGenerator<AnthropicStreamEventData> {
  const responsesPayload = translateAnthropicMessagesToResponsesPayload(
    args.payload,
  )
  responsesPayload.stream = true
  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const response = await withHeartbeat(
    {
      stream: args.stream,
      messageStartEmitted: args.messageStartEmitted,
      intervalMs: args.heartbeatIntervalMs,
    },
    () =>
      args.upstream.deps.createResponses(responsesPayload, {
        vision,
        initiator,
        ...args.upstream.callOptions,
      }),
  )

  if (!isAsyncIterable(response)) {
    throw new Error(
      "web-tools stream: upstream returned non-streaming response despite stream=true",
    )
  }

  const streamState = createResponsesStreamState()
  for await (const rawEvent of response) {
    if (rawEvent.event === "ping") {
      yield { type: "ping" }
      continue
    }
    if (!rawEvent.data) continue

    const event: unknown = JSON.parse(rawEvent.data)
    yield* translateResponsesStreamEvent(event, streamState)
    if (streamState.messageCompleted) break
  }
}

/**
 * Native `/v1/messages` turn: the upstream already speaks Anthropic events, so
 * they're parsed, not translated. One adjustment: Copilot reports input and
 * cache counts on `message_start` and output on `message_delta`, while the
 * loop sums each turn's `message_delta` only. Fold the turn's start counts
 * into its delta (the delta's own fields win, as in `mergeAnthropicUsage`).
 */
async function* createMessagesTurnEventStream(
  args: TurnArgs,
): AsyncGenerator<AnthropicStreamEventData> {
  const { upstream } = args
  const response = await withHeartbeat(
    {
      stream: args.stream,
      messageStartEmitted: args.messageStartEmitted,
      intervalMs: args.heartbeatIntervalMs,
    },
    () =>
      upstream.deps.createMessages(
        { ...args.payload, stream: true },
        upstream.anthropicBetaHeader,
        upstream.callOptions,
      ),
  )

  if (!isAsyncIterable<{ data?: string }>(response)) {
    throw new Error(
      "web-tools stream: upstream returned non-streaming response despite stream=true",
    )
  }

  let startUsage: StartUsage | undefined
  for await (const rawEvent of response) {
    if (rawEvent.data === "[DONE]") break
    if (!rawEvent.data) continue
    const event = parseMessagesEvent(rawEvent.data)
    if (!event) continue
    if (event.type === "message_start") {
      startUsage = event.message.usage
    } else if (event.type === "message_delta" && startUsage) {
      event.usage = foldStartUsage(startUsage, event.usage)
    }
    yield event
  }
}

type StartUsage = Extract<
  AnthropicStreamEventData,
  { type: "message_start" }
>["message"]["usage"]
type DeltaUsage = NonNullable<AnthropicMessageDeltaEvent["usage"]>

function foldStartUsage(
  start: StartUsage,
  delta: DeltaUsage | undefined,
): DeltaUsage {
  return {
    input_tokens: start.input_tokens,
    ...(start.cache_creation_input_tokens === undefined ?
      {}
    : { cache_creation_input_tokens: start.cache_creation_input_tokens }),
    ...(start.cache_read_input_tokens === undefined ?
      {}
    : { cache_read_input_tokens: start.cache_read_input_tokens }),
    output_tokens: start.output_tokens,
    ...delta,
  }
}

/** One upstream frame as an Anthropic event; `null` for a frame that isn't
 *  one (the loop has to read every event, so it can't forward raw bytes). */
function parseMessagesEvent(data: string): AnthropicStreamEventData | null {
  try {
    const parsed: unknown = JSON.parse(data)
    if (
      typeof parsed === "object"
      && parsed !== null
      && typeof (parsed as { type?: unknown }).type === "string"
    ) {
      return parsed as AnthropicStreamEventData
    }
    return null
  } catch {
    return null
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
  plan: ServerToolPlan
  /** Set while dispatching: the model called a tool that is the client's. */
  calls: { client: boolean }
  outcomes: Array<TurnOutcome>
  assistantContent: Array<AnthropicAssistantContentBlock>
  bufferedFinal: Array<AnthropicStreamEventData>
  logger: ConsolaInstance
  heartbeatIntervalMs: number
  /** Keep signed thinking (and redacted thinking) in the next turn's
   *  assistant message. Only the native transport can: its signatures are
   *  Anthropic's, and Claude requires the thinking that preceded a tool call
   *  to come back with it. The translated transports drop thinking. */
  replaysThinking: boolean
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
  const block = ev.content_block

  const serverTool =
    block.type === "tool_use" ? d.plan.tools.get(block.name) : undefined
  if (block.type === "tool_use" && !serverTool) d.calls.client = true
  // A hidden call is never shown, so it takes no index: the client's stay
  // contiguous.
  const clientIndex = serverTool?.hidden ? -1 : d.cursor.next++

  const open: OpenBlock = {
    clientIndex,
    serverTool,
    partialJson: "",
    text: "",
    thinking: "",
    signature: "",
    startBlock: block,
    blockKind: classifyBlock(block),
    ...(serverTool && block.type === "tool_use" ?
      { toolUse: { id: block.id, name: block.name } }
    : {}),
  }
  d.upstreamToClient.set(ev.index, open)

  if (serverTool?.hidden) return

  // Rewrite type for our `anthropic-*` tools: tool_use → server_tool_use.
  // Wire shape: id, name, input — identical to tool_use. The existing typed
  // event union doesn't model server_tool_use, so we write the rewritten
  // JSON directly to the SSE stream.
  if (serverTool && block.type === "tool_use") {
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
  if (ev.delta.type === "input_json_delta" && open.serverTool) {
    open.partialJson += ev.delta.partial_json
    if (open.serverTool.hidden) return
  } else if (ev.delta.type === "text_delta" && open.blockKind === "text") {
    open.text += ev.delta.text
  } else if (
    ev.delta.type === "thinking_delta"
    && open.blockKind === "thinking"
  ) {
    open.thinking += ev.delta.thinking
  } else if (
    ev.delta.type === "signature_delta"
    && open.blockKind === "thinking"
  ) {
    open.signature += ev.delta.signature
  }
  await writeEvent(d.stream, remapped)
}

async function handleBlockStop(
  d: DispatchArgs,
  ev: Extract<AnthropicStreamEventData, { type: "content_block_stop" }>,
): Promise<void> {
  const open = d.upstreamToClient.get(ev.index)
  if (!open) return
  if (!open.serverTool?.hidden) {
    await writeEvent(d.stream, {
      type: "content_block_stop",
      index: open.clientIndex,
    })
  }
  d.upstreamToClient.delete(ev.index)

  // Build assistant-content entry for the loop's next-turn message.
  if (open.blockKind === "text") {
    d.assistantContent.push({ type: "text", text: open.text })
  } else if (open.blockKind === "thinking") {
    // A translated transport's signature isn't Anthropic's, and Copilot
    // rejects thinking without a valid one on the next turn: drop it there.
    // The native transport's is real, and Claude needs it back.
    if (d.replaysThinking && open.signature) {
      d.assistantContent.push({
        type: "thinking",
        thinking: open.thinking,
        signature: open.signature,
      })
    }
  } else if (
    open.blockKind === "other"
    && d.replaysThinking
    && open.startBlock.type === "redacted_thinking"
  ) {
    d.assistantContent.push(
      open.startBlock as unknown as AnthropicAssistantContentBlock,
    )
  } else if (open.blockKind === "tool_use" && open.toolUse) {
    const input = parseToolInput(open.partialJson)
    const toolUseBlock: AnthropicToolUseBlock = {
      type: "tool_use",
      id: open.toolUse.id,
      name: open.toolUse.name,
      input,
    }
    d.assistantContent.push(toolUseBlock)

    if (open.serverTool) {
      // Execute (pings keep the stream alive meanwhile). An `anthropic-*`
      // tool then emits its result block at the next cursor; a hidden one
      // emits nothing.
      const { serverTool } = open
      const t0 = Date.now()
      const run = await withHeartbeat(
        {
          stream: d.stream,
          messageStartEmitted: d.messageStartEmitted,
          intervalMs: d.heartbeatIntervalMs,
        },
        () => serverTool.run(toolUseBlock),
      )
      const ms = Date.now() - t0
      debugLazy(d.logger, () => [
        "web-tools outcome",
        JSON.stringify({
          tool: toolUseBlock.name,
          id: toolUseBlock.id,
          ok: run.ok,
          ...(run.ok ? {} : { code: run.code }),
          ms,
        }),
      ])
      d.outcomes.push({ toolUse: toolUseBlock, run })

      if (run.clientBlock) {
        const resultIndex = d.cursor.next++
        await writeEvent(d.stream, {
          type: "content_block_start",
          index: resultIndex,
          content_block: run.clientBlock as unknown as Extract<
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

/**
 * Interval between keepalive pings emitted while awaiting a silent gap (tool
 * execution or the next upstream turn). Mirrors Anthropic's own cadence of
 * periodic `ping` events across long-running requests so a slow web fetch or
 * upstream round-trip doesn't look like a stalled stream to the client.
 */
const HEARTBEAT_INTERVAL_MS = 5_000

/**
 * Run `work` while emitting `ping` events every {@link HEARTBEAT_INTERVAL_MS}
 * so the SSE connection stays visibly alive across a gap that produces no
 * content. The wrapped `work` MUST NOT itself write to `stream` — a ping firing
 * mid-write would interleave a partial event. Callers pass only stream-silent
 * awaits (tool execution, the upstream fetch). Pings are suppressed until
 * `messageStartEmitted` is true, since a ping before `message_start` is not a
 * valid Anthropic stream. The interval is always cleared, even if `work` throws.
 */
async function withHeartbeat<T>(
  opts: {
    stream: SSEStreamingApi
    messageStartEmitted: boolean
    intervalMs: number
  },
  work: () => Promise<T>,
): Promise<T> {
  const { stream, messageStartEmitted, intervalMs } = opts
  if (!messageStartEmitted) return work()
  let pinging = false
  const timer = setInterval(() => {
    // Guard against overlapping writes if a previous ping is still in flight.
    if (pinging) return
    pinging = true
    void stream
      .writeSSE({ event: "ping", data: '{"type":"ping"}' })
      .finally(() => {
        pinging = false
      })
  }, intervalMs)
  try {
    return await work()
  } finally {
    clearInterval(timer)
  }
}

// Re-exports for the flow integration site.
