import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"

import {
  subagentMarkerPrefix,
  type SubagentMarker,
} from "~/lib/runtime-state/subagent"

export interface GatewaySubagentHints {
  requestClass?: string
  agentType?: string
  sessionId?: string
}

const NON_INTERACTIVE_REQUEST_CLASSES = new Set([
  "subagent",
  "background",
  "speculative",
  "side_question",
])

export const parseSubagentMarkerFromFirstUser = (
  payload: AnthropicMessagesPayload,
  hints?: GatewaySubagentHints,
): SubagentMarker | null => {
  const firstUserMessage = payload.messages.find((msg) => msg.role === "user")
  if (firstUserMessage && Array.isArray(firstUserMessage.content)) {
    for (const block of firstUserMessage.content) {
      if (block.type !== "text") {
        continue
      }

      const marker = parseSubagentMarkerFromSystemReminder(block.text)
      if (marker) {
        return marker
      }
    }
  }

  return parseSubagentMarkerFromHints(hints)
}

const parseSubagentMarkerFromHints = (
  hints?: GatewaySubagentHints,
): SubagentMarker | null => {
  if (!hints) {
    return null
  }
  const requestClass = hints.requestClass?.trim().toLowerCase()
  if (requestClass === "interactive") {
    return null
  }
  const agentType = hints.agentType?.trim()
  const isNonInteractive =
    Boolean(requestClass && NON_INTERACTIVE_REQUEST_CLASSES.has(requestClass))
    || Boolean(agentType)

  if (!isNonInteractive) {
    return null
  }

  return {
    session_id: hints.sessionId ?? "gateway-hint",
    agent_id: requestClass ?? "subagent",
    agent_type: agentType || requestClass || "subagent",
  }
}

const parseSubagentMarkerFromSystemReminder = (
  text: string,
): SubagentMarker | null => {
  const startTag = "<system-reminder>"
  const endTag = "</system-reminder>"
  let searchFrom = 0

  while (true) {
    const reminderStart = text.indexOf(startTag, searchFrom)
    if (reminderStart === -1) {
      break
    }

    const contentStart = reminderStart + startTag.length
    const reminderEnd = text.indexOf(endTag, contentStart)
    if (reminderEnd === -1) {
      break
    }

    const reminderContent = text.slice(contentStart, reminderEnd)
    const markerIndex = reminderContent.indexOf(subagentMarkerPrefix)
    if (markerIndex === -1) {
      searchFrom = reminderEnd + endTag.length
      continue
    }

    const markerJson = reminderContent
      .slice(markerIndex + subagentMarkerPrefix.length)
      .trim()

    try {
      const parsed = JSON.parse(markerJson) as SubagentMarker
      if (!parsed.session_id || !parsed.agent_id || !parsed.agent_type) {
        searchFrom = reminderEnd + endTag.length
        continue
      }

      return parsed
    } catch {
      searchFrom = reminderEnd + endTag.length
      continue
    }
  }

  return null
}
