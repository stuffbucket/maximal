/**
 * `/settings/api/plugins` — the Settings "Plugins" section.
 *
 *   GET    /                          → { plugins: PluginView[] }
 *   PATCH  /:id                       { enabled?, clients? } → PluginView
 *   POST   /:id/actions/:actionId     → 202 { ok: true }
 *
 * PATCH persists `config.json` → `plugins.<id>`, starts/stops the plugin to
 * match and updates client MCP entries before answering. An action (sign
 * in, accept terms) can take minutes, so POST answers as soon as the
 * plugin has accepted it; how it goes arrives through the plugin's status
 * (`plugins.changed` on the events stream). 404 for an unknown plugin or
 * action, 409 when the plugin isn't running.
 */

import type { Context } from "hono"

import { isPluginGatewayError } from "@stuffbucket/maximal-plugin-sdk/gateway"
import consola from "consola"
import { Hono } from "hono"

import {
  PluginActionResponse,
  PluginsListResponse,
  PluginUpdateRequest,
  PluginView,
} from "~/lib/config/settings-types"
import { claudeCodePluginClient } from "~/lib/plugins/clients/claude-code"
import { repairPluginClientKeys } from "~/lib/plugins/clients/sync"
import { getPluginGateway } from "~/lib/plugins/gateway"
import {
  applyPluginSettings,
  notifyPluginsChanged,
} from "~/lib/plugins/runtime"
import { updatePluginEntry } from "~/lib/plugins/settings"
import { listPluginViews, pluginView } from "~/lib/plugins/view"

import { respondValidated } from "./respond-validated"

const ERROR_TYPES = {
  400: "invalid_request_error",
  404: "not_found",
  409: "conflict",
  503: "unavailable",
} as const

function apiError(
  c: Context,
  status: keyof typeof ERROR_TYPES,
  message: string,
): Response {
  return c.json({ error: { message, type: ERROR_TYPES[status] } }, status)
}

function pluginNotFound(c: Context, id: string): Response {
  return apiError(c, 404, `Unknown plugin "${id}".`)
}

/** Resolves with the settled outcome when `promise` settles within one
 *  macrotask, else `pending`. Gateway refusals (unknown action, plugin not
 *  running) reject before the handler runs, so they arrive in time. */
async function settledSoon<T>(
  promise: Promise<T>,
): Promise<
  | { state: "fulfilled" }
  | { state: "rejected"; reason: unknown }
  | { state: "pending" }
> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = new Promise<{ state: "pending" }>((resolve) => {
    timer = setTimeout(() => resolve({ state: "pending" }), 0)
  })
  try {
    return await Promise.race([
      promise.then(
        () => ({ state: "fulfilled" as const }),
        (reason: unknown) => ({ state: "rejected" as const, reason }),
      ),
      pending,
    ])
  } finally {
    clearTimeout(timer)
  }
}

export const pluginsRoutes = new Hono()

pluginsRoutes.get("/", async (c) => {
  const gateway = getPluginGateway()
  if (!gateway) {
    return respondValidated(
      c,
      { schema: PluginsListResponse, label: "plugins list" },
      { plugins: [] },
    )
  }
  try {
    // A running Claude Code may have written back an entry it read before
    // Maximal put the key in; put it back (file-only, cheap).
    repairPluginClientKeys(claudeCodePluginClient)
  } catch (error) {
    consola.warn("Could not check the Claude Code MCP server keys", error)
  }
  return respondValidated(
    c,
    { schema: PluginsListResponse, label: "plugins list" },
    await listPluginViews(gateway),
  )
})

pluginsRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id")
  const gateway = getPluginGateway()
  if (!gateway) {
    return apiError(c, 503, "Plugins are not running.")
  }
  if (!gateway.get(id)) return pluginNotFound(c, id)

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return apiError(c, 400, "Body must be JSON.")
  }
  const parsed = PluginUpdateRequest.safeParse(body)
  if (!parsed.success) {
    return apiError(
      c,
      400,
      parsed.error.issues.map((issue) => issue.message).join("; "),
    )
  }

  updatePluginEntry(id, parsed.data)
  await applyPluginSettings()
  notifyPluginsChanged()
  const view = await pluginView(gateway, id)
  if (!view) return pluginNotFound(c, id)
  return respondValidated(c, { schema: PluginView, label: "plugin" }, view)
})

pluginsRoutes.post("/:id/actions/:actionId", async (c) => {
  const id = c.req.param("id")
  const actionId = c.req.param("actionId")
  const gateway = getPluginGateway()
  if (!gateway) {
    return apiError(c, 503, "Plugins are not running.")
  }

  // Not tied to this request: the action outlives the 202. The plugin's
  // own lifetime (stop, reload, shutdown) still aborts it.
  const run = gateway.runAction(id, actionId)
  const early = await settledSoon(run)
  if (early.state === "rejected") {
    const { reason } = early
    if (isPluginGatewayError(reason)) {
      if (reason.code === "plugin-inactive") {
        return apiError(c, 409, reason.message)
      }
      return apiError(c, 404, reason.message)
    }
    consola.warn(`Plugin action ${id}/${actionId} failed`, reason)
  } else if (early.state === "pending") {
    run.catch((error: unknown) => {
      consola.warn(`Plugin action ${id}/${actionId} failed`, error)
    })
  }
  c.status(202)
  return respondValidated(
    c,
    { schema: PluginActionResponse, label: "plugin action" },
    { ok: true },
  )
})
