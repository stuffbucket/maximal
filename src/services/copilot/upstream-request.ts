import consola from "consola"
import { events } from "fetch-event-stream"

import type { CompactType } from "~/lib/compact"
import type { State } from "~/lib/state"
import type { SubagentMarker } from "~/lib/subagent"

import {
  copilotHeaders,
  prepareForCompact,
  prepareInteractionHeaders,
} from "~/lib/api-config"
import { isAuthFatal, parseCopilotErrorBody } from "~/lib/copilot-error-parser"
import { logCopilotRateLimits } from "~/lib/copilot-rate-limit"
import { CopilotAuthFatalError, HTTPError } from "~/lib/error"
import {
  clearLastUpstreamRejection,
  setLastUpstreamRejection,
  state,
} from "~/lib/state"

import type { Initiator } from "./agent-initiator"

/**
 * Options shared by every member of the `create*` upstream family.
 *
 * Each endpoint extends this with its own extras (e.g. Responses adds
 * `vision`/`initiator`, Messages adds a positional `anthropicBetaHeader`), but
 * the interaction/session/compact/subagent plumbing is identical and lives
 * here so it can't drift.
 */
export interface CopilotCallOptions {
  subagentMarker?: SubagentMarker | null
  requestId: string
  sessionId?: string
  compactType?: CompactType
}

/**
 * Asserts the Copilot token is present and returns it narrowed to non-null.
 * Every builder needs this before it can construct headers.
 */
export const requireCopilotToken = (): string => {
  if (!state.copilotToken) throw new Error("Copilot token not found")
  return state.copilotToken
}

/**
 * Builds the header set shared by the three chat/message/response builders:
 * the base Copilot headers, the `x-initiator` billing header, and the
 * interaction + compact headers. Callers add endpoint-specific headers
 * (anthropic-beta, messages-proxy, …) to the returned record afterwards.
 *
 * Token attachment is deliberately NOT done here — the Authorization header is
 * attached by the single mechanism in `send-request.ts` (ADR-0001).
 */
export const buildCopilotHeaders = (
  callState: State,
  options: CopilotCallOptions & { initiator: Initiator; vision: boolean },
): Record<string, string> => {
  const headers: Record<string, string> = {
    ...copilotHeaders(callState, options.requestId, options.vision),
    "x-initiator": options.initiator,
  }

  prepareInteractionHeaders(
    options.sessionId,
    Boolean(options.subagentMarker),
    headers,
  )

  prepareForCompact(headers, options.compactType)

  return headers
}

/**
 * Shared tail of every upstream call: log rate limits, translate a non-OK
 * response into the right error (auth-fatal vs generic) while recording the
 * last upstream rejection, then either hand back the SSE stream (when the
 * payload requested streaming) or the parsed JSON body.
 *
 * `stream` is the caller's already-resolved streaming flag so this helper
 * stays agnostic to how each payload spells it.
 */
export const finishUpstreamResponse = async <T>(
  response: Response,
  { stream, errorMessage }: { stream: boolean; errorMessage: string },
): Promise<T | ReturnType<typeof events>> => {
  logCopilotRateLimits(response.headers)

  if (!response.ok) {
    consola.error(errorMessage, response)
    const body = await response.clone().text()
    const parsed = parseCopilotErrorBody(body)
    if (isAuthFatal(response.status, parsed)) {
      throw new CopilotAuthFatalError(
        parsed.message,
        response.status,
        parsed.remediationUrl,
      )
    }
    setLastUpstreamRejection({
      message: parsed.message,
      remediationUrl: parsed.remediationUrl,
      status: response.status,
    })
    throw new HTTPError(errorMessage, response)
  }

  clearLastUpstreamRejection()

  if (stream) {
    return events(response)
  }

  return (await response.json()) as T
}
