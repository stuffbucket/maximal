/**
 * The plan step for one `/v1/messages` request, wired to the running app:
 * the built-in web tools, the plugins' server tools (through the plugin
 * gateway) and who is asking.
 */

import type { PluginGateway } from "@stuffbucket/maximal-plugin-sdk/gateway"
import type { ConsolaInstance } from "consola"

import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"

import { requestContext } from "~/lib/http/request-context"
import { getPluginGateway } from "~/lib/plugins/gateway"
import { deriveUsageClient } from "~/lib/token-usage/client"

import type { Executor } from "../web-tools/executor"
import type { WebToolPolicy } from "../web-tools/rewriter"
import type { ServerToolPlan } from "./types"

import { selectExecutor } from "../web-tools/executor"
import { declaredWebToolNames, webToolListings } from "../web-tools/listings"
import { planServerTools } from "./plan"
import { pluginServerToolListings } from "./plugin-listings"

export interface RequestServerToolsInput {
  payload: AnthropicMessagesPayload
  /** From `splitWebTools`: the web tools the client declared. */
  webPolicy: WebToolPolicy
  sessionId?: string
  /** A compaction or auto-continue request. */
  compact: boolean
  /** Aborts when the client goes away. */
  signal: AbortSignal
  logger: ConsolaInstance
  /** The running plugin gateway; defaults to the app's. */
  gateway?: PluginGateway
  /** Runs the web tools the client declared; defaults to the configured one. */
  executor?: Executor
}

/** Which client sent the current request, as `UsageClient` names it. */
function currentClient(): string {
  const store = requestContext.getStore()
  return store ?
      deriveUsageClient(store.usage.apiKeyLabel, store.userAgent)
    : "other"
}

/** The server tools this request offers the model. Call it after the request
 *  was classified (warmups answered, compaction known) and before the
 *  payload's tools are read for anything else. Does not touch the payload:
 *  the loop adds the declarations. */
export function planServerToolsForRequest(
  input: RequestServerToolsInput,
): ServerToolPlan {
  const { payload, webPolicy, logger } = input
  const webListings =
    webPolicy.declarations.length > 0 ?
      webToolListings(webPolicy, input.executor ?? selectExecutor())
    : []
  return planServerTools({
    payload,
    listings: [
      ...webListings,
      ...pluginServerToolListings(
        input.gateway ?? getPluginGateway(),
        (view) => {
          logger.debug(
            `server tool "${view.name}" from ${view.pluginId} not offered: render "${view.render}" is not supported for plugin tools`,
          )
        },
      ),
    ],
    declared: declaredWebToolNames(webPolicy),
    request: {
      client: currentClient(),
      model: payload.model,
      sessionId: input.sessionId,
      compact: input.compact,
      signal: input.signal,
    },
    logger,
  })
}
