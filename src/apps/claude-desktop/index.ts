import type { AppEntry } from "~/lib/config/settings-types"

import type { AppUninstallResult, ClientApp } from "../index"

import { claudeDesktopCli } from "./cli"
import { DESKTOP_KEY_LABEL, isConfigLibraryApplied } from "./config"
import { claudeAppInstalled } from "./detect"
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
    const { conflict } = enableClaudeDesktopRouting()
    if (conflict) return Promise.resolve({ success: false, conflict })
    return Promise.resolve({ success: true })
  },

  disable() {
    disableClaudeDesktopRouting()
    return Promise.resolve({ success: true })
  },

  uninstall(): Promise<AppUninstallResult> {
    // Removes only our gateway profile from the Claude Desktop config,
    // no-op when we never wired it. A profile the user
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
