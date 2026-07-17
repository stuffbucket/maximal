import type {
  AnthropicDocumentBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicUserContentBlock,
} from "~/lib/models/anthropic-types"
import type { Model } from "~/services/copilot/get-models"

import { getReasoningEffortForModel } from "~/lib/config/config"
import {
  COMPACT_AUTO_CONTINUE,
  COMPACT_REQUEST,
  compactAutoContinuePromptStarts,
  compactMessageSections,
  compactSummaryPromptStart,
  compactSystemPromptStarts,
  compactTextOnlyGuard,
  type CompactType,
} from "~/lib/models/compact"
import { resolveModelProfile } from "~/lib/models/model-profile"

export const TOOL_REFERENCE_TURN_BOUNDARY = "Tool loaded."

const IDE_EXECUTE_CODE_TOOL = "mcp__ide__executeCode"
const IDE_GET_DIAGNOSTICS_TOOL = "mcp__ide__getDiagnostics"
const IDE_GET_DIAGNOSTICS_DESCRIPTION =
  "Get language diagnostics from VS Code. Returns errors, warnings, information, and hints for files in the workspace."
const PDF_FILE_READ_PREFIX = "PDF file read:"

type AnthropicAttachmentBlock = AnthropicImageBlock | AnthropicDocumentBlock
type IndexedAttachment = {
  attachment: AnthropicAttachmentBlock
  order: number
}
type UnsupportedTopLevelAnthropicFields = {
  diagnostics?: unknown
}

export const stripUnsupportedTopLevelAnthropicFields = (
  payload: AnthropicMessagesPayload,
): void => {
  delete (
    payload as AnthropicMessagesPayload & UnsupportedTopLevelAnthropicFields
  ).diagnostics
}

const getCompactCandidateText = (message: AnthropicMessage): string => {
  if (message.role !== "user") {
    return ""
  }

  if (typeof message.content === "string") {
    return message.content
  }

  return message.content
    .filter((block): block is AnthropicTextBlock => block.type === "text")
    .map((block) =>
      block.text.startsWith("<system-reminder>") ? "" : block.text,
    )
    .filter((text) => text.length > 0)
    .join("\n\n")
}

const isCompactMessage = (lastMessage: AnthropicMessage): boolean => {
  const text = getCompactCandidateText(lastMessage)
  if (!text) {
    return false
  }

  return (
    text.includes(compactTextOnlyGuard)
    && text.includes(compactSummaryPromptStart)
    && compactMessageSections.some((section) => text.includes(section))
  )
}

const isCompactAutoContinueMessage = (
  lastMessage: AnthropicMessage,
): boolean => {
  const text = getCompactCandidateText(lastMessage)
  return (
    Boolean(text)
    && compactAutoContinuePromptStarts.some((promptStart) =>
      text.startsWith(promptStart),
    )
  )
}

export const getCompactType = (
  anthropicPayload: AnthropicMessagesPayload,
): CompactType => {
  const lastMessage = anthropicPayload.messages.at(-1)
  if (lastMessage && isCompactMessage(lastMessage)) {
    return COMPACT_REQUEST
  }

  if (lastMessage && isCompactAutoContinueMessage(lastMessage)) {
    return COMPACT_AUTO_CONTINUE
  }

  const system = anthropicPayload.system
  if (typeof system === "string") {
    const hasCompactSystemPrompt = compactSystemPromptStarts.some(
      (promptStart) => system.startsWith(promptStart),
    )
    return hasCompactSystemPrompt ? COMPACT_REQUEST : 0
  }
  if (!Array.isArray(system)) return 0

  const hasCompactSystemPrompt = system.some(
    (msg) =>
      typeof msg.text === "string"
      && compactSystemPromptStarts.some((promptStart) =>
        msg.text.startsWith(promptStart),
      ),
  )
  if (hasCompactSystemPrompt) {
    return COMPACT_REQUEST
  }

  return 0
}

const mergeContentWithText = (
  tr: AnthropicToolResultBlock,
  textBlock: AnthropicTextBlock,
): AnthropicToolResultBlock => {
  if (typeof tr.content === "string") {
    return { ...tr, content: `${tr.content}\n\n${textBlock.text}` }
  }
  // Unable to merge, discard other text blocks, wait for the next round of re-request
  if (hasToolRef(tr)) {
    return tr
  }
  return {
    ...tr,
    content: [...tr.content, textBlock],
  }
}

const mergeContentWithTexts = (
  tr: AnthropicToolResultBlock,
  textBlocks: Array<AnthropicTextBlock>,
): AnthropicToolResultBlock => {
  if (typeof tr.content === "string") {
    const appendedTexts = textBlocks.map((tb) => tb.text).join("\n\n")
    return { ...tr, content: `${tr.content}\n\n${appendedTexts}` }
  }
  // Unable to merge, discard other text blocks, wait for the next round of re-request
  if (hasToolRef(tr)) {
    return tr
  }
  return { ...tr, content: [...tr.content, ...textBlocks] }
}

const mergeContentWithAttachments = (
  tr: AnthropicToolResultBlock,
  attachments: Array<AnthropicAttachmentBlock>,
): AnthropicToolResultBlock => {
  if (typeof tr.content === "string") {
    return {
      ...tr,
      content: [{ type: "text", text: tr.content }, ...attachments],
    }
  }

  return {
    ...tr,
    content: [...tr.content, ...attachments],
  }
}

const isAttachmentBlock = (
  block: AnthropicUserContentBlock,
): block is AnthropicAttachmentBlock => {
  return block.type === "image" || block.type === "document"
}

const getMergeableToolResultIndices = (
  toolResults: Array<AnthropicToolResultBlock>,
): Array<number> => {
  return toolResults.flatMap((block, index) =>
    block.is_error || hasToolRef(block) ? [] : [index],
  )
}

const mergeAttachmentsIntoToolResults = (
  toolResults: Array<AnthropicToolResultBlock>,
  attachmentsByToolResultIndex: Map<number, Array<IndexedAttachment>>,
): Array<AnthropicToolResultBlock> => {
  if (attachmentsByToolResultIndex.size === 0) {
    return toolResults
  }

  return toolResults.map((block, index) => {
    const matchedAttachments = attachmentsByToolResultIndex.get(index)
    if (!matchedAttachments) {
      return block
    }

    const orderedAttachments = [...matchedAttachments]
      .sort((left, right) => left.order - right.order)
      .map(({ attachment }) => attachment)

    return mergeContentWithAttachments(block, orderedAttachments)
  })
}

const assignAttachmentsToToolResults = (
  target: Map<number, Array<IndexedAttachment>>,
  attachments: Array<IndexedAttachment>,
  options: {
    toolResultIndices: Array<number>
    fallbackToolResultIndices?: Array<number>
  },
): void => {
  const { toolResultIndices } = options
  const fallbackToolResultIndices =
    options.fallbackToolResultIndices ?? toolResultIndices

  if (attachments.length === 0) {
    return
  }

  if (
    toolResultIndices.length > 0
    && toolResultIndices.length === attachments.length
  ) {
    for (const [index, toolResultIndex] of toolResultIndices.entries()) {
      const currentAttachments = target.get(toolResultIndex)
      if (currentAttachments) {
        currentAttachments.push(attachments[index])
        continue
      }

      target.set(toolResultIndex, [attachments[index]])
    }
    return
  }

  const lastToolResultIndex = fallbackToolResultIndices.at(-1)
  if (lastToolResultIndex === undefined) {
    return
  }

  const currentAttachments = target.get(lastToolResultIndex)
  if (currentAttachments) {
    currentAttachments.push(...attachments)
    return
  }

  target.set(lastToolResultIndex, [...attachments])
}

const startsWithPdfFileRead = (
  toolResult: AnthropicToolResultBlock,
): boolean => {
  if (typeof toolResult.content === "string") {
    return toolResult.content.startsWith(PDF_FILE_READ_PREFIX)
  }

  if (toolResult.content.some((block) => block.type === "document")) {
    return false
  }

  if (toolResult.content.length === 0) {
    return false
  }

  const firstBlock = toolResult.content[0]
  if (firstBlock.type !== "text") {
    return false
  }

  return firstBlock.text.startsWith(PDF_FILE_READ_PREFIX)
}

const collectMergeableUserContent = (
  content: Array<AnthropicUserContentBlock>,
): {
  toolResults: Array<AnthropicToolResultBlock>
  textBlocks: Array<AnthropicTextBlock>
  attachments: Array<IndexedAttachment>
} | null => {
  const toolResults: Array<AnthropicToolResultBlock> = []
  const textBlocks: Array<AnthropicTextBlock> = []
  const attachments: Array<IndexedAttachment> = []

  for (const [order, block] of content.entries()) {
    if (block.type === "tool_result") {
      toolResults.push(block)
      continue
    }
    if (block.type === "text") {
      textBlocks.push(block)
      continue
    }
    if (isAttachmentBlock(block)) {
      attachments.push({ attachment: block, order })
      continue
    }

    return null
  }

  return {
    toolResults,
    textBlocks,
    attachments,
  }
}

const mergeAttachmentsForToolResults = (
  toolResults: Array<AnthropicToolResultBlock>,
  attachments: Array<IndexedAttachment>,
): Array<AnthropicToolResultBlock> => {
  if (attachments.length === 0) {
    return toolResults
  }

  const documentBlocks = attachments.filter(
    ({ attachment }) => attachment.type === "document",
  )
  const mergeableToolResultIndices = getMergeableToolResultIndices(toolResults)
  const pdfReadToolResultIndices = mergeableToolResultIndices.filter((index) =>
    startsWithPdfFileRead(toolResults[index]),
  )

  const attachmentsByToolResultIndex = new Map<
    number,
    Array<IndexedAttachment>
  >()
  let remainingAttachments = attachments
  let countMatchToolResultIndices = mergeableToolResultIndices

  // Match PDF read tool results and documents in order first, then leave any
  // unmatched documents to the generic fallback path below.
  if (documentBlocks.length > 0 && pdfReadToolResultIndices.length > 0) {
    const matchedDocumentCount = Math.min(
      pdfReadToolResultIndices.length,
      documentBlocks.length,
    )
    const matchedDocuments = documentBlocks.slice(0, matchedDocumentCount)
    const matchedDocumentOrders = new Set(
      matchedDocuments.map(({ order }) => order),
    )
    const matchedPdfToolResultIndices = pdfReadToolResultIndices.slice(
      0,
      matchedDocumentCount,
    )
    const matchedPdfToolResultIndexSet = new Set(matchedPdfToolResultIndices)

    assignAttachmentsToToolResults(
      attachmentsByToolResultIndex,
      matchedDocuments,
      {
        toolResultIndices: matchedPdfToolResultIndices,
      },
    )
    countMatchToolResultIndices = mergeableToolResultIndices.filter(
      (index) => !matchedPdfToolResultIndexSet.has(index),
    )
    remainingAttachments = attachments.filter(
      ({ attachment, order }) =>
        attachment.type !== "document" || !matchedDocumentOrders.has(order),
    )
  }

  // Everything else keeps the existing count-match / last-tool-result fallback.
  assignAttachmentsToToolResults(
    attachmentsByToolResultIndex,
    remainingAttachments,
    {
      toolResultIndices: countMatchToolResultIndices,
      fallbackToolResultIndices: mergeableToolResultIndices,
    },
  )

  return mergeAttachmentsIntoToolResults(
    toolResults,
    attachmentsByToolResultIndex,
  )
}

const mergeUserMessageContent = (
  content: Array<AnthropicUserContentBlock>,
): Array<AnthropicUserContentBlock> | null => {
  const mergeableContent = collectMergeableUserContent(content)
  if (!mergeableContent) {
    return null
  }

  const { toolResults, textBlocks, attachments } = mergeableContent
  if (
    toolResults.length === 0
    || (textBlocks.length === 0 && attachments.length === 0)
  ) {
    return null
  }

  const mergedToolResults =
    textBlocks.length === 0 ?
      toolResults
    : mergeToolResult(toolResults, textBlocks)

  return mergeAttachmentsForToolResults(mergedToolResults, attachments)
}

const mergeToolResult = (
  toolResults: Array<AnthropicToolResultBlock>,
  textBlocks: Array<AnthropicTextBlock>,
): Array<AnthropicToolResultBlock> => {
  if (toolResults.length === textBlocks.length) {
    return toolResults.map((tr, i) => mergeContentWithText(tr, textBlocks[i]))
  }

  const lastIndex = toolResults.length - 1
  return toolResults.map((tr, i) =>
    i === lastIndex ? mergeContentWithTexts(tr, textBlocks) : tr,
  )
}

export const stripToolReferenceTurnBoundary = (
  anthropicPayload: AnthropicMessagesPayload,
): void => {
  for (const msg of anthropicPayload.messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue

    const hasToolReference = msg.content.some(
      (block) => block.type === "tool_result" && hasToolRef(block),
    )
    if (!hasToolReference) continue

    msg.content = msg.content.filter(
      (block) =>
        block.type !== "text"
        || block.text.trim() !== TOOL_REFERENCE_TURN_BOUNDARY,
    )
  }
}

export const mergeToolResultForClaude = (
  anthropicPayload: AnthropicMessagesPayload,
  options?: {
    skipLastMessage?: boolean
  },
): void => {
  const lastMessageIndex = anthropicPayload.messages.length - 1

  for (const [index, msg] of anthropicPayload.messages.entries()) {
    if (options?.skipLastMessage && index === lastMessageIndex) continue

    if (msg.role !== "user" || !Array.isArray(msg.content)) continue

    const mergedContent = mergeUserMessageContent(msg.content)
    if (mergedContent) {
      msg.content = mergedContent
    }
  }
}

// align with vscode copilot claude agent tools
export const sanitizeIdeTools = (payload: AnthropicMessagesPayload): void => {
  if (!payload.tools || payload.tools.length === 0) {
    return
  }

  payload.tools = payload.tools.flatMap((tool) => {
    if (tool.name === IDE_EXECUTE_CODE_TOOL && !tool.defer_loading) {
      return []
    }

    if (tool.name === IDE_GET_DIAGNOSTICS_TOOL) {
      return [
        {
          ...tool,
          description: IDE_GET_DIAGNOSTICS_DESCRIPTION,
        },
      ]
    }

    return [tool]
  })
}

const hasToolRef = (block: AnthropicToolResultBlock) => {
  return (
    Array.isArray(block.content)
    && block.content.some((c) => c.type === "tool_reference")
  )
}

const stripCacheControlScope = (obj: unknown): void => {
  if (!obj || typeof obj !== "object") return
  const record = obj as Record<string, unknown>
  const cc = record.cache_control
  if (cc && typeof cc === "object") {
    const { scope: _scope, ...rest } = cc as Record<string, unknown>
    record.cache_control = rest
  }
}

// Strip scope from cache_control wherever it appears (system blocks, tools,
// message content) — Copilot's Messages API rejects the scope field.
// Also strips cache_control entirely from inside tool_result.content[] items,
// where the API requires it to be on the tool_result block itself.
// Strips eager_input_streaming from tool definitions — injected by some
// editors (e.g. Zed) but rejected by Copilot's backend.
const stripCacheControl = (payload: AnthropicMessagesPayload): void => {
  if (Array.isArray(payload.system)) {
    for (const block of payload.system) {
      stripCacheControlScope(block)
    }
  }

  if (payload.tools) {
    for (const tool of payload.tools) {
      stripCacheControlScope(tool)
      delete tool.eager_input_streaming
    }
  }

  for (const msg of payload.messages) {
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (block.type !== "tool_result" || !Array.isArray(block.content))
        continue
      for (const inner of block.content) {
        const b = inner as typeof inner & { cache_control?: unknown }
        if ("cache_control" in b) {
          delete b.cache_control
        }
      }
    }
  }
}

// Pre-request processing: filter thinking blocks for Claude models so only
// valid thinking blocks are sent to the Copilot Messages API.
const filterAssistantThinkingBlocks = (
  payload: AnthropicMessagesPayload,
): void => {
  for (const msg of payload.messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      msg.content = msg.content.filter((block) => {
        if (block.type !== "thinking") return true
        return (
          block.thinking
          && block.thinking !== "Thinking..."
          && block.signature
          && !block.signature.includes("@")
        )
      })
    }
  }
}

// Copilot's reasoning-model backends reject sampling params in two ways:
//   1. Reasoning models reject temperature/top_p/top_k outright with a 400.
//      This covers Copilot's Bedrock-backed Claude (adaptive_thinking) AND
//      OpenAI's reasoning models served via Copilot (the GPT-5.x trio, which
//      advertise a reasoning_effort ladder but NOT adaptive_thinking) — so the
//      guard keys on the resolved `isReasoning`, not `adaptive_thinking` alone,
//      which had let temperature leak through to the GPT-5.x models and 400.
//   2. ALL models reject temperature and top_p *together* ("`temperature` and
//      `top_p` cannot both be specified for this model. Please use only one.").
// (2) is an API-level constraint, so it is deliberately not gated on model
// capability. Claude Code <= 2.1.159 sends both; api.anthropic.com accepts it
// but Copilot does not. Drop top_p (keep temperature) whenever both survive.
const stripSamplingParams = (
  payload: AnthropicMessagesPayload,
  selectedModel?: Model,
): void => {
  if (selectedModel && resolveModelProfile(selectedModel).isReasoning) {
    delete payload.temperature
    delete payload.top_p
    delete payload.top_k
  }

  if (payload.temperature !== undefined && payload.top_p !== undefined) {
    delete payload.top_p
  }
}

// Adaptive-thinking rewrite (the #210 home). Reads the client's incoming
// thinking intent, then overwrites `payload.thinking` + sets `output_config`
// when the model supports adaptive thinking and nothing disables it. The
// intent read and the overwrite live in ONE pass so the ordering contract
// (read-before-overwrite) can't be split apart by a later edit — the exact
// class of regression that produced #210.
const applyAdaptiveThinking = (
  payload: AnthropicMessagesPayload,
  selectedModel?: Model,
): void => {
  // Capture the client's incoming thinking intent BEFORE we overwrite
  // payload.thinking below.
  //   - incomingDisplay: an explicit `display` the client picked, if any. On
  //     Copilot-served Claude `display: "summarized"` is what SURFACES the
  //     thinking text; `{type:"adaptive"}` alone reasons silently and emits an
  //     empty thinking block. We must preserve an explicit choice and otherwise
  //     default to "summarized" (see below).
  //   - clientDisabledThinking: the client EXPLICITLY turned thinking off
  //     (`type: "disabled"`). We honor that instead of force-enabling adaptive.
  const incomingDisplay = payload.thinking?.display
  const clientDisabledThinking = payload.thinking?.type === "disabled"

  // https://platform.claude.com/docs/en/build-with-claude/extended-thinking#extended-thinking-with-tool-use
  // Using tool_choice: {"type": "any"} or tool_choice: {"type": "tool", "name": "..."} will result in an error because these options force tool use, which is incompatible with extended thinking.
  const toolChoice = payload.tool_choice
  const disableThink =
    toolChoice?.type === "any"
    || toolChoice?.type === "tool"
    || clientDisabledThinking

  if (!selectedModel?.capabilities.supports.adaptive_thinking || disableThink) {
    return
  }

  payload.thinking = {
    type: "adaptive",
  }
  // Align with vscode copilot: default `display` to "summarized" unless the
  // client explicitly picked one. On Copilot-served Claude this is what makes
  // the thinking text surface, so gating on the incoming `display` field (not
  // the presence of the whole thinking object) is what keeps "ask for
  // thinking → get thinking" holding.
  payload.thinking.display = incomingDisplay ?? "summarized"
  // claude-opus-4.7 always uses the summarized display.
  if (payload.model === "claude-opus-4.7") {
    payload.thinking.display = "summarized"
  }
  let effort = getReasoningEffortForModel(payload.model)
  if (effort === "none" || effort === "minimal") {
    effort = "low"
  }
  const reasoningEffort = selectedModel.capabilities.supports.reasoning_effort
  if (reasoningEffort && !reasoningEffort.includes(effort)) {
    // Clamp to the model's highest advertised tier. Copilot's array is ordered
    // low→high, so the last element is the ceiling (may be xhigh or max).
    effort = reasoningEffort.at(-1) as
      | "low"
      | "medium"
      | "high"
      | "xhigh"
      | "max"
  }
  payload.output_config = {
    effort: effort,
  }
}

// A single named transformation of the outbound Messages-API payload. Passes
// mutate `payload` in place (matching the existing contract) and read nothing
// beyond the payload + selected model.
type MessagesApiPass = {
  name: string
  run: (payload: AnthropicMessagesPayload, selectedModel?: Model) => void
}

// The Messages-API preprocessing pipeline, as an explicit ordered list of
// named passes. ORDER IS LOAD-BEARING and matches the wire PRD
// (docs/spec/wire/messages-wire-prd.md → "Upstream flow A"):
//   1. stripCacheControl             — drop the `scope` field + inner
//                                      tool_result cache_control Copilot rejects.
//   2. filterAssistantThinkingBlocks — drop empty/placeholder thinking blocks.
//   3. stripSamplingParams           — drop temperature/top_p/top_k that
//                                      Copilot's Bedrock-backed Claude rejects.
//   4. applyAdaptiveThinking         — enable adaptive thinking + effort; MUST
//                                      run last so it reads the client's
//                                      original thinking intent before
//                                      overwriting it (the #210 contract).
const MESSAGES_API_PASSES: ReadonlyArray<MessagesApiPass> = [
  { name: "stripCacheControl", run: (payload) => stripCacheControl(payload) },
  {
    name: "filterAssistantThinkingBlocks",
    run: (payload) => filterAssistantThinkingBlocks(payload),
  },
  {
    name: "stripSamplingParams",
    run: (payload, selectedModel) =>
      stripSamplingParams(payload, selectedModel),
  },
  {
    name: "applyAdaptiveThinking",
    run: (payload, selectedModel) =>
      applyAdaptiveThinking(payload, selectedModel),
  },
]

export const prepareMessagesApiPayload = (
  payload: AnthropicMessagesPayload,
  selectedModel?: Model,
): void => {
  for (const pass of MESSAGES_API_PASSES) {
    pass.run(payload, selectedModel)
  }
}
