/**
 * /settings/api/apps — wire downstream tools to talk to the proxy.
 *
 * Three app kinds:
 *   - claude-code   (shimmable): detect every `claude` CLI install and
 *                   install/remove a shim (in `~/.local/share/maximal/
 *                   shims/`, named `claude`) that routes plain `claude` through the proxy.
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
import path from "node:path"

import {
  detectClaudeInstalls,
  installClaudeShim,
  isShimInstalled,
  readShimTarget,
  removeClaudeShim,
} from "~/lib/claude-cli-detect"
import {
  alreadyConfigured,
  applyProxyConfig,
  getClaudeDesktopConfigPath,
  readClaudeDesktopConfig,
  revertProxyConfig,
} from "~/lib/claude-desktop-config"
import { getConfig, writeConfig, type AppConfig } from "~/lib/config"
import { forwardError, HTTPError } from "~/lib/error"
import { getConfiguredApiKeys } from "~/lib/request-auth"
import {
  AppEntry,
  AppsListResponse,
  ClaudeCodeSelectRequest,
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

/**
 * The Maximal API key the shim should inject, or undefined when none is
 * configured. Picks the first enabled key that is not the "*" wildcard
 * (the wildcard accepts any bearer, so there's nothing meaningful to
 * inject for it).
 */
function resolveShimApiKey(): string | undefined {
  return getConfiguredApiKeys().find((k) => k !== "*")
}

/** Is Claude Desktop present? True when its config directory exists or
 *  the macOS app bundle is installed. */
function claudeDesktopInstalled(): boolean {
  const configDir = path.dirname(getClaudeDesktopConfigPath())
  if (fs.existsSync(configDir)) return true
  return fs.existsSync("/Applications/Claude.app")
}

function buildClaudeCodeApp(): AppEntryT {
  const installs = detectClaudeInstalls()
  const selectedPath = getConfig().apps?.claudeCode?.selectedPath
  const shimTarget = readShimTarget()
  const shimInstalled = isShimInstalled()

  return {
    id: "claude-code",
    name: "Claude Code",
    kind: "shimmable",
    enabled: shimInstalled,
    status: installs.length > 0 ? "ready" : "not-installed",
    installs: installs.map((i) => ({
      path: i.path,
      version: i.version,
      source: i.source,
      active: i.path === shimTarget || i.path === selectedPath,
    })),
    install:
      installs.length === 0 ?
        { method: "curl", command: CLAUDE_CODE_INSTALL_COMMAND }
      : null,
  }
}

function buildClaudeDesktopApp(): AppEntryT {
  const installed = claudeDesktopInstalled()
  const configured = alreadyConfigured(readClaudeDesktopConfig())
  return {
    id: "claude-desktop",
    name: "Claude Desktop",
    kind: "config",
    enabled: configured,
    status: installed ? "ready" : "not-installed",
    installs: [],
    install: null,
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
function persistClaudeCode(patch: {
  enabled?: boolean
  selectedPath?: string
}): void {
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
      throw httpError("Expected { enabled: boolean, path?: string }", 400)
    }

    if (parsed.data.enabled) {
      const selectedPath = getConfig().apps?.claudeCode?.selectedPath
      const firstInstall = detectClaudeInstalls()[0]?.path
      const target = parsed.data.path ?? selectedPath ?? firstInstall
      if (!target) {
        throw httpError(
          "No Claude Code install detected. Install it first, then enable the shim.",
          409,
        )
      }
      installClaudeShim(target, { apiKey: resolveShimApiKey() })
      persistClaudeCode({ enabled: true, selectedPath: target })
    } else {
      removeClaudeShim()
      persistClaudeCode({ enabled: false })
    }

    return jsonApp(c, buildClaudeCodeApp())
  } catch (error) {
    return forwardError(c, error)
  }
})

appsRoutes.post("/claude-code/select", async (c) => {
  try {
    const body: unknown = await c.req.json().catch(() => null)
    const parsed = ClaudeCodeSelectRequest.safeParse(body)
    if (!parsed.success) {
      throw httpError("Expected { path: string }", 400)
    }

    const installs = detectClaudeInstalls()
    const match = installs.find((i) => i.path === parsed.data.path)
    if (!match) {
      throw httpError(
        "Path is not one of the detected Claude Code installs.",
        400,
      )
    }

    if (isShimInstalled()) {
      installClaudeShim(match.path, { apiKey: resolveShimApiKey() })
    }
    persistClaudeCode({ selectedPath: match.path })

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
      applyProxyConfig()
    } else {
      revertProxyConfig()
    }
    persistClaudeDesktop(parsed.data.enabled)

    return jsonApp(c, buildClaudeDesktopApp())
  } catch (error) {
    return forwardError(c, error)
  }
})
