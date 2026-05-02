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

import { debugLazy } from "~/lib/logger"

import type {
  AnthropicAssistantContentBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from "./anthropic-types"
import type { Executor } from "./web-tools-executor"

import {
  buildResultBlockForOutcome,
  buildToolResultMessage,
  executeToolUse,
  type ExecOutcome,
  type ResultOutBlock,
} from "./web-tools-exec"
import { isWebToolName, type WebToolPolicy } from "./web-tools-rewriter"
import { newRequestState } from "./web-tools-state"
import { BLOCK_KIND, MAX_AGENT_TURNS, type ToolName } from "./web-tools-vocab"

interface RoundTrip {
  toolUseId: string
  outcome: ExecOutcome
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
}

export async function runAgentLoop(
  args: AgentLoopArgs,
): Promise<AnthropicResponse> {
  const { initialPayload, policy, executor, callOnce, logger } = args
  const state = newRequestState(policy.declarations)
  const messages: Array<AnthropicMessage> = [...initialPayload.messages]
  const turns: Array<Turn> = []

  let last: AnthropicResponse | null = null

  if (logger) {
    debugLazy(logger, () => [
      "web-tools agent start",
      JSON.stringify({
        decls: policy.declarations.map((d) => d.name),
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

    const content = Array.isArray(last.content) ? last.content : []
    const ours = content.filter((block) => isOurToolUse(block))

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

    const trips: Array<RoundTrip> = []
    const toolResults: Array<AnthropicToolResultBlock> = []
    for (const block of content) {
      if (!isOurToolUse(block)) continue
      const t0 = Date.now()
      const outcome = await executeToolUse(block, executor, state)
      const ms = Date.now() - t0
      if (logger) {
        debugLazy(logger, () => [
          "web-tools outcome",
          JSON.stringify({
            tool: block.name,
            id: block.id,
            ok: outcome.ok,
            ...(outcome.ok ? {} : { code: outcome.code }),
            ms,
          }),
        ])
      }
      trips.push({ toolUseId: block.id, outcome })
      toolResults.push(buildToolResultMessage(block.id, outcome))
    }

    turns.push({ assistant: content, trips })

    messages.push(
      { role: "assistant", content },
      { role: "user", content: toolResults },
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

  return synthesizeFinalResponse(last as AnthropicResponse, turns)
}

function isOurToolUse(
  block: AnthropicAssistantContentBlock,
): block is AnthropicToolUseBlock & { name: ToolName } {
  return block.type === "tool_use" && isWebToolName(block.name)
}

// ────────────────────────────────────────────────────────────────────
// Synthesis: collapse multiple Copilot turns into one Anthropic
// assistant message, weaving server_tool_use + web_*_tool_result blocks
// where the underlying tool_use round-trips happened.
// ────────────────────────────────────────────────────────────────────

interface ServerToolUseBlock {
  type: typeof BLOCK_KIND.serverToolUse
  id: string
  name: ToolName
  input: Record<string, unknown>
}

type SynthesizedBlock =
  | AnthropicAssistantContentBlock
  | ServerToolUseBlock
  | ResultOutBlock

function buildServerToolUse(tu: AnthropicToolUseBlock): ServerToolUseBlock {
  return {
    type: BLOCK_KIND.serverToolUse,
    id: tu.id,
    name: tu.name as ToolName,
    input: tu.input,
  }
}

function weaveTurn(turn: Turn): Array<SynthesizedBlock> {
  if (turn.trips.length === 0) return turn.assistant
  const tripById = new Map<string, RoundTrip>(
    turn.trips.map((t) => [t.toolUseId, t]),
  )
  const out: Array<SynthesizedBlock> = []
  for (const block of turn.assistant) {
    if (block.type === "tool_use" && tripById.has(block.id)) {
      const trip = tripById.get(block.id) as RoundTrip
      out.push(
        buildServerToolUse(block),
        buildResultBlockForOutcome(trip.toolUseId, trip.outcome),
      )
    } else {
      out.push(block)
    }
  }
  return out
}

function synthesizeFinalResponse(
  last: AnthropicResponse,
  turns: Array<Turn>,
): AnthropicResponse {
  const synthesized: Array<SynthesizedBlock> = []
  for (const turn of turns) {
    for (const block of weaveTurn(turn)) synthesized.push(block)
  }
  return {
    ...last,
    content: synthesized as Array<AnthropicAssistantContentBlock>,
  }
}
