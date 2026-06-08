#!/usr/bin/env node
/**
 * `maximal uninstall` — reverse of `setup`.
 *
 * Stops the running proxy (launchd / Windows scheduled task), removes
 * the on-disk binary, and *optionally* purges the user's secrets
 * directory and reverts the Claude Desktop config touches. Defaults
 * are conservative: secrets stay, Claude Desktop config stays —
 * the user can pass `--purge` and `--revert-claude` to remove them
 * non-interactively, or accept the corresponding prompts.
 *
 * Spec: docs/spec/archive/internal-distribution-stream-b.md §B6.
 */

import { defineCommand } from "citty"
import consola from "consola"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  getClaudeCodeSettingsPath,
  revertProxyBaseUrl,
} from "./lib/claude-code-settings"
import { revertProxyConfig } from "./lib/claude-desktop-config"
import { PATHS } from "./lib/paths"

interface RunUninstallOptions {
  purge: boolean
  revertClaude: boolean
  unattended: boolean
}

export async function runUninstall(opts: RunUninstallOptions): Promise<void> {
  consola.box("maximal uninstall")

  // 1. Stop the running proxy (best effort) -------------------------
  consola.info("Step 1/5: Stop the running proxy")
  stopProxy()

  // 2. Remove launchd plist / Windows scheduled task ----------------
  consola.info("Step 2/5: Remove startup integration")
  removeStartupIntegration()

  // 3. Remove the binary --------------------------------------------
  consola.info("Step 3/5: Remove the binary")
  removeBinary()

  // 4. Revert Claude Code routing + installer PATH block ------------
  // Ownership-guarded: only removes the ANTHROPIC_BASE_URL we wrote.
  consola.info("Step 4/5: Revert Claude Code routing")
  removeClaudeCodeIntegration()

  // 5. Optional: secrets + Claude Desktop config --------------------
  consola.info("Step 5/5: Optional cleanup")
  await maybePurgeSecrets(opts)
  await maybeRevertClaude(opts)

  consola.box("Uninstall complete.")
}

// ────────────────────────────────────────────────────────────────────
// Step 1: stop the proxy.
// ────────────────────────────────────────────────────────────────────

function stopProxy(): void {
  if (process.platform === "darwin") {
    const r = spawnSync(
      "launchctl",
      ["bootout", `gui/${process.getuid?.() ?? 0}/co.stuffbucket.maximal`],
      { encoding: "utf8" },
    )
    if (r.status === 0) {
      consola.success("  launchd agent stopped")
    } else {
      // bootout returns non-zero if the agent isn't running. Soft
      // success — the goal is "no longer running," not "we did the
      // stop."
      consola.info("  launchd agent not running (or already removed)")
    }
    return
  }
  if (process.platform === "win32") {
    const r = spawnSync("schtasks", ["/End", "/TN", "maximal"], {
      encoding: "utf8",
    })
    if (r.status === 0) {
      consola.success("  scheduled task stopped")
    } else {
      consola.info("  scheduled task not running (or already removed)")
    }
    return
  }
  consola.info("  unsupported platform; skipping startup integration")
}

// ────────────────────────────────────────────────────────────────────
// Step 2: remove launchd plist / scheduled task.
// ────────────────────────────────────────────────────────────────────

function removeStartupIntegration(): void {
  if (process.platform === "darwin") {
    const plist = path.join(
      os.homedir(),
      "Library",
      "LaunchAgents",
      "co.stuffbucket.maximal.plist",
    )
    if (fs.existsSync(plist)) {
      try {
        fs.rmSync(plist)
        consola.success(`  removed ${plist}`)
      } catch (err) {
        consola.warn(`  could not remove ${plist}`, err)
      }
    } else {
      consola.info("  launchd plist not found; nothing to remove")
    }
    return
  }
  if (process.platform === "win32") {
    const r = spawnSync("schtasks", ["/Delete", "/TN", "maximal", "/F"], {
      encoding: "utf8",
    })
    if (r.status === 0) {
      consola.success("  scheduled task unregistered")
    } else {
      consola.info("  scheduled task not registered; nothing to remove")
    }
    return
  }
  consola.info("  unsupported platform; skipping")
}

// ────────────────────────────────────────────────────────────────────
// Step 3: remove the binary.
// ────────────────────────────────────────────────────────────────────

interface InstallTarget {
  path: string
  /** Directory targets (the macOS .app bundle is one) need recursive
   *  removal; single-file binaries don't. */
  recursive?: boolean
}

/** Candidate install locations, in order of likelihood. We delete
 *  every one we find; users may have copies in multiple places (e.g.
 *  `brew install` + a `.dmg` install both leave a binary on disk).
 *
 *  macOS .dmg install path: `/Applications/maximal.app` (the
 *  bundle) plus `~/.local/bin/maximal` (copy made by the
 *  bundle's first-launch shim). Brew installs at
 *  `/opt/homebrew/bin/maximal`. */
function installTargets(): Array<InstallTarget> {
  const home = os.homedir()
  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")
    return [
      {
        path: path.join(localAppData, "Programs", "maximal", "maximal.exe"),
      },
      // The PowerShell installer's parent dir gets removed when it
      // becomes empty; we don't recurse into it ourselves to avoid
      // nuking unrelated files.
    ]
  }
  return [
    { path: path.join(home, ".local", "bin", "maximal") },
    { path: "/usr/local/bin/maximal" },
    { path: "/opt/homebrew/bin/maximal" },
    { path: "/Applications/maximal.app", recursive: true },
  ]
}

function removeBinary(): void {
  let removed = 0
  for (const target of installTargets()) {
    if (!fs.existsSync(target.path)) continue
    try {
      fs.rmSync(target.path, target.recursive ? { recursive: true } : undefined)
      consola.success(`  removed ${target.path}`)
      removed++
    } catch (err) {
      consola.warn(`  could not remove ${target.path}`, err)
    }
  }
  if (removed === 0) {
    consola.info("  no installed binary found")
  }
}

// ────────────────────────────────────────────────────────────────────
// Step 4: revert Claude Code routing + remove the installer PATH block.
// ────────────────────────────────────────────────────────────────────

/** Revert the Claude Code routing we applied (the `ANTHROPIC_BASE_URL`
 *  block in `~/.claude/settings.json`, ownership-guarded — only removed if
 *  it's ours), and strip the macOS first-launch installer PATH block
 *  (`# >>> maximal PATH >>>`) from the user's zsh rc files. Both are
 *  marker/ownership-scoped and no-op when absent, so this is always safe. */
function removeClaudeCodeIntegration(): void {
  try {
    const reverted = revertProxyBaseUrl()
    if (reverted.wrote) {
      consola.success(`  reverted ${getClaudeCodeSettingsPath()}`)
    } else {
      consola.info("  Claude Code routing not configured; nothing to revert")
    }
  } catch (err) {
    consola.warn("  could not revert Claude Code settings", err)
  }
  const installerRc = removeFirstLaunchPathBlock()
  if (installerRc.length > 0) {
    consola.success(
      `  removed installer PATH block from ${installerRc.join(", ")}`,
    )
  }
}

const FIRST_LAUNCH_PATH_MARKER_START = "# >>> maximal PATH >>>"
const FIRST_LAUNCH_PATH_MARKER_END = "# <<< maximal PATH <<<"

function escapeRegExp(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

/**
 * Strip the first-launch `# >>> maximal PATH >>>` block from the user's
 * zsh rc files. Marker-scoped — it touches only the block between our
 * markers and leaves everything else intact. Best-effort per file (an
 * unreadable/unwritable rc is skipped). Returns the rc files modified.
 *
 * Without this, uninstall used to leave the installer's PATH line orphaned
 * (pointing at a deleted `~/.local/bin/maximal`).
 */
export function removeFirstLaunchPathBlock(
  homeDir: string = os.homedir(),
): Array<string> {
  const rcFiles = [
    path.join(homeDir, ".zshrc"),
    path.join(homeDir, ".zprofile"),
  ]
  const re = new RegExp(
    `\\n?${escapeRegExp(FIRST_LAUNCH_PATH_MARKER_START)}[\\s\\S]*?${escapeRegExp(
      FIRST_LAUNCH_PATH_MARKER_END,
    )}\\n?`,
    "g",
  )
  const modified: Array<string> = []
  for (const rc of rcFiles) {
    let existing: string
    try {
      existing = fs.readFileSync(rc, "utf8")
    } catch {
      continue
    }
    if (!existing.includes(FIRST_LAUNCH_PATH_MARKER_START)) continue
    try {
      fs.writeFileSync(rc, existing.replace(re, "\n"))
      modified.push(rc)
    } catch {
      /* best effort */
    }
  }
  return modified
}

// ────────────────────────────────────────────────────────────────────
// Step 4a: purge secrets + tokens.
// ────────────────────────────────────────────────────────────────────

async function maybePurgeSecrets(opts: RunUninstallOptions): Promise<void> {
  const secretsDir = path.join(PATHS.APP_DIR, "secrets")
  const tokenPath = PATHS.GITHUB_TOKEN_PATH
  const willPurge = opts.purge || (await confirmPurge(opts))
  if (!willPurge) {
    consola.info(`  ℹ secrets dir kept (${secretsDir}); use --purge to remove`)
    consola.info(`  ℹ github token kept (${tokenPath})`)
    return
  }
  if (fs.existsSync(secretsDir)) {
    try {
      fs.rmSync(secretsDir, { recursive: true })
      consola.success(`  removed ${secretsDir}`)
    } catch (err) {
      consola.warn(`  could not remove ${secretsDir}`, err)
    }
  }
  if (fs.existsSync(tokenPath)) {
    try {
      fs.rmSync(tokenPath)
      consola.success(`  removed ${tokenPath}`)
    } catch (err) {
      consola.warn(`  could not remove ${tokenPath}`, err)
    }
  }
}

async function confirmPurge(opts: RunUninstallOptions): Promise<boolean> {
  if (opts.unattended) return false
  const answer = await consola.prompt(
    "Remove secrets directory and GitHub token? (default: no)",
    { type: "confirm", initial: false },
  )
  return answer
}

// ────────────────────────────────────────────────────────────────────
// Step 4b: revert Claude Desktop config.
// ────────────────────────────────────────────────────────────────────

async function maybeRevertClaude(opts: RunUninstallOptions): Promise<void> {
  const willRevert = opts.revertClaude || (await confirmRevertClaude(opts))
  if (!willRevert) {
    consola.info(
      "  ℹ Claude Desktop config left as-is; use --revert-claude to clean up",
    )
    return
  }
  try {
    const result = revertProxyConfig()
    if (result.wrote) {
      if (result.remainingKeys.length === 0) {
        consola.success(`  removed ${result.path} (was only our keys)`)
      } else {
        consola.success(
          `  stripped our keys from ${result.path} (${result.remainingKeys.length} other keys preserved)`,
        )
      }
    } else {
      consola.info(
        "  Claude Desktop config didn't have our keys; nothing to do",
      )
    }
  } catch (err) {
    consola.warn("  could not revert Claude Desktop config", err)
  }
}

async function confirmRevertClaude(
  opts: RunUninstallOptions,
): Promise<boolean> {
  if (opts.unattended) return false
  const answer = await consola.prompt(
    "Remove our keys from Claude Desktop config? (default: no)",
    { type: "confirm", initial: false },
  )
  return answer
}

// ────────────────────────────────────────────────────────────────────
// citty wrapper.
// ────────────────────────────────────────────────────────────────────

export const uninstall = defineCommand({
  meta: {
    name: "uninstall",
    description:
      "Stop the proxy, remove the binary, optionally purge secrets and revert Claude Desktop config",
  },
  args: {
    purge: {
      type: "boolean",
      default: false,
      description:
        "Also remove ~/.local/share/maximal/secrets and the GitHub token",
    },
    "revert-claude": {
      type: "boolean",
      default: false,
      description: "Also remove our keys from claude_desktop_config.json",
    },
    unattended: {
      type: "boolean",
      default: false,
      description:
        "No prompts. Combined with default flags, leaves secrets and Claude config untouched.",
    },
  },
  run({ args }) {
    return runUninstall({
      purge: args.purge,
      revertClaude: args["revert-claude"],
      unattended: args.unattended,
    })
  },
})
