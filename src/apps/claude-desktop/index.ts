import type { AppEntry } from "~/lib/config/settings-types"

import { syncMcpClient } from "~/lib/mcp-broker/client-sync"

import type { AppUninstallResult, ClientApp } from "../index"

import { claudeDesktopCli } from "./cli"
import {
  isConfigLibraryApplied,
  applyConfigLibraryProfile,
  revertConfigLibraryProfile,
} from "./config"
import { claudeAppInstalled } from "./detect"
import { claudeDesktopMcp } from "./mcp"

export const claudeDesktopApp: ClientApp = {
  id: "claude-desktop",
  name: "Claude Desktop",
  kind: "config",
  apiKeyLabel: "claude-desktop",
  mcp: claudeDesktopMcp,

  detect() {
    return Promise.resolve(claudeAppInstalled())
  },

  getDetails(): Promise<AppEntry> {
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
      conflict: null,
    })
  },

  async enable() {
    applyConfigLibraryProfile()
    // Restore the MCP endpoints the user chose for Claude Desktop.
    await syncMcpClient(claudeDesktopMcp)
    return { success: true }
  },

  async disable() {
    revertConfigLibraryProfile()
    await syncMcpClient(claudeDesktopMcp, { active: false })
    return { success: true }
  },

  async uninstall(): Promise<AppUninstallResult> {
    // Removes only our gateway profile and our MCP entries from the Claude
    // Desktop config, no-op when we never wired them.
    const reverted: Array<string> = []
    const result = revertConfigLibraryProfile()
    if (result.reverted) {
      reverted.push(`removed our gateway profile from ${result.dir}`)
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

  cli: claudeDesktopCli,
}
