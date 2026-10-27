import type { AppEntry } from "~/lib/config/settings-types"

import { syncMcpClient } from "~/lib/mcp-broker/client-sync"

import type { AppUninstallResult, ClientApp } from "../index"

import {
  isProxyBaseUrlConfigured,
  applyProxyBaseUrl,
  revertProxyBaseUrl,
  getClaudeCodeSettingsPath,
  HELPER_LABEL,
} from "./config"
import { detectClaudeInstalls } from "./detect"
import { claudeCodeMcp } from "./mcp"
import {
  reconcileClaudeCodeOnBoot,
  reconcileClaudeCodeOnShutdown,
  setClaudeCodeRoutingIntent,
} from "./reconcile"

const CLAUDE_CODE_INSTALL_COMMAND =
  "curl -fsSL https://claude.ai/install.sh | sh"

export const claudeCodeApp: ClientApp = {
  id: "claude-code",
  name: "Claude Code",
  kind: "config",
  apiKeyLabel: HELPER_LABEL,
  mcp: claudeCodeMcp,

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
      install:
        installs.length === 0 ?
          { method: "curl", command: CLAUDE_CODE_INSTALL_COMMAND }
        : null,
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
      // Restore the MCP endpoints the user chose for Claude Code.
      await syncMcpClient(claudeCodeMcp)
    }
    return { success, conflict }
  },

  async disable() {
    const result = revertProxyBaseUrl()
    setClaudeCodeRoutingIntent(false)
    await syncMcpClient(claudeCodeMcp, { active: false })
    return { success: result.wrote }
  },

  async uninstall(): Promise<AppUninstallResult> {
    // Ownership-guarded: removes only the ANTHROPIC_BASE_URL block and the MCP
    // servers we wrote, no-op when absent or foreign. The installer PATH block
    // is maximal's own artifact (not an app integration), so the uninstaller
    // handles that.
    const reverted: Array<string> = []
    const result = revertProxyBaseUrl()
    if (result.wrote) {
      reverted.push(`reverted ${getClaudeCodeSettingsPath()}`)
    }
    const mcp = await syncMcpClient(claudeCodeMcp, { active: false })
    if (mcp.removed.length > 0) {
      reverted.push(`removed our MCP servers: ${mcp.removed.join(", ")}`)
    }
    return { reverted }
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
