import consola from "consola"
import { Hono } from "hono"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/lib/models/anthropic-types"
import type { UsageTokens } from "~/lib/token-usage"
import type { Model } from "~/services/copilot/get-models"

import {
  applyServerToolDeclarations,
  planServerTools,
} from "~/routes/messages/server-tools/plan"
import {
  type ServerToolListing,
  type ServerToolPlan,
  type ServerToolRun,
} from "~/routes/messages/server-tools/types"
import { handleWithWebToolsAgent } from "~/routes/messages/web-tools/flow"
import { type WebToolsUpstreamDeps } from "~/routes/messages/web-tools/transport"

import { type FakeExecutor } from "./fake-executor"

// Shared by the server-tools loop tests: a hidden, always-offered tool (what a
// plugin registers), the native Messages transport driven with injected
// upstream fakes (no mock.module, no fetch stub), and the event builders.

export const claudeModel = {
  id: "claude-sonnet-4.6",
  name: "Claude Sonnet 4.6",
  object: "model",
  preview: false,
  vendor: "Anthropic",
  version: "4.6",
  model_picker_enabled: true,
  supported_endpoints: ["/chat/completions", "/v1/messages"],
  capabilities: {
    family: "claude-sonnet-4.6",
    limits: { max_prompt_tokens: 200_000 },
    object: "model_capabilities",
    supports: { tool_calls: true, streaming: true },
    tokenizer: "o200k_base",
    type: "chat",
  },
} satisfies Model

export const readTool = {
  name: "Read",
  description: "Read a file",
  input_schema: { type: "object", properties: { path: { type: "string" } } },
}

export const noWebTools = {
  declarations: [],
  hasSearch: false,
  hasFetch: false,
}

export const searchPolicy = {
  declarations: [
    { type: "web_search_20250305" as const, name: "web_search" as const },
  ],
  hasSearch: true,
  hasFetch: false,
}

export function payload(stream: boolean): AnthropicMessagesPayload {
  return {
    model: claudeModel.id,
    max_tokens: 1024,
    stream,
    system: [{ type: "text", text: "You are helpful." }],
    messages: [{ role: "user", content: "is the build green?" }],
    tools: [readTool],
  }
}

export const decideInput = { question: "which option?" }

// ── the tool a plugin would register ──────────────────────────────────

export interface DecideProbe {
  listing: ServerToolListing
  calls: Array<Record<string, unknown>>
}

export function decideTool(
  options: { delayMs?: number; result?: Partial<ServerToolRun> } = {},
): DecideProbe {
  const calls: Array<Record<string, unknown>> = []
  const listing: ServerToolListing = {
    owner: "fake-plugin",
    name: "decide",
    description: "Decide between options.",
    input_schema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
    render: "hidden",
    offer: "always",
    clients: ["claude-code"],
    run: async (toolUse) => {
      calls.push(toolUse.input)
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      }
      return {
        toolResult: {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: "option B",
        },
        ok: true,
        ...options.result,
      }
    },
  }
  return { listing, calls }
}

/** Plan for a claude-code request and put the declarations on `body`. */
export function planFor(
  body: AnthropicMessagesPayload,
  listings: ReadonlyArray<ServerToolListing>,
  declared: Array<string> = [],
): ServerToolPlan {
  const plan = planServerTools({
    payload: body,
    listings,
    declared: new Set(declared),
    request: {
      client: "claude-code",
      model: body.model,
      compact: false,
      signal: new AbortController().signal,
    },
    logger: { warn: () => {} },
  })
  applyServerToolDeclarations(body, plan)
  return plan
}

// ── upstream fakes ────────────────────────────────────────────────────

export interface MessagesCall {
  payload: AnthropicMessagesPayload
  /** Serialized at call time: the loop keeps appending to its messages. */
  bytes: string
}

const unexpected = (): never => {
  throw new Error("the loop left the native transport")
}

export function fakeDeps(
  replies: Array<AnthropicResponse | Array<Record<string, unknown>>>,
): { deps: Partial<WebToolsUpstreamDeps>; calls: Array<MessagesCall> } {
  const calls: Array<MessagesCall> = []
  let turn = 0
  const createMessages: WebToolsUpstreamDeps["createMessages"] = (sent) => {
    calls.push({ payload: sent, bytes: JSON.stringify(sent) })
    const reply = replies[Math.min(turn++, replies.length - 1)]
    if (!Array.isArray(reply)) return Promise.resolve(reply)
    const frames = reply.map((event) => ({
      event: String(event.type),
      data: JSON.stringify(event),
    }))
    return Promise.resolve({
      [Symbol.asyncIterator]: function* () {
        for (const frame of frames) yield frame
      },
    } as unknown as Awaited<ReturnType<WebToolsUpstreamDeps["createMessages"]>>)
  }
  return {
    calls,
    deps: {
      createMessages,
      createChatCompletions: unexpected,
      createResponses: unexpected,
    },
  }
}

export function loopApp(input: {
  body: AnthropicMessagesPayload
  plan: ServerToolPlan
  deps: Partial<WebToolsUpstreamDeps>
  executor?: FakeExecutor
  recordUsage?: (usage: UsageTokens) => void
}): Hono {
  const hono = new Hono()
  hono.post("/", (c) =>
    handleWithWebToolsAgent({
      c,
      payload: input.body,
      options: {
        logger: consola.create({ level: 0 }),
        requestId: "req-1",
        sessionId: "session-1",
      },
      policy: noWebTools,
      selectedModel: claudeModel,
      serverTools: input.plan,
      transportPolicy: { nativeMessages: true },
      deps: input.deps,
      executor: input.executor,
      recordUsage: input.recordUsage,
    }),
  )
  return hono
}

export const post = { method: "POST" }

// ── event builders ────────────────────────────────────────────────────

export function messageStart(id: string, usage: Record<string, number>) {
  return {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: claudeModel.id,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  }
}

export function textBlock(index: number, text: string) {
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    },
    { type: "content_block_stop", index },
  ]
}

export function toolBlock(
  index: number,
  call: { id: string; name: string; input: Record<string, unknown> },
) {
  return [
    {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(call.input),
      },
    },
    { type: "content_block_stop", index },
  ]
}

export function finish(stopReason: string, outputTokens: number) {
  return [
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    },
    { type: "message_stop" },
  ]
}

export const decideCall = { id: "toolu_1", name: "decide", input: decideInput }

/** Turn 1: some text, then a call to `decide`. */
export const callTurn = [
  messageStart("msg_1", {
    input_tokens: 100,
    output_tokens: 1,
    cache_read_input_tokens: 80,
  }),
  ...textBlock(0, "Let me check. "),
  ...toolBlock(1, decideCall),
  ...finish("tool_use", 20),
]

/** Turn 2: the answer. */
export const answerTurn = [
  messageStart("msg_2", {
    input_tokens: 150,
    output_tokens: 1,
    cache_read_input_tokens: 120,
  }),
  ...textBlock(0, "Option B."),
  ...finish("end_turn", 5),
]

export function parseSse(
  text: string,
): Array<{ event: string; data: unknown }> {
  return text
    .split("\n\n")
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const lines = frame.split("\n")
      const event = lines
        .find((l) => l.startsWith("event:"))
        ?.slice(6)
        .trim()
      const data = lines
        .find((l) => l.startsWith("data:"))
        ?.slice(5)
        .trim()
      return { event: event ?? "", data: JSON.parse(data ?? "null") as unknown }
    })
}

export function reply(input: {
  id: string
  content: AnthropicResponse["content"]
  stopReason: AnthropicResponse["stop_reason"]
  usage: AnthropicResponse["usage"]
  nano?: number
}): AnthropicResponse {
  return {
    id: input.id,
    type: "message",
    role: "assistant",
    model: claudeModel.id,
    content: input.content,
    stop_reason: input.stopReason,
    stop_sequence: null,
    usage: input.usage,
    ...(input.nano === undefined ?
      {}
    : { copilot_usage: { total_nano_aiu: input.nano } }),
  }
}

/** The tools array an upstream call carried, as the bytes. */
export function toolsBytes(call: MessagesCall): string {
  return JSON.stringify(call.payload.tools)
}
