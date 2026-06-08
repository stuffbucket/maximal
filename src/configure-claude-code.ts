#!/usr/bin/env node
/**
 * `maximal configure-claude-code` — opt-in subcommand that wires Claude
 * Code to point at the local proxy by writing `env.ANTHROPIC_BASE_URL`
 * into `~/.claude/settings.json`.
 *
 * This is the *shared reverter* the Tauri shell calls on the sidecar's
 * behalf. The proxy reverts itself on graceful shutdown
 * (`reconcileClaudeCodeOnShutdown`), but a crash / SIGKILL gives it no
 * chance — so the shell, which outlives the sidecar, runs
 * `maximal configure-claude-code --revert` to clean up the stranded base
 * URL. Because it's a CLI subcommand it works even though the server is
 * already down.
 *
 *   - (no flag): write `env.ANTHROPIC_BASE_URL` (ownership-guarded —
 *     a foreign base URL is left untouched).
 *   - `--revert`: remove only the base URL we wrote (ownership-guarded;
 *     sibling env keys like ANTHROPIC_API_KEY are never touched).
 *
 * Unlike the Apps toggle, this does NOT change the persisted intent flag
 * (`config.apps.claudeCode.enabled`) — it only reconciles the on-disk
 * effect. The shell uses it purely to undo a crash-stranded write; the
 * intent stays whatever the user last chose, so the next clean boot
 * re-applies it.
 */

import { defineCommand } from "citty"
import consola from "consola"

import {
  applyProxyBaseUrl,
  getClaudeCodeSettingsPath,
  revertProxyBaseUrl,
} from "./lib/claude-code-settings"

interface ConfigureOptions {
  revert: boolean
  /** Settings path override. Defaults to the resolved ~/.claude path; tests
   *  inject a tmp path (avoids `mock.module` cross-file bleed — CLAUDE.md). */
  filePath?: string
}

export function runConfigureClaudeCode(opts: ConfigureOptions): void {
  const filePath = opts.filePath ?? getClaudeCodeSettingsPath()
  consola.box(
    opts.revert ?
      "maximal configure-claude-code --revert"
    : "maximal configure-claude-code",
  )

  if (opts.revert) {
    revert(filePath)
    return
  }
  apply(filePath)
}

function apply(filePath: string): void {
  try {
    const result = applyProxyBaseUrl(filePath)
    if (result.wrote) {
      consola.success(`Pointed Claude Code at the proxy (${result.path})`)
    } else if (result.skippedReason === "foreign-base-url") {
      consola.warn(
        `A non-proxy ANTHROPIC_BASE_URL is already set in ${result.path};`
          + " left it untouched. Remove it first if you want proxy routing.",
      )
    } else {
      consola.success("Claude Code already points at the proxy")
    }
  } catch (err) {
    consola.error("Could not update Claude Code settings", err)
  }
}

function revert(filePath: string): void {
  try {
    const result = revertProxyBaseUrl(filePath)
    if (result.wrote) {
      consola.success(`Removed the proxy base URL from ${result.path}`)
    } else {
      consola.info(
        "Claude Code didn't have our base URL set; nothing to revert",
      )
    }
  } catch (err) {
    consola.error("Could not revert Claude Code settings", err)
  }
}

export const configureClaudeCode = defineCommand({
  meta: {
    name: "configure-claude-code",
    description:
      "Point Claude Code at the local proxy via ~/.claude/settings.json"
      + " (opt-in; --revert to remove).",
  },
  args: {
    revert: {
      type: "boolean",
      default: false,
      description:
        "Remove the ANTHROPIC_BASE_URL this command writes, leaving other"
        + " settings intact.",
    },
  },
  run({ args }) {
    runConfigureClaudeCode({ revert: args.revert })
  },
})
