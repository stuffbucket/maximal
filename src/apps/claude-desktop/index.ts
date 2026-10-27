import type { AppEntry } from "~/lib/config/settings-types"

import { syncMcpClient } from "~/lib/mcp-broker/client-sync"

import type { AppUninstallResult, ClientApp } from "../index"

import { claudeDesktopCli } from "./cli"
import { DESKTOP_KEY_LABEL, isConfigLibraryApplied } from "./config"
import { claudeAppInstalled } from "./detect"
import { claudeDesktopMcp } from "./mcp"
import {
  disableClaudeDesktopRouting,
  enableClaudeDesktopRouting,
  reconcileClaudeDesktopOnBoot,
} from "./reconcile"

export const claudeDesktopApp: ClientApp = {
  id: "claude-desktop",
  name: "Claude Desktop",
  kind: "config",
  apiKeyLabel: DESKTOP_KEY_LABEL,
  mcp: claudeDesktopMcp,

  detect() {
    return Promise.resolve(claudeAppInstalled())
  },

  getDetails(conflict: AppEntry["conflict"] = null): Promise<AppEntry> {
    const installed = claudeAppInstalled()
    const configured = isConfigLibraryApplied()
    return Promise.resolve({
      id: "claude-desktop",
      name: "Claude Desktop",
      kind: "config",
      enabled: configured,
      status: installed ? "ready" : "not-installed",
      installs: [],
      install: null,
      conflict,
    })
  },

  async enable() {
    const { conflict } = enableClaudeDesktopRouting()
    if (conflict) return { success: false, conflict }
    // Restore the MCP endpoints the user chose for Claude Desktop.
    await syncMcpClient(claudeDesktopMcp)
    return { success: true }
  },

  async disable() {
    disableClaudeDesktopRouting()
    await syncMcpClient(claudeDesktopMcp, { active: false })
    return { success: true }
  },

  async uninstall(): Promise<AppUninstallResult> {
    // Removes only our gateway profile and our MCP entries from the Claude
    // Desktop config, no-op when we never wired them. A profile the user
    // edited after we wrote it is left on disk.
    const reverted: Array<string> = []
    // Also clears the routing intent, so the next boot doesn't re-apply.
    const result = disableClaudeDesktopRouting()
    if (result.reverted) {
      reverted.push(`removed our gateway profile from ${result.dir}`)
    }
    for (const file of result.kept) {
      reverted.push(`left ${file} in place (it was edited after setup)`)
    }
    const mcp = await syncMcpClient(claudeDesktopMcp, { active: false })
    if (mcp.removed.length > 0) {
      reverted.push(`removed our MCP servers: ${mcp.removed.join(", ")}`)
    }
    return { reverted }
  },

  isEnabled() {
    return isConfigLibraryApplied()
  },

  // No onShutdown: Desktop reads its config only at launch, so it isn't
  // reverted per Maximal restart — see ./reconcile.ts.
  onBoot() {
    reconcileClaudeDesktopOnBoot()
  },

  cli: claudeDesktopCli,
}
