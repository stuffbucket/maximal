import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotBaseUrl } from "~/lib/api-config"
import { sendRequest } from "~/lib/send-request"
import { state } from "~/lib/state"

import type { Initiator } from "./agent-initiator"
import type { CopilotCallOptions } from "./upstream-request"

import {
  buildCopilotHeaders,
  finishUpstreamResponse,
  requireCopilotToken,
} from "./upstream-request"

export interface ResponsesPayload {
  model: string
  instructions?: string | null
  input?: string | Array<ResponseInputItem>
  tools?: Array<Tool> | null
  tool_choice?: ToolChoiceOptions | ToolChoiceFunction
  temperature?: number | null
  top_p?: number | null
  max_output_tokens?: number | null
  metadata?: Metadata | null
  stream?: boolean | null
  safety_identifier?: string | null
  prompt_cache_key?: string | null
  prompt_cache_retention?: "in_memory" | "24h" | null
  parallel_tool_calls?: boolean | null
  store?: boolean | null
  reasoning?: Reasoning | null
  context_management?: Array<ResponseContextManagementItem> | null
  include?: Array<ResponseIncludable>
  service_tier?: string | null // NOTE: Unsupported by GitHub Copilot
  [key: string]: unknown
}

export type ToolChoiceOptions = "none" | "auto" | "required"

export interface ToolChoiceFunction {
  name: string
  type: "function"
}

export type Tool = FunctionTool | Record<string, unknown>

export interface FunctionTool {
  name: string
  parameters: { [key: string]: unknown } | null
  strict: boolean | null
  type: "function"
  description?: string | null
}

export type ResponseIncludable =
  | "file_search_call.results"
  | "message.input_image.image_url"
  | "computer_call_output.output.image_url"
  | "reasoning.encrypted_content"
  | "code_interpreter_call.outputs"
  // Surfaces the raw searched-source URLs on web_search_call.action.sources[].
  // Verified accepted by Copilot's /responses (2026-07-03); undocumented but
  // matches OpenAI's Responses API include vocabulary.
  | "web_search_call.action.sources"

export interface Reasoning {
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | null
  summary?: "auto" | "concise" | "detailed" | null
}

export interface ResponseContextManagementCompactionItem {
  type: "compaction"
  compact_threshold: number
}

export type ResponseContextManagementItem =
  ResponseContextManagementCompactionItem

export interface ResponseInputMessage {
  type?: "message"
  role: "user" | "assistant" | "system" | "developer"
  content?: string | Array<ResponseInputContent>
  status?: string
  phase?: "commentary" | "final_answer"
}

export interface ResponseFunctionToolCallItem {
  type: "function_call"
  call_id: string
  name: string
  arguments: string
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseFunctionCallOutputItem {
  type: "function_call_output"
  call_id: string
  output: string | Array<ResponseInputContent>
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseInputReasoning {
  id?: string
  type: "reasoning"
  summary: Array<{
    type: "summary_text"
    text: string
  }>
  encrypted_content: string
}

export interface ResponseInputCompaction {
  id: string
  type: "compaction"
  encrypted_content: string
}

export type ResponseInputItem =
  | ResponseInputMessage
  | ResponseFunctionToolCallItem
  | ResponseFunctionCallOutputItem
  | ResponseInputReasoning
  | ResponseInputCompaction
  | Record<string, unknown>

export type ResponseInputContent =
  | ResponseInputText
  | ResponseInputImage
  | ResponseInputFile
  | Record<string, unknown>

export interface ResponseInputText {
  type: "input_text" | "output_text"
  text: string
}

export interface ResponseInputImage {
  type: "input_image"
  image_url?: string | null
  file_id?: string | null
  detail: "low" | "high" | "auto"
}

export interface ResponseInputFile {
  type: "input_file"
  file_data?: string | null
  file_id?: string | null
  filename?: string | null
}

export interface ResponsesResult {
  id: string
  object: "response"
  created_at: number
  model: string
  output: Array<ResponseOutputItem>
  output_text: string
  status: string
  usage?: ResponseUsage | null
  /** Copilot per-request billing (sibling of usage). */
  copilot_usage?: { total_nano_aiu?: number }
  error: ResponseError | null
  incomplete_details: IncompleteDetails | null
  instructions: string | null
  metadata: Metadata | null
  parallel_tool_calls: boolean
  temperature: number | null
  tool_choice: unknown
  tools: Array<Tool>
  top_p: number | null
}

export type Metadata = { [key: string]: string }

export interface IncompleteDetails {
  reason?: "max_output_tokens" | "content_filter"
}

export interface ResponseError {
  message: string
}

export type ResponseOutputItem =
  | ResponseOutputMessage
  | ResponseOutputReasoning
  | ResponseOutputFunctionCall
  | ResponseOutputCompaction

export interface ResponseOutputMessage {
  id: string
  type: "message"
  role: "assistant"
  status: "completed" | "in_progress" | "incomplete"
  content?: Array<ResponseOutputContentBlock>
}

export interface ResponseOutputReasoning {
  id: string
  type: "reasoning"
  summary?: Array<ResponseReasoningBlock>
  encrypted_content?: string
  status?: "completed" | "in_progress" | "incomplete"
}

export interface ResponseReasoningBlock {
  type: string
  text?: string
}

export interface ResponseOutputFunctionCall {
  id?: string
  type: "function_call"
  call_id: string
  name: string
  arguments: string
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseOutputCompaction {
  id: string
  type: "compaction"
  encrypted_content: string
}

export type ResponseOutputContentBlock =
  | ResponseOutputText
  | ResponseOutputRefusal
  | Record<string, unknown>

export interface ResponseOutputText {
  type: "output_text"
  text: string
  annotations: Array<unknown>
}

export interface ResponseOutputRefusal {
  type: "refusal"
  refusal: string
}

export interface ResponseUsage {
  input_tokens: number
  output_tokens?: number
  total_tokens: number
  input_tokens_details?: {
    cached_tokens: number
  }
  output_tokens_details?: {
    reasoning_tokens: number
  }
}

export type ResponseStreamEvent =
  | ResponseCompletedEvent
  | ResponseIncompleteEvent
  | ResponseCreatedEvent
  | ResponseErrorEvent
  | ResponseFunctionCallArgumentsDeltaEvent
  | ResponseFunctionCallArgumentsDoneEvent
  | ResponseFailedEvent
  | ResponseOutputItemAddedEvent
  | ResponseOutputItemDoneEvent
  | ResponseReasoningSummaryTextDeltaEvent
  | ResponseReasoningSummaryTextDoneEvent
  | ResponseTextDeltaEvent
  | ResponseTextDoneEvent

export interface ResponseCompletedEvent {
  response: ResponsesResult
  sequence_number: number
  type: "response.completed"
}

export interface ResponseIncompleteEvent {
  response: ResponsesResult
  sequence_number: number
  type: "response.incomplete"
}

export interface ResponseCreatedEvent {
  response: ResponsesResult
  sequence_number: number
  type: "response.created"
}

export interface ResponseErrorEvent {
  code: string | null
  message: string
  param: string | null
  sequence_number: number
  type: "error"
}

export interface ResponseFunctionCallArgumentsDeltaEvent {
  delta: string
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.function_call_arguments.delta"
}

export interface ResponseFunctionCallArgumentsDoneEvent {
  arguments: string
  item_id: string
  name: string
  output_index: number
  sequence_number: number
  type: "response.function_call_arguments.done"
}

export interface ResponseFailedEvent {
  response: ResponsesResult
  sequence_number: number
  type: "response.failed"
}

export interface ResponseOutputItemAddedEvent {
  item: ResponseOutputItem
  output_index: number
  sequence_number: number
  type: "response.output_item.added"
}

export interface ResponseOutputItemDoneEvent {
  item: ResponseOutputItem
  output_index: number
  sequence_number: number
  type: "response.output_item.done"
}

export interface ResponseReasoningSummaryTextDeltaEvent {
  delta: string
  item_id: string
  output_index: number
  sequence_number: number
  summary_index: number
  type: "response.reasoning_summary_text.delta"
}

export interface ResponseReasoningSummaryTextDoneEvent {
  item_id: string
  output_index: number
  sequence_number: number
  summary_index: number
  text: string
  type: "response.reasoning_summary_text.done"
}

export interface ResponseTextDeltaEvent {
  content_index: number
  delta: string
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.output_text.delta"
}

export interface ResponseTextDoneEvent {
  content_index: number
  item_id: string
  output_index: number
  sequence_number: number
  text: string
  type: "response.output_text.done"
}

export type ResponsesStream = ReturnType<typeof events>
export type CreateResponsesReturn = ResponsesResult | ResponsesStream

interface ResponsesRequestOptions extends CopilotCallOptions {
  vision: boolean
  initiator: Initiator
}

export const createResponses = async (
  payload: ResponsesPayload,
  { vision, initiator, ...callOptions }: ResponsesRequestOptions,
): Promise<CreateResponsesReturn> => {
  requireCopilotToken()

  const headers = buildCopilotHeaders(state, {
    ...callOptions,
    vision,
    initiator,
  })

  // service_tier is not supported by github copilot
  payload.service_tier = undefined

  consola.log(`<-- model: ${payload.model}`)

  let response = await sendRequest(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  // Defensive fallback for the Copilot/OpenAI-Responses-specific
  // prompt_cache_retention param: some model/endpoint combos have historically
  // 400'd with "Unsupported parameter: prompt_cache_retention". If that exact
  // rejection occurs, strip the field and retry the request ONCE without it, so
  // opting into cache retention is safe even where a specific endpoint rejects
  // it. Any other 400 is left to the normal error path below (not retried).
  if (
    !response.ok
    && response.status === 400
    && payload.prompt_cache_retention
  ) {
    const probeBody = await response.clone().text()
    if (isUnsupportedPromptCacheRetention(probeBody)) {
      consola.warn(
        "Copilot rejected prompt_cache_retention; retrying once without it",
      )
      delete payload.prompt_cache_retention
      response = await sendRequest(`${copilotBaseUrl(state)}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      })
    }
  }

  return finishUpstreamResponse<ResponsesResult>(response, {
    stream: Boolean(payload.stream),
    errorMessage: "Failed to create responses",
  })
}

/**
 * True if a 400 body indicates the Copilot/OpenAI-Responses endpoint rejected
 * the prompt_cache_retention param specifically (vs any other bad-request
 * cause). Matches the observed "Unsupported parameter: prompt_cache_retention"
 * shape defensively across JSON/text bodies via a substring check.
 */
export function isUnsupportedPromptCacheRetention(body: string): boolean {
  const text = body.toLowerCase()
  return (
    text.includes("prompt_cache_retention")
    && (text.includes("unsupported parameter")
      || text.includes("unknown parameter")
      || text.includes("unsupported value"))
  )
}
