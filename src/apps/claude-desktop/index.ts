import type { AppEntry } from "~/lib/settings-types"

import type { AppUninstallResult, ClientApp } from "../index"

import { claudeDesktopCli } from "./cli"
import {
  isConfigLibraryApplied,
  applyConfigLibraryProfile,
  revertConfigLibraryProfile,
} from "./config"
import { claudeAppInstalled } from "./detect"

export const claudeDesktopApp: ClientApp = {
  id: "claude-desktop",
  name: "Claude Desktop",
  kind: "config",
  apiKeyLabel: "claude-desktop",

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

  enable() {
    applyConfigLibraryProfile()
    return Promise.resolve({ success: true })
  },

  disable() {
    revertConfigLibraryProfile()
    return Promise.resolve({ success: true })
  },

  uninstall(): Promise<AppUninstallResult> {
    // Removes only our gateway profile from the Claude Desktop config library,
    // no-op when we never wired it.
    const reverted: Array<string> = []
    const result = revertConfigLibraryProfile()
    if (result.reverted) {
      reverted.push(`removed our gateway profile from ${result.dir}`)
    }
    return Promise.resolve({ reverted })
  },

  isEnabled() {
    return isConfigLibraryApplied()
  },

  cli: claudeDesktopCli,
}
