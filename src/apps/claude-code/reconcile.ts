import consola from "consola"

import { getConfig } from "~/lib/config"

import {
  applyProxyBaseUrl,
  getClaudeCodeSettingsPath,
  revertProxyBaseUrl,
} from "./config"

export function claudeCodeRoutingIntended(): boolean {
  return getConfig().apps?.claudeCode?.enabled === true
}

export function reconcileClaudeCodeOnBoot(
  intended: boolean = claudeCodeRoutingIntended(),
  filePath: string = getClaudeCodeSettingsPath(),
): void {
  if (!intended) return
  try {
    const result = applyProxyBaseUrl(filePath)
    if (result.wrote) {
      consola.info(
        "claude-code: re-applied proxy base URL on boot (routing intent is on)",
      )
    } else if (result.skippedReason === "foreign-base-url") {
      consola.warn(
        "claude-code: routing intent is on, but a non-proxy ANTHROPIC_BASE_URL"
          + " is present — left it untouched",
      )
    }
  } catch (err) {
    consola.warn("claude-code: failed to reconcile base URL on boot", err)
  }
}

export function reconcileClaudeCodeOnShutdown(
  intended: boolean = claudeCodeRoutingIntended(),
  filePath: string = getClaudeCodeSettingsPath(),
): void {
  if (!intended) return
  try {
    const result = revertProxyBaseUrl(filePath)
    if (result.wrote) {
      consola.info(
        "claude-code: removed proxy base URL for shutdown"
          + " (routing intent persists for next boot)",
      )
    }
  } catch (err) {
    consola.warn("claude-code: failed to reconcile base URL on shutdown", err)
  }
}
