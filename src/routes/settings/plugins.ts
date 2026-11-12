/**
 * `/settings/api/plugins` — Settings → Integrations → Connectors.
 * Wire contract: `src/lib/config/settings-types.ts` (Plugins / Connectors).
 *
 *   GET    /                          → { plugins: PluginView[] }
 *   GET    /:id                       → PluginDetailView
 *   PATCH  /:id                       { enabled?, clients?, config? } → PluginDetailView
 *   PUT    /:id/tool-permissions      { permissions } → PluginDetailView
 *   POST   /:id/actions/:actionId     → 202 { ok: true }
 *
 * PATCH validates and writes `config` to the plugin's settings file first
 * (the plugin's own `Config` rejects ⇒ 400 with `issues`, nothing changed),
 * then persists `enabled` / `clients` to `config.json` → `plugins.<id>`,
 * starts/stops/reloads the plugin to match and updates client MCP entries
 * before answering. PUT tool-permissions writes the settings file only (no
 * reload); the MCP projection hides blocked tools and tells clients the
 * list changed. An action (sign in, accept terms) can take minutes, so POST
 * answers as soon as the plugin has accepted it; how it goes arrives
 * through the plugin's status (`plugins.changed` on the events stream).
 * 404 for an unknown plugin or action, 409 when the plugin isn't running
 * or its settings file can't be read.
 */

import type { Context } from "hono"
import type { z } from "zod"

import {
  isPluginGatewayError,
  type PluginGateway,
  type PluginGatewayError,
} from "@stuffbucket/maximal-plugin-sdk/gateway"
import consola from "consola"
import { Hono } from "hono"

import {
  PluginActionResponse,
  PluginDetailView,
  PluginsListResponse,
  PluginToolPermissionsRequest,
  PluginUpdateRequest,
  type PluginValidationIssue,
} from "~/lib/config/settings-types"
import { getPluginGateway } from "~/lib/plugins/gateway"
import {
  applyPluginSettings,
  notifyPluginsChanged,
  syncPluginClients,
} from "~/lib/plugins/runtime"
import { updatePluginEntry } from "~/lib/plugins/settings"
import { listPluginViews, pluginDetailView } from "~/lib/plugins/view"

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

/** 400 `PluginValidationErrorResponse`: the issues, and one sentence
 *  joining them for generic display. */
function validationError(
  c: Context,
  issues: ReadonlyArray<PluginValidationIssue>,
): Response {
  const message = issues
    .map((issue) =>
      issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`,
    )
    .join("; ")
  return c.json(
    {
      error: { message, type: ERROR_TYPES[400] },
      issues: [...issues],
    },
    400,
  )
}

function zodIssues(error: z.ZodError): Array<PluginValidationIssue> {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }))
}

function prefixed(prefix: string, path: string): string {
  return path === "" ? prefix : `${prefix}.${path}`
}

function pluginNotFound(c: Context, id: string): Response {
  return apiError(c, 404, `Unknown plugin "${id}".`)
}

/** Map a gateway refusal of a settings write to a response. */
function settingsWriteError(
  c: Context,
  error: PluginGatewayError,
  field: "config" | "permissions",
): Response {
  switch (error.code) {
    case "unknown-plugin": {
      return pluginNotFound(c, error.pluginId)
    }
    case "invalid-config":
    case "invalid-permissions": {
      const issues = error.issues ?? []
      return validationError(
        c,
        issues.length > 0 ?
          issues.map((issue) => ({
            path: prefixed(field, issue.path),
            message: issue.message,
          }))
        : [{ path: field, message: error.message }],
      )
    }
    default: {
      return apiError(c, 409, error.message)
    }
  }
}

async function readJson(
  c: Context,
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await c.req.json() }
  } catch {
    return { ok: false }
  }
}

async function respondDetail(
  c: Context,
  gateway: PluginGateway,
  id: string,
): Promise<Response> {
  const view = await pluginDetailView(gateway, id)
  if (!view) return pluginNotFound(c, id)
  return respondValidated(
    c,
    { schema: PluginDetailView, label: "plugin" },
    view,
  )
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
  // Claude Code's config may have changed outside Maximal (the user added or
  // removed their own Work IQ, say); catch up before showing it. Cheap.
  syncPluginClients()
  return respondValidated(
    c,
    { schema: PluginsListResponse, label: "plugins list" },
    await listPluginViews(gateway),
  )
})

pluginsRoutes.get("/:id", async (c) => {
  const id = c.req.param("id")
  const gateway = getPluginGateway()
  if (!gateway) return apiError(c, 503, "Plugins are not running.")
  syncPluginClients()
  return respondDetail(c, gateway, id)
})

pluginsRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id")
  const gateway = getPluginGateway()
  if (!gateway) {
    return apiError(c, 503, "Plugins are not running.")
  }
  if (!gateway.get(id)) return pluginNotFound(c, id)

  const json = await readJson(c)
  if (!json.ok) return apiError(c, 400, "Body must be JSON.")
  const parsed = PluginUpdateRequest.safeParse(json.body)
  if (!parsed.success) return validationError(c, zodIssues(parsed.error))
  const { config, ...entry } = parsed.data

  if (config !== undefined) {
    try {
      // Validates against the plugin's own `Config`, writes the settings
      // file and reloads the plugin when it runs and the config changed.
      await gateway.updateConfig(id, config)
    } catch (error) {
      if (isPluginGatewayError(error)) {
        return settingsWriteError(c, error, "config")
      }
      throw error
    }
  }
  if (entry.enabled !== undefined || entry.clients !== undefined) {
    updatePluginEntry(id, entry)
    await applyPluginSettings()
  }
  notifyPluginsChanged()
  return respondDetail(c, gateway, id)
})

pluginsRoutes.put("/:id/tool-permissions", async (c) => {
  const id = c.req.param("id")
  const gateway = getPluginGateway()
  if (!gateway) {
    return apiError(c, 503, "Plugins are not running.")
  }
  if (!gateway.get(id)) return pluginNotFound(c, id)

  const json = await readJson(c)
  if (!json.ok) return apiError(c, 400, "Body must be JSON.")
  const parsed = PluginToolPermissionsRequest.safeParse(json.body)
  if (!parsed.success) return validationError(c, zodIssues(parsed.error))

  try {
    await gateway.setToolPermissions(id, parsed.data.permissions)
  } catch (error) {
    if (isPluginGatewayError(error)) {
      return settingsWriteError(c, error, "permissions")
    }
    throw error
  }
  return respondDetail(c, gateway, id)
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
