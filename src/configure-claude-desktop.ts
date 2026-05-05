#!/usr/bin/env node
/**
 * `maximal configure-claude-desktop` — opt-in subcommand that
 * wires Claude Desktop to point at the local proxy.
 *
 * The proxy itself is client-neutral — Claude Code, opencode, the AI
 * SDK, custom apps, and Claude Desktop all work against the same
 * gateway. Configuring Claude Desktop is a deliberate choice the user
 * makes; `maximal setup` no longer touches it.
 *
 * What this command does (mac):
 *
 *   1. Detects `/Applications/Claude.app`. If absent, refuses unless
 *      `--force` is given (the file write is harmless when Claude
 *      Desktop never arrives, but the warning catches typos).
 *   2. Writes the 16-key default profile to
 *      `~/Library/Application Support/Claude/claude_desktop_config.json`,
 *      preserving any other keys via allowlist merge.
 *   3. Creates `$HOME/Claude` (the workspace folder) if missing.
 *   4. Clears the MDM-tier `coworkEgressAllowedHosts` if Claude
 *      Desktop's installer left a value there — file-tier `["*"]`
 *      then takes effect.
 *
 * `--revert` is the inverse — same allowlist, removed via
 *  `revertProxyConfig`.
 */

import { defineCommand } from "citty"
import consola from "consola"
import { spawnSync } from "node:child_process"
import fs from "node:fs"

import {
  applyProxyConfig,
  revertProxyConfig,
} from "./lib/claude-desktop-config"

const CLAUDE_APP_PATH = "/Applications/Claude.app"

interface ConfigureOptions {
  force: boolean
  revert: boolean
}

export function runConfigureClaudeDesktop(opts: ConfigureOptions): void {
  consola.box(
    opts.revert ?
      "maximal configure-claude-desktop --revert"
    : "maximal configure-claude-desktop",
  )

  if (opts.revert) {
    revert()
    return
  }

  if (!claudeAppInstalled() && !opts.force) {
    consola.warn(
      `Claude Desktop not found at ${CLAUDE_APP_PATH}. Install it from`
        + " https://claude.ai/download, then re-run this command. To"
        + " write the config anyway (e.g. before installing), pass --force.",
    )
    return
  }

  apply()
  clearMdmCoworkEgress()
}

function apply(): void {
  try {
    const result = applyProxyConfig()
    if (result.wrote) {
      consola.success(`Claude Desktop config updated at ${result.path}`)
      if (result.preservedKeys.length > 0) {
        consola.info(
          `  preserved existing keys: ${result.preservedKeys.join(", ")}`,
        )
      }
    } else {
      consola.success(`Claude Desktop config already configured`)
    }
    if (result.ensuredWorkspaceFolders.length > 0) {
      consola.info(
        `  workspace folders: ${result.ensuredWorkspaceFolders.join(", ")}`,
      )
    }
  } catch (err) {
    consola.error("Could not update Claude Desktop config", err)
  }
}

function revert(): void {
  try {
    const result = revertProxyConfig()
    if (!result.wrote) {
      consola.info("Claude Desktop config didn't have our keys; nothing to do")
      return
    }
    if (result.remainingKeys.length === 0) {
      consola.success(`Removed ${result.path} (was only our keys)`)
    } else {
      consola.success(
        `Stripped our keys from ${result.path} (${result.remainingKeys.length} other keys preserved)`,
      )
    }
  } catch (err) {
    consola.error("Could not revert Claude Desktop config", err)
  }
}

function claudeAppInstalled(): boolean {
  if (process.platform !== "darwin") return true
  try {
    return fs.statSync(CLAUDE_APP_PATH).isDirectory()
  } catch {
    return false
  }
}

function clearMdmCoworkEgress(): void {
  if (process.platform !== "darwin") return
  const existing = readCoworkAllowedHosts()
  if (existing === null) {
    consola.success('MDM-tier allowlist absent — file-tier `["*"]` wins')
    return
  }
  const r = deleteMdmAllowedHosts()
  if (r.ok) {
    consola.success(
      `Cleared MDM-tier allowlist (${existing.length} host${existing.length === 1 ? "" : "s"} removed); file-tier \`["*"]\` now wins`,
    )
  } else {
    consola.warn(
      `Could not delete MDM-tier allowlist (${existing.length} host${existing.length === 1 ? "" : "s"} present); MDM may shadow file-tier`,
      r.error,
    )
  }
}

function readCoworkAllowedHosts(): Array<string> | null {
  const r = spawnSync(
    "defaults",
    ["read", "com.anthropic.claudefordesktop", "coworkEgressAllowedHosts"],
    { encoding: "utf8" },
  )
  if (r.status !== 0) return null
  const out = r.stdout.trim()
  if (!out || out === "()") return null
  return out
    .replace(/^\(\s*/, "")
    .replace(/\s*\)$/, "")
    .split(",")
    .map((s) => s.trim().replace(/^"/, "").replace(/"$/, ""))
    .filter((s) => s.length > 0)
}

function deleteMdmAllowedHosts(): { ok: true } | { ok: false; error: unknown } {
  const r = spawnSync(
    "defaults",
    ["delete", "com.anthropic.claudefordesktop", "coworkEgressAllowedHosts"],
    { encoding: "utf8" },
  )
  if (r.status !== 0) return { ok: false, error: r.stderr || r.error }
  return { ok: true }
}

export const configureClaudeDesktop = defineCommand({
  meta: {
    name: "configure-claude-desktop",
    description:
      "Wire Claude Desktop to point at the local proxy (opt-in; setup does not configure it).",
  },
  args: {
    force: {
      type: "boolean",
      default: false,
      description:
        "Write the config even if /Applications/Claude.app is missing.",
    },
    revert: {
      type: "boolean",
      default: false,
      description:
        "Remove the keys this command writes, leaving any other keys intact.",
    },
  },
  run({ args }) {
    runConfigureClaudeDesktop({
      force: args.force,
      revert: args.revert,
    })
  },
})
