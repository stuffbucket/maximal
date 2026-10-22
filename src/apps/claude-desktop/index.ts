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

  enable() {
    const { conflict } = applyConfigLibraryProfile()
    if (conflict) return Promise.resolve({ success: false, conflict })
    // Restore the MCP endpoints the user chose for Claude Desktop.
    syncMcpClient(claudeDesktopMcp)
    return Promise.resolve({ success: true })
  },

  disable() {
    revertConfigLibraryProfile()
    syncMcpClient(claudeDesktopMcp, { active: false })
    return Promise.resolve({ success: true })
  },

  uninstall(): Promise<AppUninstallResult> {
    // Removes only our gateway profile and our MCP entries from the Claude
    // Desktop config, no-op when we never wired them. A profile the user
    // edited after we wrote it is left on disk.
    const reverted: Array<string> = []
    const result = revertConfigLibraryProfile()
    if (result.reverted) {
      reverted.push(`removed our gateway profile from ${result.dir}`)
    }
    for (const file of result.kept) {
      reverted.push(`left ${file} in place (it was edited after setup)`)
    }
    const mcp = syncMcpClient(claudeDesktopMcp, { active: false })
    if (mcp.removed.length > 0) {
      reverted.push(`removed our MCP servers: ${mcp.removed.join(", ")}`)
    }
    return Promise.resolve({ reverted })
  },

  isEnabled() {
    return isConfigLibraryApplied()
  },

  cli: claudeDesktopCli,
}
