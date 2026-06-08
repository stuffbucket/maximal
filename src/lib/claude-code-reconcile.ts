/**
 * Lifecycle reconciliation for Claude Code routing.
 *
 * The persisted *intent* (`config.apps.claudeCode.enabled`) and the actual
 * on-disk *effect* (`env.ANTHROPIC_BASE_URL` in ~/.claude/settings.json) are
 * deliberately decoupled:
 *
 *   - **Boot** (`reconcileClaudeCodeOnBoot`): if the user left routing on,
 *     (re)write the base URL now that the proxy is actually listening. This
 *     self-heals a URL a prior crash / force-kill left pointing at a dead
 *     proxy.
 *   - **Graceful shutdown** (`reconcileClaudeCodeOnShutdown`): if routing is
 *     on, remove the base URL so `claude` isn't stranded over a proxy that's
 *     about to stop. The *intent flag stays true*, so the next boot puts it
 *     back. This is the "turn it off in Claude Code when maximal isn't
 *     running" half of the failure plan.
 *
 * Both delegate to the ownership-guarded writer in `claude-code-settings.ts`,
 * so a foreign `ANTHROPIC_BASE_URL` the user set themselves is never
 * clobbered or removed, and sibling env keys (ANTHROPIC_API_KEY,
 * ANTHROPIC_AUTH_TOKEN) are never touched.
 *
 * The `intended` / `filePath` parameters default to the real config + path
 * but are injectable so tests can drive them without `mock.module` (see
 * CLAUDE.md → prefer injectable options over module mocks).
 */

import consola from "consola"

import {
  applyProxyBaseUrl,
  getClaudeCodeSettingsPath,
  revertProxyBaseUrl,
} from "./claude-code-settings"
import { getConfig } from "./config"

/** Whether the user intends Claude Code routing to be on. Distinct from
 *  whether the base URL is currently written to disk. */
export function claudeCodeRoutingIntended(): boolean {
  return getConfig().apps?.claudeCode?.enabled === true
}

/** Reconcile-up. No-op unless routing is intended. Ownership-guarded write
 *  of `env.ANTHROPIC_BASE_URL`. */
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

/** Reconcile-down. No-op unless routing is intended. Ownership-guarded
 *  removal of our base URL only; the intent flag is left on for next boot. */
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
