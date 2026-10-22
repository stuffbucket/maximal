#!/usr/bin/env node
/**
 * `maximal uninstall` — reverse of `setup`.
 *
 * Stops the running proxy (launchd / Windows scheduled task), removes
 * app-owned installation artifacts, and reverts every app integration through
 * the registry
 * (`getAllApps()` → each app's ownership-guarded `uninstall()`). Refuses to run
 * while any app is still enabled — naming them — unless `--force`, which
 * disables each app first, then uninstalls. Secrets are kept by default; pass
 * `--purge` to remove them.
 */

import { defineCommand } from "citty"
import consola from "consola"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ClientApp } from "./apps/index"

import { getAllApps } from "./apps/registry"
import { PATHS } from "./lib/platform/paths"

interface RunUninstallOptions {
  purge: boolean
  /** When true, uninstall even if apps are still enabled: disable each app
   *  (idempotent) first, then run the registry revert sweep. Without it,
   *  uninstall refuses while any app is enabled. Replaces the old
   *  `--revert-claude` opt-in. */
  force: boolean
  unattended: boolean
  /** When true, leave the application bundle (`/Applications/Maximal.app`)
   *  on disk while still removing app-owned service files and any legacy CLI
   *  symlink. Used by the in-app uninstall: the running `.app` can't delete
   *  itself. */
  keepApp: boolean
  /** Injectable environment keeps destructive operations contained in tests. */
  homeDir?: string
  platform?: NodeJS.Platform
  appBundlePath?: string
  dataDir?: string
  spawn?: typeof spawnSync
}

export async function runUninstall(opts: RunUninstallOptions): Promise<void> {
  consola.box("maximal uninstall")
  const homeDir = opts.homeDir ?? os.homedir()
  const platform = opts.platform ?? process.platform
  const appBundlePath = opts.appBundlePath
  const dataDir = opts.dataDir ?? PATHS.APP_DIR
  const spawn = opts.spawn ?? spawnSync

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
  stopProxy(platform, spawn)

  // 2. Remove launchd plist / Windows scheduled task ----------------
  consola.info("Step 2/5: Remove startup integration")
  removeStartupIntegration(homeDir, platform, spawn)

  // 3. Remove app-owned installation artifacts -----------------------
  consola.info("Step 3/5: Remove app-owned installation artifacts")
  removeBinary({
    keepApp: opts.keepApp,
    homeDir,
    platform,
    appBundlePath,
  })

  // 4. Revert any residual app integrations --------------------------
  // Registry-driven: each app reverts its own ownership-guarded config. With
  // the precondition above every app is already disabled, so this is a
  // defensive sweep.
  consola.info("Step 4/5: Revert app integrations")
  await revertAppIntegrations(enabled)

  // 5. Optional: secrets --------------------------------------------
  consola.info("Step 5/5: Optional cleanup")
  await maybePurgeSecrets(opts, dataDir)

  consola.box("Uninstall complete.")
}

// ────────────────────────────────────────────────────────────────────
// Step 1: stop the proxy.
// ────────────────────────────────────────────────────────────────────

function stopProxy(platform: NodeJS.Platform, spawn: typeof spawnSync): void {
  if (platform === "darwin") {
    const r = spawn(
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
  if (platform === "win32") {
    const broker = spawn(
      "taskkill",
      ["/F", "/IM", "maximal-mcp-broker.exe", "/T"],
      { encoding: "utf8" },
    )
    if (broker.status === 0) {
      consola.success("  MCP broker stopped")
    } else {
      consola.info("  MCP broker not running")
    }

    const r = spawn("schtasks", ["/End", "/TN", "maximal"], {
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

function removeStartupIntegration(
  homeDir: string,
  platform: NodeJS.Platform,
  spawn: typeof spawnSync,
): void {
  if (platform === "darwin") {
    const plist = path.join(
      homeDir,
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
  if (platform === "win32") {
    const r = spawn("schtasks", ["/Delete", "/TN", "maximal", "/F"], {
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
// Step 3: remove installed binaries.
// ────────────────────────────────────────────────────────────────────

interface InstallTarget {
  path: string
  /** Directory targets (the macOS .app bundle is one) need recursive
   *  removal; single-file binaries don't. */
  recursive?: boolean
  /** True for the macOS application bundle (`/Applications/Maximal.app`). */
  appBundle?: boolean
  /** Remove only when this path is a symlink into Maximal.app. */
  appCliSymlink?: boolean
}

interface InstallTargetOptions {
  /** Skip the application bundle (the running `.app`) — see `keepApp`. */
  keepApp?: boolean
  /** Injectable platform inputs keep target selection deterministic in tests. */
  platform?: NodeJS.Platform
  homeDir?: string
  appBundlePath?: string
}

/** App-owned install locations. Package-manager paths are deliberately absent:
 *  Homebrew/MSI own their binaries, links, updates, and uninstallation.
 *
 *  The legacy DMG template's Application Support service binary is app-owned.
 *  Older installs may also have left `~/.local/bin/maximal`; cleanup may remove
 *  that path only when it is a symlink into Maximal.app. Regular files and
 *  foreign links remain user-owned. */
export function installTargets(
  opts: InstallTargetOptions = {},
): Array<InstallTarget> {
  const home = opts.homeDir ?? os.homedir()
  const platform = opts.platform ?? process.platform
  if (platform !== "darwin") return []
  const appBundlePaths =
    opts.appBundlePath ?
      [opts.appBundlePath]
    : ["/Applications/Maximal.app", "/Applications/maximal.app"]
  const targets: Array<InstallTarget> = [
    {
      path: path.join(home, ".local", "bin", "maximal"),
      appCliSymlink: true,
    },
    {
      path: path.join(
        home,
        "Library",
        "Application Support",
        "Maximal",
        "bin",
        "maximal",
      ),
    },
    ...appBundlePaths.map((bundlePath) => ({
      path: bundlePath,
      recursive: true,
      appBundle: true,
    })),
  ]
  return opts.keepApp ? targets.filter((t) => !t.appBundle) : targets
}

const LEGACY_APP_EXECUTABLES = new Set([
  "/Applications/Maximal.app/Contents/MacOS/maximal",
  "/Applications/maximal.app/Contents/MacOS/maximal",
])

export function isAppOwnedCliSymlink(linkPath: string): boolean {
  let target: string
  try {
    target = fs.readlinkSync(linkPath)
  } catch {
    return false
  }
  const resolved = path.resolve(path.dirname(linkPath), target)
  return LEGACY_APP_EXECUTABLES.has(resolved)
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
    if (
      target.appCliSymlink
      && (!stat.isSymbolicLink() || !isAppOwnedCliSymlink(target.path))
    ) {
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
    consola.info("  no installed binaries found")
  }
}

// ────────────────────────────────────────────────────────────────────
// Step 4: disable + revert app integrations (registry).
// ────────────────────────────────────────────────────────────────────

/** Apps currently routing through the proxy, by the contract's `isEnabled()`.
 *  Drives both the precondition message and the `--force` disable pass — no
 *  per-app knowledge lives here. */
export function enabledApps(): Array<ClientApp> {
  return getAllApps().filter((app) => app.isEnabled())
}

/**
 * Revert every app's integration via the registry. `stillEnabled` are the apps
 * that were on at invocation (only non-empty under `--force`): we `disable()`
 * each first so routing is cleaned, not orphaned. Then every app's `uninstall()`
 * runs as an ownership-guarded sweep (idempotent for already-disabled apps).
 */
export async function revertAppIntegrations(
  stillEnabled: ReadonlyArray<ClientApp>,
): Promise<void> {
  for (const app of stillEnabled) {
    try {
      const result = await app.disable()
      if (result.success) {
        consola.success(`  disabled ${app.name}`)
      } else {
        consola.warn(
          `  ${app.name} requires manual cleanup`,
          result.conflict ?? "unknown-conflict",
        )
      }
    } catch (err) {
      consola.warn(`  could not disable ${app.name}`, err)
    }
  }
  for (const app of getAllApps()) {
    try {
      const result = await app.uninstall()
      for (const line of result.reverted) consola.success(`  ${line}`)
      if (result.conflict) {
        consola.warn(`  ${app.name} requires manual cleanup`, result.conflict)
      }
    } catch (err) {
      consola.warn(`  could not revert ${app.name}`, err)
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// Step 4a: purge secrets + tokens.
// ────────────────────────────────────────────────────────────────────

async function maybePurgeSecrets(
  opts: RunUninstallOptions,
  dataDir: string,
): Promise<void> {
  const secretsDir = path.join(dataDir, "secrets")
  // Both token stores: the legacy single-record file and the multi-account
  // registry. Purge must take both, or --purge leaves every account's token
  // on disk in accounts.json.
  const tokenPaths = [
    path.join(dataDir, path.basename(PATHS.GITHUB_TOKEN_PATH)),
    path.join(dataDir, path.basename(PATHS.ACCOUNTS_PATH)),
  ]
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
      "Stop the proxy, remove app-owned installation artifacts, and revert app integrations. Refuses while apps are enabled unless --force.",
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
        "Leave /Applications/Maximal.app in place (still removes app-owned service files and any legacy ~/.local/bin/maximal symlink). Used by the in-app uninstall, which can't delete the running bundle.",
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
