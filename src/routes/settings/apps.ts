/**
 * /settings/api/apps — wire downstream tools to talk to the proxy.
 *
 * Two active app kinds:
 *   - claude-code   (config): toggle Claude Code's proxy routing by writing
 *                   `env.ANTHROPIC_BASE_URL` into `~/.claude/settings.json`
 *                   (ownership-guarded; only that one key is ever touched).
 *   - claude-desktop (config): toggle Claude Desktop's proxy config via
 *                   the existing `applyProxyConfig`/`revertProxyConfig`.
 *   - copilot-cli   (coming-soon): placeholder card, no wiring yet.
 *
 * Auth-gated by the parent `/settings/api` middleware. Persistence is
 * `config.apps`, round-tripped through `writeConfig()`.
 */

import type { Context } from "hono"

import { Hono } from "hono"
import fs from "node:fs"

import {
  type ClaudeInstall,
  detectClaudeInstalls,
} from "~/lib/claude-cli-detect"
import {
  applyProxyBaseUrl,
  isProxyBaseUrlConfigured,
  revertProxyBaseUrl,
} from "~/lib/claude-code-settings"
import {
  applyConfigLibraryProfile,
  getClaude3pDir,
  isConfigLibraryApplied,
  revertConfigLibraryProfile,
} from "~/lib/claude-desktop-3p-config"
import { getConfig, writeConfig, type AppConfig } from "~/lib/config"
import { forwardError, HTTPError } from "~/lib/error"
import {
  AppEntry,
  AppsListResponse,
  ClaudeCodeToggleRequest,
  ClaudeDesktopToggleRequest,
  type AppEntry as AppEntryT,
} from "~/lib/settings-types"

/** The official Claude Code installer command surfaced when no install
 *  is detected. */
const CLAUDE_CODE_INSTALL_COMMAND =
  "curl -fsSL https://claude.ai/install.sh | sh"

/** Build an HTTPError whose body is a plain message, so `forwardError`
 *  surfaces a clean `{ error: { message } }` at the given status. */
function httpError(message: string, status: number): HTTPError {
  return new HTTPError(message, new Response(message, { status }))
}

/** Is Claude Desktop present? True when the macOS app bundle is installed
 *  or its third-party (Claude-3p) userData dir exists. */
function claudeDesktopInstalled(): boolean {
  if (fs.existsSync("/Applications/Claude.app")) return true
  return fs.existsSync(getClaude3pDir())
}

function buildClaudeCodeApp(
  precomputedInstalls?: ReadonlyArray<ClaudeInstall>,
  conflict: AppEntryT["conflict"] = null,
): AppEntryT {
  // Detection spawns subprocesses (npm prefix, claude --version), so reuse
  // an already-computed list when the caller has one (the toggle does).
  // Detection is purely for "is claude installed?" (ready vs not-installed
  // + the install hint) — routing is via the settings.json file now, not a
  // per-binary shim, so there's no version picker / active flag.
  const installs = precomputedInstalls ?? detectClaudeInstalls()

  return {
    id: "claude-code",
    name: "Claude Code",
    kind: "config",
    enabled: isProxyBaseUrlConfigured(),
    status: installs.length > 0 ? "ready" : "not-installed",
    installs: installs.map((i) => ({
      path: i.path,
      version: i.version,
      source: i.source,
    })),
    install:
      installs.length === 0 ?
        { method: "curl", command: CLAUDE_CODE_INSTALL_COMMAND }
      : null,
    conflict,
  }
}

function buildClaudeDesktopApp(): AppEntryT {
  const installed = claudeDesktopInstalled()
  const configured = isConfigLibraryApplied()
  return {
    id: "claude-desktop",
    name: "Claude Desktop",
    kind: "config",
    enabled: configured,
    status: installed ? "ready" : "not-installed",
    installs: [],
    install: null,
    conflict: null,
  }
}

function buildCopilotCliApp(): AppEntryT {
  return {
    id: "copilot-cli",
    name: "Copilot CLI",
    kind: "coming-soon",
    enabled: false,
    status: "coming-soon",
    installs: [],
    install: null,
    conflict: null,
  }
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

appsRoutes.get("/", (c) => {
  try {
    const payload = {
      apps: [
        buildClaudeCodeApp(),
        buildClaudeDesktopApp(),
        buildCopilotCliApp(),
      ],
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

    if (parsed.data.enabled) {
      // Detection only gates "is claude installed?" — routing is via the
      // settings.json file, not a per-binary shim.
      const installs = detectClaudeInstalls()
      if (installs.length === 0) {
        throw httpError(
          "No Claude Code install detected. Install it first, then enable routing.",
          409,
        )
      }
      // Ownership-guarded write of env.ANTHROPIC_BASE_URL. If the user (or
      // another tool) already set a different base URL, applyProxyBaseUrl
      // backs off and reports it; surface that as a conflict on the card.
      const result = applyProxyBaseUrl()
      const conflict =
        result.skippedReason === "foreign-base-url" ? "foreign-base-url" : null
      persistClaudeCode({ enabled: true })
      return jsonApp(c, buildClaudeCodeApp(installs, conflict))
    }

    revertProxyBaseUrl()
    persistClaudeCode({ enabled: false })
    return jsonApp(c, buildClaudeCodeApp())
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

    if (parsed.data.enabled) {
      applyConfigLibraryProfile()
    } else {
      revertConfigLibraryProfile()
    }
    persistClaudeDesktop(parsed.data.enabled)

    return jsonApp(c, buildClaudeDesktopApp())
  } catch (error) {
    return forwardError(c, error)
  }
})
