/**
 * The built-in web tools as a server-tool provider.
 *
 * `web_search` and `web_fetch` stay in core (they are not a plugin), but they
 * are offered the same way as any other server tool: as listings the planner
 * picks from. Their behaviour is the original web-tools behaviour:
 * `when-client-declares`, rendered as Anthropic's own server-tool blocks, with
 * per-request `max_uses` and domain policy from the client's declaration.
 */

import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"

import {
  ANONYMOUS_REQUEST,
  planServerTools,
  type ServerToolRequest,
} from "../server-tools/plan"
import {
  type ServerToolListing,
  type ServerToolPlan,
  type ServerToolRun,
} from "../server-tools/types"
import {
  buildResultBlockForOutcome,
  buildToolResultMessage,
  executeToolUse,
} from "./exec"
import { type Executor } from "./executor"
import { WEB_FETCH_SHIM, WEB_SEARCH_SHIM, type WebToolPolicy } from "./rewriter"
import { newRequestState } from "./state"
import { type ToolName } from "./vocab"

/** Who provides the built-in web tools. */
export const WEB_TOOLS_OWNER = "maximal"

/**
 * The web tools for one request. They share one `RequestState`, so `max_uses`
 * counts across the whole loop; call this once per request.
 */
export function webToolListings(
  policy: WebToolPolicy,
  executor: Executor,
): Array<ServerToolListing> {
  const state = newRequestState(policy.declarations)
  const run: ServerToolListing["run"] = async (toolUse) => {
    const outcome = await executeToolUse(
      toolUse as typeof toolUse & { name: ToolName },
      executor,
      state,
    )
    const result: ServerToolRun = {
      toolResult: buildToolResultMessage(toolUse.id, outcome),
      clientBlock: buildResultBlockForOutcome(toolUse.id, outcome),
      ok: outcome.ok,
      ...(outcome.ok ? {} : { code: outcome.code }),
    }
    return result
  }
  return [
    {
      ...WEB_FETCH_SHIM,
      owner: WEB_TOOLS_OWNER,
      render: "anthropic-web-fetch",
      offer: "when-client-declares",
      clients: [],
      run,
    },
    {
      ...WEB_SEARCH_SHIM,
      owner: WEB_TOOLS_OWNER,
      render: "anthropic-web-search",
      offer: "when-client-declares",
      clients: [],
      run,
    },
  ]
}

/** The names the client declared, as the planner's `declared` set. */
export function declaredWebToolNames(policy: WebToolPolicy): Set<string> {
  return new Set(policy.declarations.map((declaration) => declaration.name))
}

/** A plan with only the web tools the client declared (what the loop did
 *  before server tools existed). */
export function planWebTools(input: {
  payload: Pick<AnthropicMessagesPayload, "tools" | "tool_choice">
  policy: WebToolPolicy
  executor: Executor
  request?: ServerToolRequest
}): ServerToolPlan {
  return planServerTools({
    payload: input.payload,
    listings: webToolListings(input.policy, input.executor),
    declared: declaredWebToolNames(input.policy),
    request: input.request ?? ANONYMOUS_REQUEST,
    logger: { warn: () => {} },
  })
}
