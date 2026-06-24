#!/usr/bin/env node
/**
 * `maximal configure-claude-desktop` — opt-in subcommand that wires
 * Claude Desktop's third-party (Cowork 3P) mode at the local gateway.
 *
 * The proxy is client-neutral — Claude Code, opencode, the AI SDK, custom
 * apps, and Claude Desktop all work against the same gateway. Pairing
 * Claude Desktop is a deliberate choice the user makes; `maximal setup`
 * no longer touches it.
 *
 * What this does (mac):
 *
 *   1. Detects `/Applications/Claude.app`. If absent, refuses unless
 *      `--force` is given.
 *   2. Writes the gateway profile into Claude Desktop's third-party config
 *      library (`~/Library/Application Support/Claude-3p/configLibrary/`),
 *      which the app reads at launch — booting straight into 3P with no
 *      Anthropic sign-in. Telemetry off; Anthropic update checks left on.
 *   3. Creates `$HOME/Claude` (the workspace folder) if missing.
 *
 * `--revert` removes the gateway profile and clears `deploymentMode`,
 * leaving other config-library entries and user preferences intact.
 *
 * `--managed` instead emits a `.mobileconfig` managed-preferences profile
 * (the robust path for MDM fleets) — install via Intune/Jamf or a one-time
 * `sudo profiles install`. It is read regardless of the app's userData
 * dir and outranks any file-tier config.
 */

import { defineCommand } from "citty"
import consola from "consola"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  applyConfigLibraryProfile,
  generateManagedProfile,
  revertConfigLibraryProfile,
} from "./lib/claude-desktop-3p-config"

const CLAUDE_APP_PATH = "/Applications/Claude.app"
const MANAGED_PROFILE_OUT = "maximal-claude-3p.mobileconfig"

/**
 * Candidate Claude Desktop install locations to probe, per platform.
 *
 *  - macOS: the app bundle in `/Applications`.
 *  - Windows: the per-user Squirrel install dir (`%LOCALAPPDATA%\\AnthropicClaude`),
 *    the launcher alias the installer drops on PATH
 *    (`%LOCALAPPDATA%\\Microsoft\\WindowsApps\\Claude.exe`), and the MSIX /
 *    Microsoft-Store build's known package dir
 *    (`%LOCALAPPDATA%\\Packages\\Claude_pzs8sxrjxfjjc`). Any present means
 *    Claude Desktop is installed. New Windows installs are MSIX, which does
 *    NOT create the Squirrel dir or always drop the alias, so the Packages
 *    signal — plus the prefix scan in `claudeAppInstalled` — is what catches
 *    a modern install.
 *
 * Returns an empty list on unsupported platforms (caller treats that as
 * "can't tell" and only blocks on darwin/win32).
 */
function claudeAppCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): Array<string> {
  if (platform === "darwin") return [CLAUDE_APP_PATH]
  if (platform === "win32") {
    const localAppData = windowsLocalAppData(home)
    return [
      path.join(localAppData, "AnthropicClaude"),
      path.join(localAppData, "Microsoft", "WindowsApps", "Claude.exe"),
      path.join(localAppData, "Packages", "Claude_pzs8sxrjxfjjc"),
    ]
  }
  return []
}

/** `%LOCALAPPDATA%`, or its default location under `home` when unset. */
function windowsLocalAppData(home: string): string {
  return process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")
}

/**
 * MSIX package family names mutate (`Claude_<publisherhash>`,
 * `AnthropicPBC.Claude_<hash>`), so an exact path can't catch every install.
 * Scan `%LOCALAPPDATA%\\Packages` for any entry in the Claude family. No-ops
 * (returns false) when the Packages dir is absent or unreadable.
 */
function windowsMsixClaudeInstalled(home: string): boolean {
  const packages = path.join(windowsLocalAppData(home), "Packages")
  try {
    return fs
      .readdirSync(packages)
      .some(
        (name) =>
          name.startsWith("Claude_") || name.startsWith("AnthropicPBC.Claude"),
      )
  } catch {
    return false
  }
}

interface ConfigureOptions {
  force: boolean
  revert: boolean
  managed: boolean
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

  if (opts.managed) {
    writeManagedProfile()
    return
  }

  if (!claudeAppInstalled() && !opts.force) {
    const where = claudeAppCandidates().join(" or ") || "the usual location"
    consola.warn(
      `Claude Desktop not found (looked at ${where}). Install it from`
        + " https://claude.ai/download, then re-run this command. To"
        + " write the config anyway (e.g. before installing), pass --force.",
    )
    return
  }

  apply()
}

function apply(): void {
  try {
    const result = applyConfigLibraryProfile()
    if (result.wrote) {
      consola.success(
        `Claude Desktop wired at the gateway (${result.dir}, profile ${result.profileId})`,
      )
    } else {
      consola.success("Claude Desktop already configured")
    }
    if (result.ensuredWorkspaceFolders.length > 0) {
      consola.info(
        `  workspace folders: ${result.ensuredWorkspaceFolders.join(", ")}`,
      )
    }
    consola.info(
      "  Quit & relaunch Claude Desktop for the change to take effect.",
    )
  } catch (err) {
    consola.error("Could not update Claude Desktop config", err)
  }
}

function revert(): void {
  try {
    const result = revertConfigLibraryProfile()
    if (result.reverted) {
      consola.success(`Removed our gateway profile from ${result.dir}`)
    } else {
      consola.info("Claude Desktop wasn't wired by us; nothing to do")
    }
  } catch (err) {
    consola.error("Could not revert Claude Desktop config", err)
  }
}

function writeManagedProfile(): void {
  try {
    fs.writeFileSync(MANAGED_PROFILE_OUT, generateManagedProfile(), {
      mode: 0o600,
    })
    const abs = path.resolve(MANAGED_PROFILE_OUT)
    consola.success(`Wrote managed-preferences profile to ${abs}`)
    consola.info(
      "  Install it (no Anthropic sign-in needed) via either:\n"
        + `    sudo profiles install -path ${abs}\n`
        + "  …or push it through your MDM (Intune/Jamf). It is read\n"
        + "  regardless of Claude Desktop's data dir and outranks file config.",
    )
  } catch (err) {
    consola.error("Could not write managed profile", err)
  }
}

/**
 * Is Claude Desktop installed? Real check on macOS and Windows; on any
 * other platform we can't tell, so return true (don't block — `--force`
 * still exists, and the config write is harmless if the app is absent).
 *
 * Exported for unit testing; `platform`/`home` are injectable so the
 * Windows branch can be exercised on a POSIX host.
 */
export function claudeAppInstalled(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): boolean {
  const candidates = claudeAppCandidates(platform, home)
  // Unsupported platform: nothing to probe → can't tell, don't block.
  if (candidates.length === 0) return true
  const hasCandidate = candidates.some((p) => {
    try {
      // Accept either a directory (macOS .app bundle, Windows Squirrel dir)
      // or a file (Windows launcher alias) — any existing candidate counts.
      fs.statSync(p)
      return true
    } catch {
      return false
    }
  })
  if (hasCandidate) return true
  // Windows MSIX installs use a hashed package-family dir that no fixed path
  // can pin down — scan the Packages dir for the Claude family as a fallback.
  if (platform === "win32") return windowsMsixClaudeInstalled(home)
  return false
}

export const configureClaudeDesktop = defineCommand({
  meta: {
    name: "configure-claude-desktop",
    description:
      "Wire Claude Desktop (Cowork 3P) at the local proxy (opt-in; setup does not configure it).",
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
      description: "Remove the gateway profile this command writes.",
    },
    managed: {
      type: "boolean",
      default: false,
      description: `Emit a managed-preferences .mobileconfig (${MANAGED_PROFILE_OUT}) for MDM fleets instead of writing the config library.`,
    },
  },
  run({ args }) {
    runConfigureClaudeDesktop({
      force: args.force,
      revert: args.revert,
      managed: args.managed,
    })
  },
})
