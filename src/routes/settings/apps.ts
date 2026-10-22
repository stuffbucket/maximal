/**
 * /settings/api/apps — wire downstream tools to talk to the proxy.
 *
 * Auth-gated by the parent `/settings/api` middleware. Persistence is
 * `config.apps`, round-tripped through `writeConfig()`.
 */

import type { Context } from "hono"

import { Hono } from "hono"

import { getAllApps, getApp } from "~/apps/registry"
import {
  AppEntry,
  AppsListResponse,
  ClaudeCodeToggleRequest,
  CodexToggleRequest,
  ClaudeDesktopToggleRequest,
  type AppEntry as AppEntryT,
} from "~/lib/config/settings-types"
import { forwardError, HTTPError } from "~/lib/errors/error"
import { armWorkingNotice, resetWorkingNotice } from "~/lib/working-notice"

import { respondValidated } from "./respond-validated"

/** Build an HTTPError whose body is a plain message, so `forwardError`
 *  surfaces a clean `{ error: { message } }` at the given status. */
function httpError(message: string, status: number): HTTPError {
  return new HTTPError(message, new Response(message, { status }))
}

/** Validate a single app object against the contract before returning
 *  it, so drift fails loudly in tests rather than silently in the UI. */
function jsonApp(c: Context, app: AppEntryT) {
  return respondValidated(c, { schema: AppEntry, label: "App" }, app)
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
    return respondValidated(
      c,
      { schema: AppsListResponse, label: "Apps" },
      payload,
    )
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
      if (result.success) armWorkingNotice(app.id, app.name)
      // `app.enable()` is the single owner of the claude-code routing intent
      // (persists config.apps.claudeCode.enabled itself) — no separate persist.
      return jsonApp(c, await app.getDetails(conflict))
    }

    await app.disable()
    resetWorkingNotice(app.id)
    return jsonApp(c, await app.getDetails())
  } catch (error) {
    return forwardError(c, error)
  }
})

appsRoutes.post("/codex/toggle", async (c) => {
  try {
    const body: unknown = await c.req.json().catch(() => null)
    const parsed = CodexToggleRequest.safeParse(body)
    if (!parsed.success) {
      throw httpError("Expected { enabled: boolean }", 400)
    }

    const app = getApp("codex")
    if (!app) throw httpError("App not found", 404)

    if (parsed.data.enabled) {
      if (!(await app.detect())) {
        throw httpError(
          "No Codex install detected. Install it first, then enable routing.",
          409,
        )
      }
      const result = await app.enable()
      return jsonApp(c, await app.getDetails(result.conflict ?? null))
    }

    const result = await app.disable()
    return jsonApp(c, await app.getDetails(result.conflict ?? null))
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

    // `app.enable()` / `disable()` own the persisted routing intent; a
    // refused enable (someone else's gateway is applied) doesn't record it.
    if (parsed.data.enabled) {
      const result = await app.enable()
      if (!result.success) {
        return jsonApp(c, await app.getDetails(result.conflict ?? null))
      }
      armWorkingNotice(app.id, app.name)
      return jsonApp(c, await app.getDetails())
    }

    await app.disable()
    resetWorkingNotice(app.id)
    return jsonApp(c, await app.getDetails())
  } catch (error) {
    return forwardError(c, error)
  }
})
