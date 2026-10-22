/**
 * Claude Desktop routing intent and its lifecycle.
 *
 * Unlike Claude Code, Desktop is NOT reverted on shutdown. It reads its
 * config only at launch, and a revert/re-apply on every Maximal restart
 * would churn its profile library under a running app for no benefit to that
 * app. Instead boot re-applies, so a changed port or key reaches Desktop the
 * next time it launches; while Maximal is down, Desktop's requests fail the
 * way they would against any stopped gateway.
 */

import consola from "consola"

import { ensureApiKey } from "~/lib/auth/api-key-helper"
import { getConfig, writeConfig } from "~/lib/config/config"

import {
  applyConfigLibraryProfile,
  type ApplyConfigLibraryResult,
  configLibraryConflict,
  DESKTOP_KEY_LABEL,
  revertConfigLibraryProfile,
  type RevertResult,
} from "./config"

export function claudeDesktopRoutingIntended(): boolean {
  return getConfig().apps?.claudeDesktop?.enabled === true
}

/** Single owner of `config.apps.claudeDesktop.enabled`: both the CLI and the
 *  Settings route go through `enableClaudeDesktopRouting` /
 *  `disableClaudeDesktopRouting`. */
function setClaudeDesktopRoutingIntent(enabled: boolean): void {
  const config = getConfig()
  writeConfig({
    ...config,
    apps: {
      ...config.apps,
      claudeDesktop: {
        ...config.apps?.claudeDesktop,
        enabled,
      },
    },
  })
}

/** Provision the key, write the profile, and record the intent — unless
 *  enable was refused, which isn't the user's intent taking effect. `home`
 *  passes through undefined so the config writer owns the default. */
export function enableClaudeDesktopRouting(
  home?: string,
): ApplyConfigLibraryResult {
  const result = applyWithKey(home)
  if (!result.conflict) setClaudeDesktopRoutingIntent(true)
  return result
}

export function disableClaudeDesktopRouting(home?: string): RevertResult {
  const result = revertConfigLibraryProfile(home)
  setClaudeDesktopRoutingIntent(false)
  return result
}

/** Apply with a real key: provision one first, but only for an apply that
 *  will take effect — a refused enable shouldn't leave a key behind, and a
 *  profile must never be written with an empty key. */
function applyWithKey(home: string | undefined): ApplyConfigLibraryResult {
  if (!configLibraryConflict(home)) ensureApiKey(DESKTOP_KEY_LABEL)
  return applyConfigLibraryProfile(home)
}

/** Re-apply when the intent is on. A no-op unless something we write
 *  changed (port, key) — the writer skips a profile that's already current. */
function reapply(
  intended: boolean,
  home: string | undefined,
  why: string,
): void {
  if (!intended) return
  try {
    const result = applyWithKey(home)
    if (result.conflict) {
      consola.warn(
        "claude-desktop: routing intent is on, but another gateway profile is"
          + " applied — left it untouched",
      )
    } else if (result.wrote) {
      consola.info(`claude-desktop: updated gateway profile (${why})`)
    }
  } catch (err) {
    consola.warn(
      `claude-desktop: failed to update gateway profile (${why})`,
      err,
    )
  }
}

export function reconcileClaudeDesktopOnBoot(
  intended: boolean = claudeDesktopRoutingIntended(),
  home?: string,
): void {
  reapply(intended, home, "boot")
}

export function refreshClaudeDesktopApiKey(
  intended: boolean = claudeDesktopRoutingIntended(),
  home?: string,
): void {
  reapply(intended, home, "API key change")
}
