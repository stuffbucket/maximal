/**
 * /settings/api/apps — wire downstream tools to talk to the proxy.
 *
 * Auth-gated by the parent `/settings/api` middleware. Persistence is
 * `config.apps`, round-tripped through `writeConfig()`.
 */

import type { Context } from "hono"

import { Hono } from "hono"

import { getAllApps, getApp } from "~/apps/registry"
import { getConfig, writeConfig, type AppConfig } from "~/lib/config"
import { forwardError, HTTPError } from "~/lib/error"
import {
  AppEntry,
  AppsListResponse,
  ClaudeCodeToggleRequest,
  ClaudeDesktopToggleRequest,
  type AppEntry as AppEntryT,
} from "~/lib/settings-types"

/** Build an HTTPError whose body is a plain message, so `forwardError`
 *  surfaces a clean `{ error: { message } }` at the given status. */
function httpError(message: string, status: number): HTTPError {
  return new HTTPError(message, new Response(message, { status }))
}

/** Validate a single app object against the contract before returning
 *  it, so drift fails loudly in tests rather than silently in the UI. */
function jsonApp(c: Context, app: AppEntryT) {
  const parsed = AppEntry.safeParse(app)
  if (!parsed.success) {
    return c.json(
      {
        error: {
          message: "App payload failed schema validation",
          type: "internal_error",
          details: parsed.error.issues,
        },
      },
      500,
    )
  }
  return c.json(parsed.data)
}

/** Merge an `apps.claudeCode` patch into config and persist. */
function persistClaudeCode(patch: { enabled?: boolean }): void {
  const config: AppConfig = getConfig()
  writeConfig({
    ...config,
    apps: {
      ...config.apps,
      claudeCode: {
        ...config.apps?.claudeCode,
        ...patch,
      },
    },
  })
}

function persistClaudeDesktop(enabled: boolean): void {
  const config: AppConfig = getConfig()
  writeConfig({
    ...config,
    apps: {
      ...config.apps,
      claudeDesktop: {
        ...config.apps?.claudeDesktop,
        enabled,
      },
    },
  })
}

export const appsRoutes = new Hono()

appsRoutes.get("/", async (c) => {
  try {
    const appsPayloads = await Promise.all(
      getAllApps().map((app) => app.getDetails()),
    )
    const payload = {
      apps: appsPayloads,
    }
    const parsed = AppsListResponse.safeParse(payload)
    if (!parsed.success) {
      return c.json(
        {
          error: {
            message: "Apps payload failed schema validation",
            type: "internal_error",
            details: parsed.error.issues,
          },
        },
        500,
      )
    }
    return c.json(parsed.data)
  } catch (error) {
    return forwardError(c, error)
  }
})

appsRoutes.post("/claude-code/toggle", async (c) => {
  try {
    const body: unknown = await c.req.json().catch(() => null)
    const parsed = ClaudeCodeToggleRequest.safeParse(body)
    if (!parsed.success) {
      throw httpError("Expected { enabled: boolean }", 400)
    }

    const app = getApp("claude-code")
    if (!app) throw httpError("App not found", 404)

    if (parsed.data.enabled) {
      const isInstalled = await app.detect()
      if (!isInstalled) {
        throw httpError(
          "No Claude Code install detected. Install it first, then enable routing.",
          409,
        )
      }
      const result = await app.enable()
      const conflict = result.conflict || null
      persistClaudeCode({ enabled: true })
      return jsonApp(c, await app.getDetails(conflict))
    }

    await app.disable()
    persistClaudeCode({ enabled: false })
    return jsonApp(c, await app.getDetails())
  } catch (error) {
    return forwardError(c, error)
  }
})

appsRoutes.post("/claude-desktop/toggle", async (c) => {
  try {
    const body: unknown = await c.req.json().catch(() => null)
    const parsed = ClaudeDesktopToggleRequest.safeParse(body)
    if (!parsed.success) {
      throw httpError("Expected { enabled: boolean }", 400)
    }

    const app = getApp("claude-desktop")
    if (!app) throw httpError("App not found", 404)

    await (parsed.data.enabled ? app.enable() : app.disable())
    persistClaudeDesktop(parsed.data.enabled)

    return jsonApp(c, await app.getDetails())
  } catch (error) {
    return forwardError(c, error)
  }
})
