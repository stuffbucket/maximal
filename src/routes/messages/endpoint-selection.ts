/**
 * Which Copilot endpoint serves a resolved `/v1/messages` model. Shared by the
 * main dispatch in `handler.ts` and the web-tools turn transport, so the two
 * can't disagree about what "uses the Messages API" means.
 */

import type { Model } from "~/services/copilot/get-models"

import { isMessagesApiEnabled } from "~/lib/config/config"

const RESPONSES_ENDPOINT = "/responses"
const MESSAGES_ENDPOINT = "/v1/messages"

export const shouldUseResponsesApi = (
  selectedModel: Model | undefined,
): boolean =>
  selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false

/** Requires the `useMessagesApi` config flag (default on) and the model's
 *  catalog entry to list `/v1/messages`. */
export const shouldUseMessagesApi = (
  selectedModel: Model | undefined,
): boolean => {
  if (!isMessagesApiEnabled()) return false
  return (
    selectedModel?.supported_endpoints?.includes(MESSAGES_ENDPOINT) ?? false
  )
}
