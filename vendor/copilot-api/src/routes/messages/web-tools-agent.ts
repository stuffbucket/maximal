/**
 * Multi-turn agent loop for Anthropic-server-side web tools impersonated
 * via client-side tool round-trips with Copilot.
 *
 * Closes domain D6a (non-streaming). The streaming variant lives in
 * web-tools-stream.ts; both share executor / result-building primitives
 * via web-tools-exec.ts.
 *
 * Spec: docs/spec/web-tools.md
 */

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
}

export async function runAgentLoop(
  args: AgentLoopArgs,
): Promise<AnthropicResponse> {
  const { initialPayload, policy, executor, callOnce } = args
  const state = newRequestState(policy.declarations)
  const messages: Array<AnthropicMessage> = [...initialPayload.messages]
  const turns: Array<Turn> = []

  let last: AnthropicResponse | null = null

  for (let i = 0; i < MAX_AGENT_TURNS; i++) {
    const turnPayload: AnthropicMessagesPayload = {
      ...initialPayload,
      messages,
    }
    last = await callOnce(turnPayload)

    const content = Array.isArray(last.content) ? last.content : []
    const ours = content.filter((block) => isOurToolUse(block))

    if (ours.length === 0 || last.stop_reason !== "tool_use") {
      turns.push({ assistant: content, trips: [] })
      break
    }

    const trips: Array<RoundTrip> = []
    const toolResults: Array<AnthropicToolResultBlock> = []
    for (const block of content) {
      if (!isOurToolUse(block)) continue
      const outcome = await executeToolUse(block, executor, state)
      trips.push({ toolUseId: block.id, outcome })
      toolResults.push(buildToolResultMessage(block.id, outcome))
    }

    turns.push({ assistant: content, trips })

    messages.push(
      { role: "assistant", content },
      { role: "user", content: toolResults },
    )
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
