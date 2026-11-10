/**
 * Shared steps of the pass-through routes (images, decisions, SystemOne),
 * which relay a request to one Copilot endpoint and its JSON reply back
 * unchanged.
 */

import { awaitApproval } from "~/lib/http/approval"
import { checkRateLimit } from "~/lib/http/rate-limit"
import { state } from "~/lib/runtime-state/state"

/** Wait out the rate limit and, with manual approval on, ask for approval. */
export async function admitUpstreamRequest(): Promise<void> {
  await checkRateLimit(state)
  if (state.manualApprove) await awaitApproval()
}

/** The request's `model`, which token usage is recorded against (the replies
 *  name a different model or none). */
export function requestedModel(model: unknown): string {
  return typeof model === "string" ? model : ""
}
