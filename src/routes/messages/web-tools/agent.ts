/**
 * Non-streaming agent loop. Drives multi-turn Copilot calls,
 * substituting client-side tool round-trips for Anthropic's
 * server-side web_search / web_fetch tools, and synthesizes the
 * server-side result blocks the client expects.
 *
 * Streaming variant lives in web-tools-stream.ts; shared primitives
 * (executor, result-block builders) are in web-tools-exec.ts.
 */

import type { ConsolaInstance } from "consola"

import type {
  AnthropicAssistantContentBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicToolUseBlock,
} from "~/lib/models/anthropic-types"

import { debugLazy } from "~/lib/platform/logger"
import {
  normalizeAnthropicUsage,
  withCopilotCost,
  type UsageTokens,
} from "~/lib/token-usage"

import type {
  PlannedServerTool,
  ServerToolClientBlock,
  ServerToolPlan,
  ServerToolRun,
} from "../server-tools/types"
import type { Executor } from "./executor"

import { planWebTools } from "./listings"
import { type WebToolPolicy } from "./rewriter"
import { BLOCK_KIND, MAX_AGENT_TURNS } from "./vocab"

interface RoundTrip {
  toolUseId: string
  run: ServerToolRun
}

interface Turn {
  assistant: Array<AnthropicAssistantContentBlock>
  trips: Array<RoundTrip>
}

export interface AgentLoopArgs {
  initialPayload: AnthropicMessagesPayload
  policy: WebToolPolicy
  executor: Executor
  callOnce: (payload: AnthropicMessagesPayload) => Promise<AnthropicResponse>
  /** Optional — when present, the loop emits debug-level traces matching
   *  the cadence of api-flows.ts. Tests pass `undefined` to keep output
   *  quiet. */
  logger?: ConsolaInstance
  /** The server tools this request offers. Absent: the web tools `policy`
   *  declares, run by `executor`. */
  serverTools?: ServerToolPlan
  /** Told the whole request's usage once, when the loop finishes. Absent for
   *  web-tools requests, which have never recorded it here. */
  recordUsage?: (usage: UsageTokens) => void
}

export async function runAgentLoop(
  args: AgentLoopArgs,
): Promise<AnthropicResponse> {
  const { initialPayload, policy, executor, callOnce, logger } = args
  const plan =
    args.serverTools
    ?? planWebTools({ payload: initialPayload, policy, executor })
  const messages: Array<AnthropicMessage> = [...initialPayload.messages]
  const turns: Array<Turn> = []

  let last: AnthropicResponse | null = null
  // Every agent turn is a separately-billed upstream `callOnce`. Only the last
  // turn's usage rides on the synthesized response, so its lone count would
  // under-report the whole request. Accumulate every turn's usage (and
  // copilot_usage) and stamp the total on the final response.
  const usageTotal = newUsageTotal()

  if (logger) {
    debugLazy(logger, () => [
      "web-tools agent start",
      JSON.stringify({
        decls: [...plan.tools.keys()],
        max_turns: MAX_AGENT_TURNS,
      }),
    ])
  }

  for (let i = 0; i < MAX_AGENT_TURNS; i++) {
    const turnPayload: AnthropicMessagesPayload = {
      ...initialPayload,
      messages,
    }
    if (logger) {
      debugLazy(logger, () => [
        "web-tools agent turn",
        JSON.stringify({ turn: i, msgs: messages.length }),
      ])
    }
    last = await callOnce(turnPayload)
    accumulateTurnUsage(usageTotal, last)

    const content = Array.isArray(last.content) ? last.content : []
    const ours = content.filter((block) => isOurToolUse(block, plan))

    if (ours.length === 0 || last.stop_reason !== "tool_use") {
      if (logger) {
        debugLazy(logger, () => [
          "web-tools agent done",
          JSON.stringify({ turns: i + 1, stop_reason: last?.stop_reason }),
        ])
      }
      turns.push({ assistant: content, trips: [] })
      break
    }

    const trips = await runOurCalls(content, plan, logger)
    turns.push({ assistant: content, trips })

    // The model also called a tool of the client's, and only the client has
    // its result: the turn goes back to the client as it stands. Our own
    // calls already ran and are woven in below.
    if (callsClientTool(content, plan)) break

    messages.push(
      { role: "assistant", content },
      { role: "user", content: trips.map((trip) => trip.run.toolResult) },
    )
  }

  if (logger && turns.length === MAX_AGENT_TURNS) {
    const lastTurn = turns.at(-1)
    if (lastTurn && lastTurn.trips.length > 0) {
      debugLazy(logger, () => [
        "web-tools agent ceiling",
        JSON.stringify({ max: MAX_AGENT_TURNS }),
      ])
    }
  }

  const response = synthesizeFinalResponse(
    last as AnthropicResponse,
    { turns, plan },
    usageTotal,
  )
  args.recordUsage?.(
    withCopilotCost(
      normalizeAnthropicUsage(response.usage),
      response.copilot_usage,
    ),
  )
  return response
}

/** Run every call of ours in one assistant turn, in order. */
async function runOurCalls(
  content: Array<AnthropicAssistantContentBlock>,
  plan: ServerToolPlan,
  logger: ConsolaInstance | undefined,
): Promise<Array<RoundTrip>> {
  const trips: Array<RoundTrip> = []
  for (const block of content) {
    if (!isOurToolUse(block, plan)) continue
    const t0 = Date.now()
    const run = await (plan.tools.get(block.name) as PlannedServerTool).run(
      block,
    )
    const ms = Date.now() - t0
    if (logger) {
      debugLazy(logger, () => [
        "web-tools outcome",
        JSON.stringify({
          tool: block.name,
          id: block.id,
          ok: run.ok,
          ...(run.ok ? {} : { code: run.code }),
          ms,
        }),
      ])
    }
    trips.push({ toolUseId: block.id, run })
  }
  return trips
}

function isOurToolUse(
  block: AnthropicAssistantContentBlock,
  plan: ServerToolPlan,
): block is AnthropicToolUseBlock {
  return block.type === "tool_use" && plan.tools.has(block.name)
}

function callsClientTool(
  content: Array<AnthropicAssistantContentBlock>,
  plan: ServerToolPlan,
): boolean {
  return content.some(
    (block) => block.type === "tool_use" && !plan.tools.has(block.name),
  )
}

// ────────────────────────────────────────────────────────────────────
// Cross-turn usage accumulation. Each agent turn is a separately-billed
// upstream call; the synthesized response reports only the last turn's
// usage, so we sum every turn's counts (and copilot_usage) here. Mirrors
// the streaming path's accumulateTurnUsage in web-tools-stream.ts.
// ────────────────────────────────────────────────────────────────────

/** Mutable running total. `input_tokens`/`output_tokens` always accumulate;
 *  optional cache counts and `copilot_usage` are only surfaced once at least
 *  one turn actually reports them, and `service_tier` is kept from the last
 *  turn that carried it (it's not additive). */
interface UsageTotal {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  service_tier?: AnthropicResponse["usage"]["service_tier"]
  copilot_total_nano_aiu?: number
}

function newUsageTotal(): UsageTotal {
  return { input_tokens: 0, output_tokens: 0 }
}

/**
 * Fold one turn's `usage` (and sibling `copilot_usage`) into the running
 * total. Missing fields default to 0; optional cache counts and copilot_usage
 * are only surfaced once a turn reports them. `service_tier` is not additive —
 * keep whichever the latest turn carried.
 */
function accumulateTurnUsage(total: UsageTotal, resp: AnthropicResponse): void {
  const u = resp.usage
  total.input_tokens += u.input_tokens
  total.output_tokens += u.output_tokens
  if (u.cache_creation_input_tokens !== undefined) {
    total.cache_creation_input_tokens =
      (total.cache_creation_input_tokens ?? 0) + u.cache_creation_input_tokens
  }
  if (u.cache_read_input_tokens !== undefined) {
    total.cache_read_input_tokens =
      (total.cache_read_input_tokens ?? 0) + u.cache_read_input_tokens
  }
  if (u.service_tier !== undefined) total.service_tier = u.service_tier
  const nano = resp.copilot_usage?.total_nano_aiu
  if (nano !== undefined) {
    total.copilot_total_nano_aiu = (total.copilot_total_nano_aiu ?? 0) + nano
  }
}

// ────────────────────────────────────────────────────────────────────
// Synthesis: collapse multiple Copilot turns into one Anthropic
// assistant message, weaving server_tool_use + web_*_tool_result blocks
// where the underlying tool_use round-trips happened.
// ────────────────────────────────────────────────────────────────────

interface ServerToolUseBlock {
  type: typeof BLOCK_KIND.serverToolUse
  id: string
  name: string
  input: Record<string, unknown>
}

type SynthesizedBlock =
  | AnthropicAssistantContentBlock
  | ServerToolUseBlock
  | ServerToolClientBlock

function buildServerToolUse(tu: AnthropicToolUseBlock): ServerToolUseBlock {
  return {
    type: BLOCK_KIND.serverToolUse,
    id: tu.id,
    name: tu.name,
    input: tu.input,
  }
}

/** A turn as the client sees it. A call to an `anthropic-*` tool becomes
 *  `server_tool_use` + its result block; a call to a `hidden` tool becomes
 *  nothing (the text around it stays). */
function weaveTurn(turn: Turn, plan: ServerToolPlan): Array<SynthesizedBlock> {
  const tripById = new Map<string, RoundTrip>(
    turn.trips.map((t) => [t.toolUseId, t]),
  )
  const out: Array<SynthesizedBlock> = []
  for (const block of turn.assistant) {
    if (block.type !== "tool_use") {
      out.push(block)
    } else if (tripById.has(block.id)) {
      const { clientBlock } = (tripById.get(block.id) as RoundTrip).run
      if (clientBlock) out.push(buildServerToolUse(block), clientBlock)
    } else if (!plan.tools.get(block.name)?.hidden) {
      // A hidden call that never ran (the reply was cut off mid-call) is
      // not for the client either.
      out.push(block)
    }
  }
  return out
}

/** The loop ran out of turns while the model was still calling only hidden
 *  tools, so no tool call is left for the client to answer. */
function endsOnHiddenCalls(
  turn: Turn | undefined,
  plan: ServerToolPlan,
): boolean {
  if (!turn || turn.trips.length === 0) return false
  return (
    turn.trips.every((trip) => trip.run.clientBlock === undefined)
    && !callsClientTool(turn.assistant, plan)
  )
}

function synthesizeFinalResponse(
  last: AnthropicResponse,
  run: { turns: Array<Turn>; plan: ServerToolPlan },
  usageTotal: UsageTotal,
): AnthropicResponse {
  const { turns, plan } = run
  const synthesized: Array<SynthesizedBlock> = []
  for (const turn of turns) {
    for (const block of weaveTurn(turn, plan)) synthesized.push(block)
  }
  // Replace the last-turn-only usage with the cross-turn total so the client
  // bills for every turn's upstream call, not just the final one.
  const usage: AnthropicResponse["usage"] = {
    input_tokens: usageTotal.input_tokens,
    output_tokens: usageTotal.output_tokens,
    ...(usageTotal.cache_creation_input_tokens !== undefined ?
      { cache_creation_input_tokens: usageTotal.cache_creation_input_tokens }
    : {}),
    ...(usageTotal.cache_read_input_tokens !== undefined ?
      { cache_read_input_tokens: usageTotal.cache_read_input_tokens }
    : {}),
    ...(usageTotal.service_tier !== undefined ?
      { service_tier: usageTotal.service_tier }
    : {}),
  }
  const stopReason =
    last.stop_reason === "tool_use" && endsOnHiddenCalls(turns.at(-1), plan) ?
      "end_turn"
    : last.stop_reason
  return {
    ...last,
    content: synthesized as Array<AnthropicAssistantContentBlock>,
    stop_reason: stopReason,
    usage,
    ...(usageTotal.copilot_total_nano_aiu !== undefined ?
      { copilot_usage: { total_nano_aiu: usageTotal.copilot_total_nano_aiu } }
    : {}),
  }
}
