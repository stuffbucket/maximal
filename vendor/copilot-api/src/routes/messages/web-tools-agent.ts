/**
 * Multi-turn agent loop for Anthropic-server-side web tools impersonated
 * via client-side tool round-trips with Copilot.
 *
 * Closes domain D6a (non-streaming). The streaming variant (D6b) wraps
 * this same loop with stream-shaped I/O.
 *
 * Spec: docs/spec/web-tools.md
 */

import type {
  AnthropicAssistantContentBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from "./anthropic-types"
import type { Executor, FetchResult, SearchResult } from "./web-tools-executor"

import { isWebToolName, type WebToolPolicy } from "./web-tools-rewriter"
import {
  checkFetchPolicy,
  checkSearchPolicy,
  newRequestState,
  recordUse,
  type RequestState,
} from "./web-tools-state"
import {
  TOOL_NAME,
  BLOCK_KIND,
  type ToolName,
  type WebFetchErrorCode,
  type WebSearchErrorCode,
} from "./web-tools-vocab"

const MAX_AGENT_TURNS = 10

// ────────────────────────────────────────────────────────────────────
// Per-call result shape — a discriminated union over (tool, ok).
// ────────────────────────────────────────────────────────────────────

type ExecOutcome =
  | {
      tool: typeof TOOL_NAME.webFetch
      ok: true
      url: string
      markdown: string
      title?: string
    }
  | { tool: typeof TOOL_NAME.webFetch; ok: false; code: WebFetchErrorCode }
  | {
      tool: typeof TOOL_NAME.webSearch
      ok: true
      query: string
      items: SearchResult & { ok: true } extends { ok: true; items: infer I } ?
        I
      : never
    }
  | { tool: typeof TOOL_NAME.webSearch; ok: false; code: WebSearchErrorCode }

interface RoundTrip {
  toolUseId: string
  outcome: ExecOutcome
}

interface Turn {
  /** The assistant content array as Copilot returned it for this turn. */
  assistant: Array<AnthropicAssistantContentBlock>
  /** The web-tool round-trips that happened at the end of this turn,
   *  in order of appearance in `assistant.content`. */
  trips: Array<RoundTrip>
}

// ────────────────────────────────────────────────────────────────────
// Public entry point.
// ────────────────────────────────────────────────────────────────────

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
      // Model is done, or it called only client-side tools we don't
      // intercept (e.g. Claude Code's own bash). Pass through to client.
      turns.push({ assistant: content, trips: [] })
      break
    }

    // Execute each of our tool calls; record outcomes in document order.
    const trips: Array<RoundTrip> = []
    const toolResults: Array<AnthropicToolResultBlock> = []
    for (const block of content) {
      if (!isOurToolUse(block)) continue
      const outcome = await executeOne(block, executor, state)
      trips.push({ toolUseId: block.id, outcome })
      toolResults.push(toolResultFor(block.id, outcome))
    }

    turns.push({ assistant: content, trips })

    // Loop: append assistant turn, then user turn carrying tool_results.
    messages.push(
      { role: "assistant", content },
      { role: "user", content: toolResults },
    )
  }

  // last cannot be null here because the loop runs at least once.
  return synthesizeFinalResponse(last as AnthropicResponse, turns)
}

// ────────────────────────────────────────────────────────────────────
// Inner: one tool call.
// ────────────────────────────────────────────────────────────────────

function isOurToolUse(
  block: AnthropicAssistantContentBlock,
): block is AnthropicToolUseBlock & { name: ToolName } {
  return block.type === "tool_use" && isWebToolName(block.name)
}

async function executeOne(
  tu: AnthropicToolUseBlock & { name: ToolName },
  executor: Executor,
  state: RequestState,
): Promise<ExecOutcome> {
  if (tu.name === TOOL_NAME.webFetch) {
    const policyCheck = checkFetchPolicy(state, tu.input)
    if (!policyCheck.ok)
      return { tool: TOOL_NAME.webFetch, ok: false, code: policyCheck.code }
    const url = (tu.input as { url: string }).url
    const fr: FetchResult = await executor.fetch(url)
    if (!fr.ok) return { tool: TOOL_NAME.webFetch, ok: false, code: fr.code }
    recordUse(state, TOOL_NAME.webFetch)
    return {
      tool: TOOL_NAME.webFetch,
      ok: true,
      url,
      markdown: fr.markdown,
      title: fr.title,
    }
  }

  // web_search
  const policyCheck = checkSearchPolicy(state, tu.input)
  if (!policyCheck.ok)
    return { tool: TOOL_NAME.webSearch, ok: false, code: policyCheck.code }
  const query = (tu.input as { query: string }).query
  const sr: SearchResult = await executor.search(query)
  if (!sr.ok) return { tool: TOOL_NAME.webSearch, ok: false, code: sr.code }
  recordUse(state, TOOL_NAME.webSearch)
  return { tool: TOOL_NAME.webSearch, ok: true, query, items: sr.items }
}

// ────────────────────────────────────────────────────────────────────
// Inner: tool_result that goes back to the model on the next turn.
// Uses string content (the simple Anthropic shape) so the model sees
// either the markdown payload or a brief error string.
// ────────────────────────────────────────────────────────────────────

function toolResultFor(
  toolUseId: string,
  outcome: ExecOutcome,
): AnthropicToolResultBlock {
  if (outcome.ok) {
    if (outcome.tool === TOOL_NAME.webFetch) {
      return {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: outcome.markdown,
      }
    }
    return {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: JSON.stringify(outcome.items, null, 2),
    }
  }
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: `Error: ${outcome.code}`,
    is_error: true,
  }
}

// ────────────────────────────────────────────────────────────────────
// Synthesis: collapse multiple Copilot turns into one Anthropic
// assistant message, weaving server_tool_use + web_*_tool_result
// blocks where the underlying tool_use round-trips happened.
// ────────────────────────────────────────────────────────────────────

interface ServerToolUseBlock {
  type: typeof BLOCK_KIND.serverToolUse
  id: string
  name: ToolName
  input: Record<string, unknown>
}

interface WebFetchResultBlock {
  type: typeof BLOCK_KIND.webFetchResult
  tool_use_id: string
  content: {
    type: "web_fetch_result"
    url: string
    content: {
      type: "document"
      source: { type: "text"; media_type: "text/markdown"; data: string }
      title?: string
      citations: { enabled: boolean }
    }
    retrieved_at: string
  }
}

interface WebSearchResultBlock {
  type: typeof BLOCK_KIND.webSearchResult
  tool_use_id: string
  content: Array<{
    type: "web_search_result"
    url: string
    title: string
    encrypted_content: string
    page_age?: string | null
  }>
}

interface WebFetchErrorOutBlock {
  type: typeof BLOCK_KIND.webFetchError
  tool_use_id: string
  content: {
    type: typeof BLOCK_KIND.webFetchError
    error_code: WebFetchErrorCode
  }
}

interface WebSearchErrorOutBlock {
  type: typeof BLOCK_KIND.webSearchError
  tool_use_id: string
  content: {
    type: typeof BLOCK_KIND.webSearchError
    error_code: WebSearchErrorCode
  }
}

type SynthesizedBlock =
  | AnthropicAssistantContentBlock
  | ServerToolUseBlock
  | WebFetchResultBlock
  | WebSearchResultBlock
  | WebFetchErrorOutBlock
  | WebSearchErrorOutBlock

function encryptedContent(payload: object): string {
  // v1: base64(JSON). No HMAC. Round-trips correctly within a session.
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64")
}

function buildServerToolUse(tu: AnthropicToolUseBlock): ServerToolUseBlock {
  return {
    type: BLOCK_KIND.serverToolUse,
    id: tu.id,
    name: tu.name as ToolName,
    input: tu.input,
  }
}

function buildResultBlock(
  trip: RoundTrip,
):
  | WebFetchResultBlock
  | WebSearchResultBlock
  | WebFetchErrorOutBlock
  | WebSearchErrorOutBlock {
  const o = trip.outcome
  if (o.tool === TOOL_NAME.webFetch) {
    if (!o.ok) {
      return {
        type: BLOCK_KIND.webFetchError,
        tool_use_id: trip.toolUseId,
        content: { type: BLOCK_KIND.webFetchError, error_code: o.code },
      }
    }
    return {
      type: BLOCK_KIND.webFetchResult,
      tool_use_id: trip.toolUseId,
      content: {
        type: "web_fetch_result",
        url: o.url,
        content: {
          type: "document",
          source: {
            type: "text",
            media_type: "text/markdown",
            data: o.markdown,
          },
          ...(o.title === undefined ? {} : { title: o.title }),
          citations: { enabled: false },
        },
        retrieved_at: new Date().toISOString(),
      },
    }
  }

  if (!o.ok) {
    return {
      type: BLOCK_KIND.webSearchError,
      tool_use_id: trip.toolUseId,
      content: { type: BLOCK_KIND.webSearchError, error_code: o.code },
    }
  }
  return {
    type: BLOCK_KIND.webSearchResult,
    tool_use_id: trip.toolUseId,
    content: o.items.map((it) => ({
      type: "web_search_result",
      url: it.url,
      title: it.title,
      encrypted_content: encryptedContent({
        url: it.url,
        title: it.title,
        page_age: it.page_age ?? null,
      }),
      ...(it.page_age === undefined ? {} : { page_age: it.page_age }),
    })),
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
      out.push(buildServerToolUse(block), buildResultBlock(trip))
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
  // The last response IS one of the turns' content; we already wove it
  // into `synthesized`. We just return the response with the woven
  // content array swapped in.
  return {
    ...last,
    content: synthesized as Array<AnthropicAssistantContentBlock>,
  }
}

// ────────────────────────────────────────────────────────────────────
// Helper exported for the integration site: sanity-check that a payload
// declares any web tools at all before bothering with the agent loop.
// ────────────────────────────────────────────────────────────────────

export function policyHasWebTools(policy: WebToolPolicy): boolean {
  return policy.declarations.length > 0
}

// Re-export for the integration site.
export type { WebToolPolicy } from "./web-tools-rewriter"
export { isWebToolName } from "./web-tools-rewriter"

// Currently-unused but useful: detect if a block carries text we'd want
// to surface verbatim (vs. tool-related machinery).
export function isTextBlock(b: SynthesizedBlock): b is AnthropicTextBlock {
  return b.type === "text"
}
