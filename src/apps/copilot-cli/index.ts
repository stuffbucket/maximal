import type { AppEntry } from "~/lib/settings-types"

import type { ClientApp } from "../index"

export const copilotCliApp: ClientApp = {
  id: "copilot-cli",
  name: "Copilot CLI",
  kind: "coming-soon",

  detect() {
    return Promise.resolve(false)
  },

  getDetails(): Promise<AppEntry> {
    return Promise.resolve({
      id: "copilot-cli",
      name: "Copilot CLI",
      kind: "coming-soon",
      enabled: false,
      status: "coming-soon",
      installs: [],
      install: null,
      conflict: null,
    })
  },

  enable() {
    return Promise.resolve({ success: false })
  },

  disable() {
    return Promise.resolve({ success: true })
  },

  uninstall() {
    // Nothing wired (coming-soon placeholder), so nothing to revert.
    return Promise.resolve({ reverted: [] })
  },

  isEnabled() {
    return false
  },
}
