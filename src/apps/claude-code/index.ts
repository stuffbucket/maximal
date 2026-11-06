import type { AppEntry } from "~/lib/config/settings-types"

import { claudeCodePluginClient } from "~/lib/plugins/clients/claude-code"
import {
  releasePluginClientOffline,
  syncPluginClient,
} from "~/lib/plugins/clients/sync"
import { notifyPluginsChanged } from "~/lib/plugins/runtime"

import type { AppUninstallResult, ClientApp } from "../index"

import {
  isProxyBaseUrlConfigured,
  applyProxyBaseUrl,
  revertProxyBaseUrl,
  getClaudeCodeSettingsPath,
  HELPER_LABEL,
} from "./config"
import { detectClaudeInstalls } from "./detect"
import { claudeCodeInstallHint } from "./install"
import {
  reconcileClaudeCodeOnBoot,
  reconcileClaudeCodeOnShutdown,
  setClaudeCodeRoutingIntent,
} from "./reconcile"

export const claudeCodeApp: ClientApp = {
  id: "claude-code",
  name: "Claude Code",
  kind: "config",
  apiKeyLabel: HELPER_LABEL,

  async detect() {
    const installs = await detectClaudeInstalls()
    return installs.length > 0
  },

  async getDetails(conflict: AppEntry["conflict"] = null): Promise<AppEntry> {
    const installs = await detectClaudeInstalls()
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
      install: installs.length === 0 ? await claudeCodeInstallHint() : null,
      conflict,
    }
  },

  async enable() {
    const result = applyProxyBaseUrl()
    const conflict =
      (
        result.skippedReason === "foreign-base-url"
        || result.skippedReason === "foreign-api-key-helper"
      ) ?
        result.skippedReason
      : null
    const success = result.wrote || result.skippedReason === "already-ours"
    // Persist intent only after settings are usable. In particular, a missing
    // API key must not leave boot reconciliation enabled for a route we could
    // not configure.
    if (success) {
      setClaudeCodeRoutingIntent(true)
      // Restore the plugin MCP servers the user chose for Claude Code.
      await syncPluginClient(claudeCodePluginClient)
      // Connectors list Claude Code as a client only while routing is on.
      notifyPluginsChanged()
    }
    return { success, conflict }
  },

  async disable() {
    const result = revertProxyBaseUrl()
    setClaudeCodeRoutingIntent(false)
    await syncPluginClient(claudeCodePluginClient, { active: false })
    notifyPluginsChanged()
    return { success: result.wrote }
  },

  uninstall(): Promise<AppUninstallResult> {
    // Ownership-guarded: removes only the ANTHROPIC_BASE_URL block and the
    // plugin MCP servers we wrote, no-op when absent or foreign. The
    // installer PATH block is maximal's own artifact (not an app
    // integration), so the uninstaller handles that.
    const reverted: Array<string> = []
    const result = revertProxyBaseUrl()
    if (result.wrote) {
      reverted.push(`reverted ${getClaudeCodeSettingsPath()}`)
    }
    const mcp = releasePluginClientOffline(claudeCodePluginClient)
    if (mcp.removed.length > 0) {
      reverted.push(`removed our MCP servers: ${mcp.removed.join(", ")}`)
    }
    return Promise.resolve({ reverted })
  },

  isEnabled() {
    return isProxyBaseUrlConfigured()
  },

  onBoot() {
    reconcileClaudeCodeOnBoot()
  },

  onShutdown() {
    reconcileClaudeCodeOnShutdown()
  },
}
