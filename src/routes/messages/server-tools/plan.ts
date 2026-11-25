/**
 * The plan step: which server tools this `/v1/messages` request offers the
 * model, and what the `tools` array it sends upstream gains.
 *
 * Runs once per request, after the web-tool declarations were split out
 * (`splitWebTools`) and the request was classified. The loop then treats a
 * `tool_use` of a planned tool as its own and anything else as the client's.
 */

import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"

import type {
  PlannedServerTool,
  ServerToolDeclaration,
  ServerToolListing,
  ServerToolPlan,
} from "./types"

/** What the planner needs to know about the request itself. */
export interface ServerToolRequest {
  /** Which client sent it (`claude-code`, ...); `always` tools check it. */
  client: string
  model: string
  sessionId?: string
  /** A compaction or auto-continue request: `always` tools stay out of it. */
  compact: boolean
  /** Aborts when the client goes away. */
  signal: AbortSignal
}

export interface PlanServerToolsInput {
  payload: Pick<AnthropicMessagesPayload, "tools" | "tool_choice">
  /** Everything the providers offer. Order does not matter; the plan sorts. */
  listings: ReadonlyArray<ServerToolListing>
  /** Names of the Anthropic server tools the client declared
   *  (`web_search`, `web_fetch`), from `splitWebTools`. */
  declared: ReadonlySet<string>
  request: ServerToolRequest
  logger: { warn(message: string): void }
}

const NEVER_ABORTED = new AbortController().signal

/** The request context for a plan made without a live request (the loop's
 *  own default for web tools only). */
export const ANONYMOUS_REQUEST: ServerToolRequest = {
  client: "other",
  model: "",
  compact: false,
  signal: NEVER_ABORTED,
}

/**
 * Pick the tools to offer.
 *
 * - `when-client-declares` tools: offered when the client declared the
 *   matching Anthropic server tool (this is how web search and fetch have
 *   always worked). A client tool of the same name does not stop them; the
 *   declaration is simply not added twice.
 * - `always` tools: offered when the request is not a compaction, the client
 *   is one the tool allows, the client declared at least one tool of its own
 *   (a request with none is a side call such as a title, not an agent turn),
 *   it did not turn tools off (`tool_choice: none`), and no client tool uses
 *   the name. A name collision skips ours and is logged.
 * - Subagent turns are included. Warmups never get here; `count_tokens` has
 *   its own handler.
 *
 * Pure: `payload` is only read. Apply the result with
 * {@link applyServerToolDeclarations}.
 */
// Planning keeps every offer/release branch together so lease ownership is auditable.
// eslint-disable-next-line complexity
export function planServerTools(input: PlanServerToolsInput): ServerToolPlan {
  const { payload, listings, declared, request, logger } = input
  const clientTools = payload.tools ?? []
  const clientNames = new Set(clientTools.map((tool) => tool.name))
  const agentTurn =
    !request.compact
    && payload.tool_choice?.type !== "none"
    && (clientTools.length > 0 || declared.size > 0)

  const tools = new Map<string, PlannedServerTool>()
  const declarations: Array<ServerToolDeclaration> = []
  const releases: Array<() => void> = []
  let offersAlways = false

  // Plain code-unit order: the same set of tools declares the same bytes on
  // every turn, which keeps the upstream prompt-cache prefix intact.
  const sorted = [...listings].sort(byName)
  for (const listing of sorted) {
    if (tools.has(listing.name)) {
      logger.warn(
        `server tool "${listing.name}" from ${listing.owner} skipped: ${tools.get(listing.name)?.owner} already provides it`,
      )
      listing.release?.()
      continue
    }
    if (listing.offer === "when-client-declares") {
      if (!declared.has(listing.name)) {
        listing.release?.()
        continue
      }
    } else {
      if (!agentTurn || !listing.clients.includes(request.client)) {
        listing.release?.()
        continue
      }
      if (clientNames.has(listing.name)) {
        logger.warn(
          `server tool "${listing.name}" from ${listing.owner} not offered: the client declares a tool with that name`,
        )
        listing.release?.()
        continue
      }
      offersAlways = true
    }
    tools.set(listing.name, bind(listing, request))
    if (listing.release) releases.push(listing.release)
    if (!clientNames.has(listing.name)) {
      declarations.push({
        name: listing.name,
        description: listing.description,
        input_schema: listing.input_schema,
      })
    }
  }
  let released = false
  return {
    tools,
    declarations,
    offersAlways,
    release: () => {
      if (released) return
      released = true
      for (const release of releases) release()
    },
  }
}

function byName(a: ServerToolListing, b: ServerToolListing): number {
  if (a.name < b.name) return -1
  return a.name > b.name ? 1 : 0
}

function bind(
  listing: ServerToolListing,
  request: ServerToolRequest,
): PlannedServerTool {
  return {
    name: listing.name,
    owner: listing.owner,
    render: listing.render,
    hidden: listing.render === "hidden",
    run: (toolUse) =>
      listing.run(toolUse, {
        signal: request.signal,
        sessionId: request.sessionId,
        model: request.model,
        client: request.client,
      }),
  }
}

/**
 * Add the plan's declarations after the client's own tools (so a
 * `cache_control` mark on the client's last tool still covers the same
 * prefix). Idempotent: a name already present is left alone.
 */
export function applyServerToolDeclarations(
  payload: Pick<AnthropicMessagesPayload, "tools">,
  plan: ServerToolPlan,
): void {
  if (plan.tools.size === 0) return
  const tools = payload.tools ?? []
  const present = new Set(tools.map((tool) => tool.name))
  for (const declaration of plan.declarations) {
    if (present.has(declaration.name)) continue
    // Fresh copies: later preprocessing must not edit the listing's schema.
    tools.push({
      name: declaration.name,
      description: declaration.description,
      input_schema: structuredClone(declaration.input_schema),
    })
  }
  payload.tools = tools
}
