import consola from "consola"

import { getConfig, writeConfig } from "~/lib/config/config"

import {
  applyProxyBaseUrl,
  getClaudeCodeSettingsPath,
  revertProxyBaseUrl,
} from "./config"

export function claudeCodeRoutingIntended(): boolean {
  return getConfig().apps?.claudeCode?.enabled === true
}

/**
 * Persist the durable routing-intent flag (`config.apps.claudeCode.enabled`)
 * that boot/shutdown reconciliation gates on. Co-located with its reader
 * (`claudeCodeRoutingIntended`) so the intent has a SINGLE owner: both the CLI
 * (`maximal app claude-code --enable/--disable`) and the Settings HTTP route
 * flow through `claudeCodeApp.enable()/disable()`, which call this — nothing
 * else writes the flag. Round-trips through `writeConfig` so the merge is
 * validated and the in-memory cache stays consistent.
 */
export function setClaudeCodeRoutingIntent(enabled: boolean): void {
  const config = getConfig()
  writeConfig({
    ...config,
    apps: {
      ...config.apps,
      claudeCode: {
        ...config.apps?.claudeCode,
        enabled,
      },
    },
  })
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
    } else if (result.skippedReason === "foreign-api-key-helper") {
      consola.warn(
        "claude-code: routing intent is on, but a custom apiKeyHelper"
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
