/**
 * CLI-on-PATH plumbing shared by `maximal start` (the first-launch
 * shim), `maximal uninstall` (teardown), and diagnostics.
 *
 * Two concerns live here because both turn on the same fact — *where
 * the running binary was launched from* (`process.execPath`):
 *
 *  1. `ensureCliSymlink()` — the macOS DMG first-launch shim. The
 *     `.app` bundle ships its CLI at
 *     `…/Maximal.app/Contents/MacOS/maximal`, which is NOT on any
 *     default PATH. So on first launch from the bundle we drop a
 *     **symlink** (never a copy — no duplication, tracks app updates)
 *     into `~/.local/bin`. Per policy: if `~/.local/bin` already
 *     exists we treat it as an existing XDG bin dir and leave shell
 *     profiles untouched (open terminals keep working, no restart); if
 *     it doesn't, we create it and append a PATH block to `~/.zprofile`
 *     (new terminals pick it up). Homebrew installs already land on
 *     PATH and the dev build runs from `target/…`, so neither is an
 *     `.app` bundle and neither gets a managed symlink.
 *
 *  2. `describeLaunchSource()` — classify the launch path for the
 *     Settings → Diagnostics readout, so a brew launch and a DMG
 *     launch are distinguishable at a glance in a bug report.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** Markers bracketing the first-launch PATH block we append to the
 *  user's zsh login profile. Shared with `uninstall.ts`, whose
 *  teardown strips exactly this block. Changing either string is a
 *  breaking change for already-installed users — the old block would
 *  no longer be recognized for removal. */
export const FIRST_LAUNCH_PATH_MARKER_START = "# >>> maximal PATH >>>"
export const FIRST_LAUNCH_PATH_MARKER_END = "# <<< maximal PATH <<<"

/** The single PATH line our block exports. `$HOME/.local/bin` is the
 *  XDG-style user bin dir we symlink the CLI into. */
const PATH_BLOCK_BODY = 'export PATH="$HOME/.local/bin:$PATH"'

/** True when `execPath` points inside a macOS `.app` bundle's
 *  executable dir — i.e. the binary is the DMG-installed app's CLI,
 *  not a Homebrew/dev/standalone binary. */
export function isAppBundlePath(execPath: string): boolean {
  return /\.app\/Contents\/MacOS\//u.test(execPath)
}

export interface LaunchSource {
  /** Absolute path the current process was launched from. */
  path: string
  /** Coarse origin classification, for human-readable diagnostics. */
  kind: "dmg-app" | "homebrew" | "user-bin" | "dev" | "other"
}

/** Classify where the running binary came from. Pure — takes the
 *  exec path so it's trivially testable across the install shapes. */
export function describeLaunchSource(
  execPath: string = process.execPath,
): LaunchSource {
  if (isAppBundlePath(execPath)) return { path: execPath, kind: "dmg-app" }
  // Dev first: `bun src/main.ts` runs from a `bun` interpreter (often
  // itself Homebrew-installed at /opt/homebrew/bin/bun), and the Tauri
  // dev build runs from `target/debug|release/`. Check these before the
  // Homebrew prefix so a brew-installed `bun` isn't misread as a brew
  // *maximal* install.
  if (
    /\/target\/(?:debug|release)\//u.test(execPath)
    || /\/bun$/u.test(execPath)
  )
    return { path: execPath, kind: "dev" }
  // Apple Silicon brew is /opt/homebrew/{bin,Cellar}; Intel is
  // /usr/local/Cellar. Match the cellar or the brew prefix.
  if (/\/(?:homebrew|Cellar)\//u.test(execPath))
    return { path: execPath, kind: "homebrew" }
  if (execPath.includes("/.local/bin/"))
    return { path: execPath, kind: "user-bin" }
  return { path: execPath, kind: "other" }
}

export interface CliSymlinkResult {
  /** The symlink path we manage (`~/.local/bin/maximal`). */
  symlinkPath: string
  /** Where it points (the running `.app` bundle CLI). */
  target: string
  /** Did we create or refresh the symlink this run? */
  linked: boolean
  /** Did we have to create `~/.local/bin`? */
  binDirCreated: boolean
  /** Did we append the PATH block to a shell profile? */
  pathBlockAdded: boolean
  /** Set when we did nothing; a short machine-readable reason. */
  skipped?: "not-macos" | "not-app-bundle" | "foreign-file-at-target"
}

interface EnsureCliSymlinkOptions {
  execPath?: string
  home?: string
  platform?: NodeJS.Platform
}

/**
 * Idempotent macOS first-launch shim. Safe to call on every boot:
 * once the symlink exists and points at the running binary it's a
 * no-op. Best-effort throughout — a permissions failure degrades to a
 * skip rather than blocking server start.
 *
 * Only acts when the running binary is a `.app`-bundle CLI; Homebrew,
 * dev, and standalone launches return a `skipped` result untouched.
 */
export function ensureCliSymlink(
  opts: EnsureCliSymlinkOptions = {},
): CliSymlinkResult {
  const execPath = opts.execPath ?? process.execPath
  const home = opts.home ?? os.homedir()
  const platform = opts.platform ?? process.platform

  const binDir = path.join(home, ".local", "bin")
  const symlinkPath = path.join(binDir, "maximal")
  const base: CliSymlinkResult = {
    symlinkPath,
    target: execPath,
    linked: false,
    binDirCreated: false,
    pathBlockAdded: false,
  }

  // Windows ships PATH via the MSI/installer registry entry; only the
  // macOS bundle needs this shim.
  if (platform !== "darwin") return { ...base, skipped: "not-macos" }
  if (!isAppBundlePath(execPath)) return { ...base, skipped: "not-app-bundle" }

  // Policy: directory existence alone decides whether we touch shell
  // profiles. We deliberately do NOT inspect $PATH — a GUI-launched
  // sidecar inherits launchd's minimal PATH, not the user's interactive
  // shell PATH, so an "is ~/.local/bin on PATH?" check from here is
  // unreliable. An existing dir is assumed to already be a PATH dir.
  const binDirExisted = fs.existsSync(binDir)
  let binDirCreated = false
  if (!binDirExisted) {
    try {
      fs.mkdirSync(binDir, { recursive: true })
      binDirCreated = true
    } catch {
      // Can't create the bin dir → nothing else will work; bail soft.
      return base
    }
  }

  // Refuse to clobber a non-symlink the user owns. We manage only our
  // own symlink (or an empty slot); a real file named `maximal` here is
  // left alone. (Pre-symlink installs that *copied* a binary keep their
  // copy until uninstall; the field-report case is a fresh slot.)
  let existing: fs.Stats | undefined
  try {
    existing = fs.lstatSync(symlinkPath)
  } catch {
    existing = undefined
  }
  if (existing && !existing.isSymbolicLink()) {
    return { ...base, binDirCreated, skipped: "foreign-file-at-target" }
  }

  const linked = relinkIfStale(symlinkPath, execPath, existing !== undefined)

  // Only edit shell profiles when we just created the bin dir. An
  // already-present dir is treated as an existing XDG bin dir the user
  // already has on PATH — touching their profile would be noise and
  // would (uselessly, given the launchd-PATH caveat) churn the rc file.
  const pathBlockAdded = binDirCreated ? addFirstLaunchPathBlock(home) : false

  return {
    symlinkPath,
    target: execPath,
    linked,
    binDirCreated,
    pathBlockAdded,
  }
}

/** (Re)point `symlinkPath` at `target` if it isn't already. `present`
 *  says whether a symlink currently occupies the path (the caller has
 *  already verified it's a symlink, not a foreign file). Returns true
 *  iff we wrote a new link this call. Best-effort — a failure leaves
 *  whatever was there and returns false. */
function relinkIfStale(
  symlinkPath: string,
  target: string,
  present: boolean,
): boolean {
  let currentTarget: string | undefined
  if (present) {
    try {
      currentTarget = fs.readlinkSync(symlinkPath)
    } catch {
      currentTarget = undefined
    }
  }
  if (currentTarget === target) return false
  try {
    if (present) fs.unlinkSync(symlinkPath)
    fs.symlinkSync(target, symlinkPath)
    return true
  } catch {
    return false
  }
}

/**
 * Append the marker-bracketed PATH block to `~/.zprofile` (created if
 * absent). zsh login shells — which macOS Terminal.app and iTerm2 spawn
 * for every new window — source `.zprofile`, so the dir lands on PATH in
 * new terminals. Idempotent: if the block is already present we skip.
 * Returns true iff we wrote. Best-effort (an unwritable profile is
 * swallowed). The matching teardown is `uninstall.removeFirstLaunchPathBlock`.
 */
export function addFirstLaunchPathBlock(home: string = os.homedir()): boolean {
  const rc = path.join(home, ".zprofile")
  let existing: string
  try {
    existing = fs.readFileSync(rc, "utf8")
  } catch {
    existing = ""
  }
  if (existing.includes(FIRST_LAUNCH_PATH_MARKER_START)) return false
  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n")
  const block = [
    FIRST_LAUNCH_PATH_MARKER_START,
    PATH_BLOCK_BODY,
    FIRST_LAUNCH_PATH_MARKER_END,
    "",
  ].join("\n")
  try {
    fs.writeFileSync(rc, existing + (needsLeadingNewline ? "\n" : "") + block)
    return true
  } catch {
    return false
  }
}
