/**
 * Settings data API — `/settings/api/*`.
 *
 * Distinct from `/_debug/state`:
 * - Stable, schema-validated contract (src/lib/settings-types.ts).
 * - Always auth-gated (NOT in allowUnauthenticatedPaths); see the
 *   note in server.ts. The static Settings bundle, when/if mounted
 *   under `/settings/*`, can be unauthenticated for HTML/CSS/JS, but
 *   every data endpoint under `/settings/api/*` requires `x-api-key`
 *   or `Authorization: Bearer`. This prevents any local process from
 *   reading token presence by simply hitting the unauth prefix.
 *
 * Auth design choice (Option A from the Phase 1 brief): keep the
 * static bundle's `/settings` prefix unauthenticated *only* when we
 * eventually mount it, and rely on standard middleware coverage for
 * `/settings/api/*` by NOT adding `/settings/api` to the unauth
 * allowlist. This costs zero new code in request-auth.ts.
 */

import consola from "consola"
import { Hono } from "hono"

import { describeExecutor } from "~/debug"
import {
  DiagnosticsResponse,
  type DiagnosticsResponse as DiagnosticsResponseT,
  UpdateStatusResponse,
  type UpdateStatusResponse as UpdateStatusResponseT,
} from "~/lib/config/settings-types"
import { describeLaunchSource } from "~/lib/platform/cli-path"
import { modelsCached, state, tokenPresence } from "~/lib/runtime-state/state"
import { BUILD_VERSION } from "~/lib/update/build-info"
import { getUpdateStatus } from "~/lib/update/update-check"
import { getGitVersion, shortSha } from "~/lib/update/version"

import { accountsRoutes } from "./accounts"
import { apiKeysRoutes } from "./api-keys"
import { appsRoutes } from "./apps"
import { authRoutes } from "./auth"
import { clientsRoutes } from "./clients"
import { eventsRoutes } from "./events"
import { ghRoutes } from "./gh"
import { modelsRoutes } from "./models"
import { respondValidated } from "./respond-validated"
import { uiRoutes } from "./ui"

/** Captured once at module load. process.uptime() works too, but
 *  this anchors uptime to "when the route module first ran" rather
 *  than "when bun started," which is closer to what users mean by
 *  "how long has the proxy been up." */
const PROCESS_START_MS = Date.now()

function buildDiagnostics(): DiagnosticsResponseT {
  const git = getGitVersion()
  const launch = describeLaunchSource()
  const tokens = tokenPresence()
  return {
    version: BUILD_VERSION,
    source_revision: git.sha ? shortSha(git.sha) : null,
    source_branch: git.branch ?? null,
    launch_path: launch.path,
    launch_kind: launch.kind,
    pid: process.pid,
    uptime_ms: Date.now() - PROCESS_START_MS,
    account_type: state.accountType,
    models_cached: modelsCached(),
    tokens: {
      github_token_present: tokens.github,
      copilot_token_present: tokens.copilot,
    },
    rate_limit: {
      interval_seconds: state.rateLimitSeconds ?? null,
      last_request_at:
        state.lastRequestTimestamp ?
          new Date(state.lastRequestTimestamp).toISOString()
        : null,
      wait_when_throttled: state.rateLimitWait,
    },
    web_search: buildWebSearchStatus(),
  }
}

/** Map the executor describeExecutor() would pick to the diagnostics
 *  contract. `base` (the /responses model or Ollama host) is the more
 *  useful detail when present; else `notes` (the no-key explanation). */
function buildWebSearchStatus(): DiagnosticsResponseT["web_search"] {
  const executor = describeExecutor()
  return {
    kind: executor.web_tools,
    detail: executor.base ?? executor.notes ?? null,
  }
}

export const settingsApiRoutes = new Hono()

settingsApiRoutes.get("/diagnostics", (c) => {
  const payload = buildDiagnostics()
  // Schema-validate before responding: drift between the runtime
  // shape and the published contract should fail loudly in tests,
  // not silently in the UI.
  return respondValidated(
    c,
    { schema: DiagnosticsResponse, label: "Diagnostics" },
    payload,
  )
})

settingsApiRoutes.get("/update-status", async (c) => {
  const payload = await getUpdateStatus()
  const parsed = UpdateStatusResponse.safeParse(payload)
  if (!parsed.success) {
    // getUpdateStatus is contractually total (never throws, always the right
    // shape), so a parse failure here means a code-level contract break, not a
    // runtime update problem. The update mechanism must "be patient" and never
    // push an error at the user — so don't 500. Log it and return a coherent
    // payload that degrades the Settings row to a quiet "unknown".
    consola.warn(
      "update-status payload failed schema validation:",
      parsed.error.issues,
    )
    return c.json({
      current: payload.current,
      latest: null,
      update_available: false,
      url: payload.url,
      enabled: false,
      checked_at: null,
      last_error: "update-status payload malformed",
    } satisfies UpdateStatusResponseT)
  }
  return c.json(parsed.data)
})

settingsApiRoutes.route("/auth/github", authRoutes)
settingsApiRoutes.route("/gh", ghRoutes)
settingsApiRoutes.route("/accounts", accountsRoutes)
settingsApiRoutes.route("/api-keys", apiKeysRoutes)
settingsApiRoutes.route("/clients", clientsRoutes)
settingsApiRoutes.route("/apps", appsRoutes)
settingsApiRoutes.route("/models", modelsRoutes)
settingsApiRoutes.route("/events", eventsRoutes)
settingsApiRoutes.route("/ui", uiRoutes)
