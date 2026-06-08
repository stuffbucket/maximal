/**
 * Detection + PATH-shim management for the `claude` CLI (Claude Code).
 *
 * "Detection" finds the `claude` that's actually active — the first real
 * `claude` on PATH (an in-process PATH walk, no subprocess). Only when
 * nothing is active on PATH does it fall back to probing known install
 * dirs and npm-global. An npm- or Homebrew-installed claude that is the
 * active one is on PATH too, so it's still found; copies that exist but
 * aren't active are intentionally ignored.
 *
 * "Shim" is a tiny `/bin/sh` wrapper we drop in a dedicated directory
 * (`~/.local/share/maximal/shims/`) as a file named `claude`. It sets
 * `ANTHROPIC_BASE_URL` (and optionally `ANTHROPIC_API_KEY`) and then
 * `exec`s the *real* binary the user picked. It carries a
 * marker comment so we can (a) recognise our own shim and skip it in
 * the install list, and (b) refuse to ever clobber or delete a file
 * that is NOT our shim.
 *
 * Everything is parameterised by `homeDir` (and, for detection, the
 * PATH directory list / npm prefix / version reader) so the unit tests
 * can point at a tmp dir and fake binaries instead of the host machine.
 */

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** Marker line embedded in every shim we write. Detection treats any
 *  candidate file containing this as our shim (not a real install), and
 *  the clobber/remove guards key off it. */
export const SHIM_MARKER = "# __MAXIMAL_CLAUDE_SHIM__"

export type ClaudeInstallSource =
  | "homebrew"
  | "npm-global"
  | "local-bin"
  | "claude-local"
  | "path"

export interface ClaudeInstall {
  /** The stable handle to invoke — the path as discovered (on PATH or a
   *  known install dir), NOT symlink-resolved. For the native installer
   *  this is `~/.local/bin/claude`, the symlink the installer repoints on
   *  every background auto-update. The shim must exec THIS, not a pinned
   *  version, or it breaks the next time Claude Code updates itself. */
  path: string
  /** Symlink-resolved real path. Used to de-dupe installs reachable via
   *  several handles and to recognise (and skip) our own shim. Not what
   *  we exec — see `path`. */
  resolvedPath: string
  /** Trimmed `--version` output, or null when it couldn't be read. */
  version: string | null
  /** Best-effort classification of how it was installed. */
  source: ClaudeInstallSource
}

export interface DetectOptions {
  homeDir?: string
  /** PATH directories to scan. Defaults to splitting `process.env.PATH`. */
  pathDirs?: Array<string>
  /** npm global prefix; `null` disables npm probing. Defaults to
   *  `npm prefix -g` (best-effort, tolerates npm being absent). */
  npmPrefix?: string | null
  /** Injectable version reader so tests don't exec real binaries. */
  readVersion?: (binPath: string) => string | null
}

function defaultPathDirs(): Array<string> {
  const raw = process.env.PATH ?? ""
  return raw.split(path.delimiter).filter((d) => d.length > 0)
}

function defaultNpmPrefix(): string | null {
  try {
    const out = execFileSync("npm", ["prefix", "-g"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const trimmed = out.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

/** Read `<bin> --version`, returning a trimmed semver-ish string. Any
 *  failure (missing, non-zero exit, timeout) yields null. */
export function readClaudeVersion(binPath: string): string | null {
  let out: string
  try {
    out = execFileSync(binPath, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch {
    return null
  }
  const trimmed = out.trim()
  if (!trimmed) return null
  const semver = /\d+\.\d+\.\d+/u.exec(trimmed)
  return semver ? semver[0] : trimmed
}

/**
 * Does the START of a file contain `needle`? Reads only a bounded prefix
 * (the first 4 KB) — never the whole file. This matters: our shim marker
 * always sits on line 2 of a ~1 KB shell script, but a real `claude` is a
 * 200 MB+ compiled binary. Reading the whole file to look for the marker
 * cost ~0.7s PER candidate and made detection (and the Apps toggle that
 * calls it) take many seconds. A prefix read is effectively free and
 * still catches every shim we write. We read a bounded prefix because a
 * real `claude` can be a 200 MB+ binary and reading it whole is slow.
 */
function fileStartsWithContains(filePath: string, needle: string): boolean {
  let fd: number
  try {
    fd = fs.openSync(filePath, "r")
  } catch {
    return false
  }
  try {
    const buf = Buffer.alloc(4096)
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0)
    return buf.toString("utf8", 0, bytes).includes(needle)
  } catch {
    return false
  } finally {
    fs.closeSync(fd)
  }
}

/** Symlink-resolve a path, falling back to the input when it can't be
 *  resolved (e.g. doesn't exist). Used to normalise prefixes before
 *  comparing them against an already-resolved binary path. */
function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

/** A candidate path plus the origin we discovered it from — used to
 *  classify the source after resolving symlinks. */
interface Candidate {
  raw: string
  origin: ClaudeInstallSource
}

function classifySource(
  resolved: string,
  ctx: { origin: ClaudeInstallSource; home: string; npmBin: string | null },
): ClaudeInstallSource {
  const { origin } = ctx
  const sep = path.sep
  // `resolved` is symlink-resolved (fs.realpathSync). Resolve the prefixes
  // the same way before comparing, otherwise a symlinked home (e.g. macOS
  // /tmp → /private/tmp, or a home on a symlinked volume) makes every
  // startsWith() silently miss and the install gets mislabeled "path".
  const home = realpathOrSelf(ctx.home)
  const npmBin = ctx.npmBin === null ? null : realpathOrSelf(ctx.npmBin)
  if (resolved.startsWith(path.join(home, ".claude") + sep)) {
    return "claude-local"
  }
  if (resolved.startsWith(path.join(home, ".local", "bin") + sep)) {
    return "local-bin"
  }
  // Honour a specific discovery origin (npm/homebrew) before falling
  // back to path-prefix heuristics, since a Homebrew-managed npm bin
  // resolves under the Homebrew prefix and would otherwise mis-classify.
  if (origin !== "path") {
    return origin
  }
  if (npmBin && resolved.startsWith(npmBin + sep)) {
    return "npm-global"
  }
  if (
    resolved.startsWith("/opt/homebrew/")
    || resolved.startsWith("/usr/local/")
  ) {
    return "homebrew"
  }
  return "path"
}

/**
 * Inspect one candidate path. Returns a `ClaudeInstall` when it's a real
 * (non-shim, not-yet-seen) `claude`, or null otherwise. `seen` is mutated
 * to de-dupe by resolved real path across candidates.
 */
function inspectCandidate(
  candidate: Candidate,
  ctx: {
    home: string
    npmBin: string | null
    readVersion: (binPath: string) => string | null
    seen: Set<string>
  },
): ClaudeInstall | null {
  let stat: fs.Stats
  try {
    stat = fs.statSync(candidate.raw)
  } catch {
    return null
  }
  if (!stat.isFile()) return null

  // Our own shim is not an install. Check before resolving so a shim
  // symlinked elsewhere still gets excluded.
  if (fileStartsWithContains(candidate.raw, SHIM_MARKER)) return null

  let resolved: string
  try {
    resolved = fs.realpathSync(candidate.raw)
  } catch {
    resolved = candidate.raw
  }
  if (fileStartsWithContains(resolved, SHIM_MARKER)) return null
  if (ctx.seen.has(resolved)) return null
  ctx.seen.add(resolved)

  return {
    // `candidate.raw` is the stable handle (symlink/bin entry), NOT the
    // version-resolved path — exec'ing this follows auto-updates.
    path: candidate.raw,
    resolvedPath: resolved,
    version: ctx.readVersion(candidate.raw),
    source: classifySource(resolved, {
      origin: candidate.origin,
      home: ctx.home,
      npmBin: ctx.npmBin,
    }),
  }
}

/**
 * Find the `claude` install(s) worth offering.
 *
 * Phase 1 — the ACTIVE claude: the first real (non-shim) `claude` on PATH.
 * That's the binary that runs when the user types `claude`, and the only
 * one we need to shim. It's an in-process PATH walk (no subprocess), so a
 * normal setup resolves in well under a millisecond plus one `--version`
 * on the winner. An npm- or Homebrew-installed claude that is actually
 * active is on PATH too, so this finds it without probing npm — installs
 * that exist but aren't active are intentionally ignored.
 *
 * Phase 2 — fallback: only when nothing is active on PATH. Probe the known
 * install dirs (and npm-global, which costs an `npm prefix -g` subprocess)
 * so we can still surface an installed-but-not-on-PATH claude for the user
 * to enable. The npm subprocess is thus kept off the common-case hot path.
 */
export function detectClaudeInstalls(
  options: DetectOptions = {},
): Array<ClaudeInstall> {
  const home = options.homeDir ?? os.homedir()
  const pathDirs = options.pathDirs ?? defaultPathDirs()
  const readVersion = options.readVersion ?? readClaudeVersion
  const seen = new Set<string>()

  // Phase 1: active claude on PATH. Only honour an EXPLICIT npmPrefix for
  // classification here — never probe (that's the cost we're avoiding).
  const explicitNpm = options.npmPrefix
  const phase1NpmBin =
    typeof explicitNpm === "string" ? path.join(explicitNpm, "bin") : null
  for (const dir of pathDirs) {
    const inst = inspectCandidate(
      { raw: path.join(dir, "claude"), origin: "path" },
      { home, npmBin: phase1NpmBin, readVersion, seen },
    )
    if (inst) return [inst]
  }

  // Phase 2: nothing active on PATH — probe known locations + npm-global.
  const npmPrefix = explicitNpm === undefined ? defaultNpmPrefix() : explicitNpm
  const npmBin = npmPrefix ? path.join(npmPrefix, "bin") : null
  const fallback: Array<Candidate> = [
    { raw: "/opt/homebrew/bin/claude", origin: "homebrew" },
    { raw: "/usr/local/bin/claude", origin: "homebrew" },
    { raw: path.join(home, ".local", "bin", "claude"), origin: "local-bin" },
    {
      raw: path.join(home, ".claude", "local", "claude"),
      origin: "claude-local",
    },
    {
      raw: path.join(home, ".claude", "bin", "claude"),
      origin: "claude-local",
    },
    { raw: path.join(home, ".claude", "claude"), origin: "claude-local" },
  ]
  if (npmBin) {
    fallback.push({ raw: path.join(npmBin, "claude"), origin: "npm-global" })
  }

  const installs: Array<ClaudeInstall> = []
  for (const candidate of fallback) {
    const inst = inspectCandidate(candidate, {
      home,
      npmBin,
      readVersion,
      seen,
    })
    if (inst) installs.push(inst)
  }
  return installs
}
