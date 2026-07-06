import type { AppEntry } from "~/lib/settings-types"

import type { AppUninstallResult, ClientApp } from "../index"

import {
  isProxyBaseUrlConfigured,
  applyProxyBaseUrl,
  revertProxyBaseUrl,
  getClaudeCodeSettingsPath,
  HELPER_LABEL,
} from "./config"
import { detectClaudeInstalls } from "./detect"
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

  detect() {
    const installs = detectClaudeInstalls()
    return Promise.resolve(installs.length > 0)
  },

  getDetails(conflict: AppEntry["conflict"] = null): Promise<AppEntry> {
    const installs = detectClaudeInstalls()
    return Promise.resolve({
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
    })
  },

  enable() {
    const result = applyProxyBaseUrl()
    const conflict =
      (
        result.skippedReason === "foreign-base-url"
        || result.skippedReason === "foreign-api-key-helper"
      ) ?
        result.skippedReason
      : null
    // Persist the durable routing intent so boot/shutdown self-heal runs for
    // ALL callers (CLI + Settings UI), not just the HTTP path. Single writer:
    // the Settings route no longer persists this separately.
    setClaudeCodeRoutingIntent(true)
    return Promise.resolve({
      success: result.wrote || conflict === null,
      conflict,
    })
  },

  disable() {
    const result = revertProxyBaseUrl()
    setClaudeCodeRoutingIntent(false)
    return Promise.resolve({ success: result.wrote })
  },

  uninstall(): Promise<AppUninstallResult> {
    // Ownership-guarded: removes only the ANTHROPIC_BASE_URL block we wrote,
    // no-op when absent or foreign. The installer PATH block is maximal's own
    // artifact (not an app integration), so the uninstaller handles that.
    const reverted: Array<string> = []
    const result = revertProxyBaseUrl()
    if (result.wrote) {
      reverted.push(`reverted ${getClaudeCodeSettingsPath()}`)
    }
    return Promise.resolve({ reverted })
  },

  isEnabled() {
    return isProxyBaseUrlConfigured()
  },

  onBoot() {
    reconcileClaudeCodeOnBoot()
    return Promise.resolve()
  },

  onShutdown() {
    reconcileClaudeCodeOnShutdown()
    return Promise.resolve()
  },
}
