#!/usr/bin/env node
/**
 * `maximal uninstall` — reverse of `setup`.
 *
 * Stops the running proxy (launchd / Windows scheduled task), removes the
 * on-disk binary, and reverts every app integration through the registry
 * (`getAllApps()` → each app's ownership-guarded `uninstall()`). Refuses to run
 * while any app is still enabled — naming them — unless `--force`, which
 * disables each app first, then uninstalls. Secrets are kept by default; pass
 * `--purge` to remove them.
 *
 * Spec: docs/spec/archive/internal-distribution-stream-b.md §B6.
 */

import { defineCommand } from "citty"
import consola from "consola"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ClientApp } from "./apps/index"

import { getAllApps } from "./apps/registry"
import {
  FIRST_LAUNCH_PATH_MARKER_END,
  FIRST_LAUNCH_PATH_MARKER_START,
} from "./lib/cli-path"
import { PATHS } from "./lib/paths"

interface RunUninstallOptions {
  purge: boolean
  /** When true, uninstall even if apps are still enabled: disable each app
   *  (idempotent) first, then run the registry revert sweep. Without it,
   *  uninstall refuses while any app is enabled. Replaces the old
   *  `--revert-claude` opt-in. */
  force: boolean
  unattended: boolean
  /** When true, leave the application bundle (`/Applications/maximal.app`)
   *  on disk while still removing the `~/.local/bin/maximal` symlink and the
   *  other PATH binaries. Used by the in-app uninstall: the running `.app`
   *  can't delete itself, so the user drags it to the Trash afterwards. */
  keepApp: boolean
}

export async function runUninstall(opts: RunUninstallOptions): Promise<void> {
  consola.box("maximal uninstall")

  // Precondition: refuse while any app still routes through the proxy, UNLESS
  // --force. Uninstall removes maximal; it must not silently rip routing out
  // from under an integration the user left switched ON. Name the enabled apps
  // and fail with what to do. `--force` means "uninstall anyway": we disable
  // each app first (step 4), so routing is cleaned up rather than orphaned.
  // Checked via the registry's isEnabled(), so this needs no per-app knowledge.
  const enabled = enabledApps()
  if (enabled.length > 0 && !opts.force) {
    const names = enabled.map((a) => a.name).join(", ")
    consola.error(`These apps are still routing through maximal: ${names}.`)
    consola.info(
      "Turn them off in Settings → Apps (or e.g. `maximal app claude-code"
        + " --disable`), then re-run `maximal uninstall`. Or pass `--force` to"
        + " disable them and uninstall in one step.",
    )
    throw new Error(
      `Refusing to uninstall while apps are enabled: ${names}. Disable them or pass --force.`,
    )
  }

  // 1. Stop the running proxy (best effort) -------------------------
  consola.info("Step 1/5: Stop the running proxy")
  stopProxy()

  // 2. Remove launchd plist / Windows scheduled task ----------------
  consola.info("Step 2/5: Remove startup integration")
  removeStartupIntegration()

  // 3. Remove the binary --------------------------------------------
  consola.info("Step 3/5: Remove the binary")
  removeBinary({ keepApp: opts.keepApp })

  // 4. Revert any residual app integrations + installer PATH block ---
  // Registry-driven: each app reverts its own (ownership-guarded) config via the
  // contract. With the precondition above every app is already disabled, so this
  // is a defensive sweep — plus it strips maximal's own first-launch PATH block.
  consola.info("Step 4/5: Revert app integrations")
  await revertAppIntegrations(enabled)

  // 5. Optional: secrets --------------------------------------------
  consola.info("Step 5/5: Optional cleanup")
  await maybePurgeSecrets(opts)

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
// Step 4: disable + revert app integrations (registry), strip PATH block.
// ────────────────────────────────────────────────────────────────────

/** Apps currently routing through the proxy, by the contract's `isEnabled()`.
 *  Drives both the precondition message and the `--force` disable pass — no
 *  per-app knowledge lives here. */
export function enabledApps(): Array<ClientApp> {
  return getAllApps().filter((app) => app.isEnabled())
}

/**
 * Revert every app's integration via the registry, then strip maximal's own
 * first-launch installer PATH block. `stillEnabled` are the apps that were on
 * at invocation (only non-empty under `--force`): we `disable()` each first so
 * routing is cleaned, not orphaned. Then every app's `uninstall()` runs as an
 * ownership-guarded sweep (idempotent — safe even for already-disabled apps).
 * The PATH block is maximal's own artifact, not an app integration, so it stays
 * here rather than in any app.
 */
export async function revertAppIntegrations(
  stillEnabled: ReadonlyArray<ClientApp>,
): Promise<void> {
  for (const app of stillEnabled) {
    try {
      await app.disable()
      consola.success(`  disabled ${app.name}`)
    } catch (err) {
      consola.warn(`  could not disable ${app.name}`, err)
    }
  }
  for (const app of getAllApps()) {
    try {
      const result = await app.uninstall()
      for (const line of result.reverted) consola.success(`  ${line}`)
    } catch (err) {
      consola.warn(`  could not revert ${app.name}`, err)
    }
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
// citty wrapper.
// ────────────────────────────────────────────────────────────────────

export const uninstall = defineCommand({
  meta: {
    name: "uninstall",
    description:
      "Stop the proxy, remove the binary, and revert app integrations. Refuses while apps are enabled unless --force.",
  },
  args: {
    purge: {
      type: "boolean",
      default: false,
      description:
        "Also remove ~/.local/share/maximal/secrets and the GitHub token",
    },
    force: {
      type: "boolean",
      default: false,
      description:
        "Uninstall even if apps are still enabled: disable each app, then revert and remove. Without it, uninstall refuses while any app is enabled.",
    },
    unattended: {
      type: "boolean",
      default: false,
      description:
        "No prompts. Combined with default flags, leaves secrets untouched.",
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
      force: args.force,
      unattended: args.unattended,
      keepApp: args["keep-app"],
    })
  },
})
