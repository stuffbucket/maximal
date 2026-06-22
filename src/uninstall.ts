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
import { revertConfigLibraryProfile } from "./lib/claude-desktop-3p-config"
import {
  FIRST_LAUNCH_PATH_MARKER_END,
  FIRST_LAUNCH_PATH_MARKER_START,
} from "./lib/cli-path"
import { PATHS } from "./lib/paths"

interface RunUninstallOptions {
  purge: boolean
  revertClaude: boolean
  unattended: boolean
  /** When true, leave the application bundle (`/Applications/maximal.app`)
   *  on disk while still removing the `~/.local/bin/maximal` symlink and the
   *  other PATH binaries. Used by the in-app uninstall: the running `.app`
   *  can't delete itself, so the user drags it to the Trash afterwards. */
  keepApp: boolean
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
  removeBinary({ keepApp: opts.keepApp })

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
  /** True for the macOS application bundle (`/Applications/maximal.app`).
   *  The in-app uninstall (`keepApp`) filters these out so the running
   *  bundle survives — the user trashes it afterwards. */
  appBundle?: boolean
}

interface InstallTargetOptions {
  /** Skip the application bundle (the running `.app`) — see `keepApp`. */
  keepApp?: boolean
}

/** Candidate install locations, in order of likelihood. We delete
 *  every one we find; users may have copies in multiple places (e.g.
 *  `brew install` + a `.dmg` install both leave a binary on disk).
 *
 *  macOS .dmg install path: `/Applications/maximal.app` (the
 *  bundle) plus `~/.local/bin/maximal` (a **symlink** into the bundle
 *  created by the first-launch shim — see lib/cli-path.ts;
 *  pre-v0.4.x installs left a copy there instead, which this also
 *  removes). Brew installs at `/opt/homebrew/bin/maximal`.
 *
 *  With `keepApp`, the `.app` bundle is omitted (the in-app uninstall
 *  can't delete the bundle it's running from), but the PATH symlink and
 *  the other binaries are still removed. */
export function installTargets(
  opts: InstallTargetOptions = {},
): Array<InstallTarget> {
  const home = os.homedir()
  if (process.platform === "win32") {
    return [
      {
        path: path.join(
          process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
          "Programs",
          "maximal",
          "maximal.exe",
        ),
      },
      // The PowerShell installer's parent dir gets removed when it
      // becomes empty; we don't recurse into it ourselves to avoid
      // nuking unrelated files.
    ]
  }
  const targets: Array<InstallTarget> = [
    { path: path.join(home, ".local", "bin", "maximal") },
    { path: "/usr/local/bin/maximal" },
    { path: "/opt/homebrew/bin/maximal" },
    { path: "/Applications/maximal.app", recursive: true, appBundle: true },
  ]
  return opts.keepApp ? targets.filter((t) => !t.appBundle) : targets
}

function removeBinary(opts: InstallTargetOptions = {}): void {
  let removed = 0
  for (const target of installTargets(opts)) {
    // lstat (not existsSync) so a *broken* symlink — e.g.
    // ~/.local/bin/maximal pointing at a Maximal.app that's already
    // been dragged to the Trash — is still detected and unlinked
    // rather than silently skipped as "not found".
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(target.path)
    } catch {
      continue
    }
    try {
      fs.rmSync(
        target.path,
        target.recursive && !stat.isSymbolicLink() ?
          { recursive: true }
        : undefined,
      )
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
  // Both token stores: the legacy single-record file and the multi-account
  // registry. Purge must take both, or --purge leaves every account's token
  // on disk in accounts.json.
  const tokenPaths = [PATHS.GITHUB_TOKEN_PATH, PATHS.ACCOUNTS_PATH]
  const willPurge = opts.purge || (await confirmPurge(opts))
  if (!willPurge) {
    consola.info(`  ℹ secrets dir kept (${secretsDir}); use --purge to remove`)
    consola.info(`  ℹ github tokens kept (${tokenPaths.join(", ")})`)
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
  for (const tokenPath of tokenPaths) {
    if (!fs.existsSync(tokenPath)) continue
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
    const result = revertConfigLibraryProfile()
    if (result.reverted) {
      consola.success(`  removed our gateway profile from ${result.dir}`)
    } else {
      consola.info("  Claude Desktop wasn't wired by us; nothing to do")
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
    "keep-app": {
      type: "boolean",
      default: false,
      description:
        "Leave /Applications/maximal.app in place (still removes the ~/.local/bin/maximal symlink and other PATH binaries). Used by the in-app uninstall, which can't delete the running bundle.",
    },
  },
  run({ args }) {
    return runUninstall({
      purge: args.purge,
      revertClaude: args["revert-claude"],
      unattended: args.unattended,
      keepApp: args["keep-app"],
    })
  },
})
