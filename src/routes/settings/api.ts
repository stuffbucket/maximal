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

import { Hono } from "hono"

import { BUILD_VERSION } from "~/lib/build-info"
import {
  DiagnosticsResponse,
  type DiagnosticsResponse as DiagnosticsResponseT,
} from "~/lib/settings-types"
import { state } from "~/lib/state"
import { getGitVersion, shortSha } from "~/lib/version"

import { accountsRoutes } from "./accounts"
import { apiKeysRoutes } from "./api-keys"
import { appsRoutes } from "./apps"
import { authRoutes } from "./auth"
import { clientsRoutes } from "./clients"
import { eventsRoutes } from "./events"
import { ghRoutes } from "./gh"

/** Captured once at module load. process.uptime() works too, but
 *  this anchors uptime to "when the route module first ran" rather
 *  than "when bun started," which is closer to what users mean by
 *  "how long has the proxy been up." */
const PROCESS_START_MS = Date.now()

function buildDiagnostics(): DiagnosticsResponseT {
  const git = getGitVersion()
  return {
    version: BUILD_VERSION,
    source_revision: git.sha ? shortSha(git.sha) : null,
    source_branch: git.branch ?? null,
    pid: process.pid,
    uptime_ms: Date.now() - PROCESS_START_MS,
    account_type: state.accountType,
    models_cached: state.models?.data.length ?? 0,
    tokens: {
      github_token_present: state.githubToken !== undefined,
      copilot_token_present: state.copilotToken !== undefined,
    },
    rate_limit: {
      interval_seconds: state.rateLimitSeconds ?? null,
      last_request_at:
        state.lastRequestTimestamp ?
          new Date(state.lastRequestTimestamp).toISOString()
        : null,
      wait_when_throttled: state.rateLimitWait,
    },
  }
}

export const settingsApiRoutes = new Hono()

settingsApiRoutes.get("/diagnostics", (c) => {
  const payload = buildDiagnostics()
  // Schema-validate before responding: drift between the runtime
  // shape and the published contract should fail loudly in tests,
  // not silently in the UI.
  const parsed = DiagnosticsResponse.safeParse(payload)
  if (!parsed.success) {
    return c.json(
      {
        error: {
          message: "Diagnostics payload failed schema validation",
          type: "internal_error",
          details: parsed.error.issues,
        },
      },
      500,
    )
  }
  return c.json(parsed.data)
})

settingsApiRoutes.route("/auth/github", authRoutes)
settingsApiRoutes.route("/gh", ghRoutes)
settingsApiRoutes.route("/accounts", accountsRoutes)
settingsApiRoutes.route("/api-keys", apiKeysRoutes)
settingsApiRoutes.route("/clients", clientsRoutes)
settingsApiRoutes.route("/apps", appsRoutes)
settingsApiRoutes.route("/events", eventsRoutes)
