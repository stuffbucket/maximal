/** Registry-driven Settings mutations. Each app owns its persistence and conflict rules. */
import type { Context } from "hono"

import { Hono } from "hono"
import path from "node:path"

import {
  CLAUDE_CODE_INSTALL_REFUSAL_MESSAGE,
  claudeCodeInstaller,
} from "~/apps/claude-code/install"
import { getAllApps, getApp } from "~/apps/registry"
import {
  AppEntry,
  AppsListResponse,
  AppToggleRequest,
  ClaudeCodeInstallRequest,
  ClaudeCodeInstallStatus,
  type AppEntry as AppEntryT,
} from "~/lib/config/settings-types"
import { forwardError, HTTPError } from "~/lib/errors/error"
import { armWorkingNotice, resetWorkingNotice } from "~/lib/working-notice"

import { respondValidated } from "./respond-validated"

function httpError(message: string, status: number): HTTPError {
  return new HTTPError(message, new Response(message, { status }))
}
function jsonApp(c: Context, app: AppEntryT) {
  return respondValidated(c, { schema: AppEntry, label: "App" }, app)
}
export const appsRoutes = new Hono()
appsRoutes.get("/", async (c) => {
  try {
    const apps = await Promise.all(getAllApps().map((app) => app.getDetails()))
    return respondValidated(
      c,
      { schema: AppsListResponse, label: "Apps" },
      { apps },
    )
  } catch (error) {
    return forwardError(c, error)
  }
})

function parseToggle(appId: string, body: unknown) {
  const parsed = AppToggleRequest.safeParse(body)
  if (!parsed.success)
    throw httpError(
      "Expected { enabled: boolean } and valid integration options",
      400,
    )
  const { configDirectory, adoptExisting } = parsed.data
  if (configDirectory && !path.isAbsolute(configDirectory))
    throw httpError("Choose an absolute Pi agent directory", 400)
  if (appId !== "pi" && (configDirectory || adoptExisting))
    throw httpError("These options apply only to Pi", 400)
  return parsed.data
}

appsRoutes.post("/:id/toggle", async (c) => {
  try {
    const app = getApp(c.req.param("id"))
    if (!app) throw httpError("App not found", 404)
    if (app.kind !== "config")
      throw httpError("This integration is not available yet", 409)
    const body: unknown = await c.req.json().catch(() => null)
    const { enabled, ...options } = parseToggle(app.id, body)
    if (enabled && !(await app.detect()))
      throw httpError(
        `No ${app.name} install detected. Install it first, then enable routing.`,
        409,
      )
    const result = enabled ? await app.enable(options) : await app.disable()
    if (app.id === "claude-code" || app.id === "claude-desktop") {
      if (enabled && result.success) armWorkingNotice(app.id, app.name)
      if (!enabled) resetWorkingNotice(app.id)
    }
    return jsonApp(
      c,
      await app.getDetails(
        result.conflict ?? null,
        enabled ? options : undefined,
      ),
    )
  } catch (error) {
    return forwardError(c, error)
  }
})

// Starts WinGet Claude Code install in the background. Only on the explicit
// request of the user (the body names the method); the status reports progress.
appsRoutes.post("/claude-code/install", async (c) => {
  try {
    const body: unknown = await c.req.json().catch(() => null)
    const parsed = ClaudeCodeInstallRequest.safeParse(body)
    if (!parsed.success) {
      throw httpError("Expected the install method winget", 400)
    }
    const result = await claudeCodeInstaller.start()
    if (!result.started && result.refusal !== "running") {
      throw httpError(CLAUDE_CODE_INSTALL_REFUSAL_MESSAGE[result.refusal], 409)
    }
    return respondValidated(
      c,
      { schema: ClaudeCodeInstallStatus, label: "Claude Code install" },
      result.status,
    )
  } catch (error) {
    return forwardError(c, error)
  }
})

appsRoutes.get("/claude-code/install", (c) =>
  respondValidated(
    c,
    { schema: ClaudeCodeInstallStatus, label: "Claude Code install" },
    claudeCodeInstaller.status(),
  ),
)
