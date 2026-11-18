import type { AppEntry } from "~/lib/config/settings-types"

import { claudeDesktopPluginClient } from "~/lib/plugins/clients/claude-desktop"
import { removePluginClientEntries } from "~/lib/plugins/clients/sync"
import { notifyPluginsChanged, syncPluginClients } from "~/lib/plugins/runtime"

import type { AppUninstallResult, ClientApp } from "../index"

import { claudeDesktopCli } from "./cli"
import {
  configLibraryConflict,
  DESKTOP_KEY_LABEL,
  isConfigLibraryApplied,
} from "./config"
import { claudeAppInstalled, detectClaudeAppInstallations } from "./detect"
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

  detect() {
    return Promise.resolve(claudeAppInstalled())
  },

  getDetails(conflict: AppEntry["conflict"] = null): Promise<AppEntry> {
    const installed = claudeAppInstalled()
    const configured = isConfigLibraryApplied()
    const installations = detectClaudeAppInstallations()
    return Promise.resolve({
      id: "claude-desktop",
      name: "Claude Desktop",
      kind: "config",
      enabled: configured,
      status: installed ? "ready" : "not-installed",
      installs: installations.map((installation) => ({
        kind: "desktop",
        ...installation,
      })),
      install: null,
      conflict: conflict ?? configLibraryConflict(),
    })
  },

  enable(options) {
    const { conflict } = enableClaudeDesktopRouting(undefined, options)
    if (conflict) return Promise.resolve({ success: false, conflict })
    syncPluginClients()
    notifyPluginsChanged()
    return Promise.resolve({ success: true })
  },

  disable() {
    // Remove the entry before routing state: the latter carries profile
    // ownership used by the former's write guard.
    removePluginClientEntries(claudeDesktopPluginClient)
    disableClaudeDesktopRouting()
    notifyPluginsChanged()
    return Promise.resolve({ success: true })
  },

  uninstall(): Promise<AppUninstallResult> {
    // Removes only our gateway profile and managed MCP array. A profile or
    // MCP field the user edited after setup is left on disk.
    const reverted: Array<string> = []
    const mcp = removePluginClientEntries(claudeDesktopPluginClient)
    if (mcp.removed.length > 0) {
      reverted.push(`removed our MCP servers: ${mcp.removed.join(", ")}`)
    }
    // Also clears the routing intent, so the next boot doesn't re-apply.
    const result = disableClaudeDesktopRouting()
    if (result.reverted) {
      reverted.push(`removed our gateway profile from ${result.dir}`)
    }
    for (const file of result.kept) {
      reverted.push(`left ${file} in place (it was edited after setup)`)
    }
    return Promise.resolve({ reverted })
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
