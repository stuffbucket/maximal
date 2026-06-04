/**
 * Detection + PATH-shim management for the `claude` CLI (Claude Code).
 *
 * "Detection" finds every real `claude` binary across the install
 * methods we know about (Homebrew, npm global, the official curl
 * installer's `~/.local/bin`, the `~/.claude` local install, anything
 * on PATH), de-duplicating by resolved real path so a single binary
 * reachable via several routes is reported once.
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
  /** Resolved (symlinks followed) absolute path of the real binary. */
  path: string
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

function fileContains(filePath: string, needle: string): boolean {
  try {
    return fs.readFileSync(filePath, "utf8").includes(needle)
  } catch {
    return false
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
 * Find every real `claude` install, de-duped by resolved real path.
 * Our own shim is excluded (identified by its marker line).
 */
export function detectClaudeInstalls(
  options: DetectOptions = {},
): Array<ClaudeInstall> {
  const home = options.homeDir ?? os.homedir()
  const pathDirs = options.pathDirs ?? defaultPathDirs()
  const npmPrefix =
    options.npmPrefix === undefined ? defaultNpmPrefix() : options.npmPrefix
  const npmBin = npmPrefix ? path.join(npmPrefix, "bin") : null
  const readVersion = options.readVersion ?? readClaudeVersion

  const candidates: Array<Candidate> = []

  // 1. Everything reachable via PATH.
  for (const dir of pathDirs) {
    candidates.push({ raw: path.join(dir, "claude"), origin: "path" })
  }

  // 2. Common install locations, on PATH or not.
  candidates.push(
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
  )
  if (npmBin) {
    candidates.push({ raw: path.join(npmBin, "claude"), origin: "npm-global" })
  }

  const seen = new Set<string>()
  const installs: Array<ClaudeInstall> = []

  for (const candidate of candidates) {
    let stat: fs.Stats
    try {
      stat = fs.statSync(candidate.raw)
    } catch {
      continue
    }
    if (!stat.isFile()) continue

    // Our own shim is not an install. Check before resolving so a shim
    // symlinked elsewhere still gets excluded.
    if (fileContains(candidate.raw, SHIM_MARKER)) continue

    let resolved: string
    try {
      resolved = fs.realpathSync(candidate.raw)
    } catch {
      resolved = candidate.raw
    }
    if (fileContains(resolved, SHIM_MARKER)) continue
    if (seen.has(resolved)) continue
    seen.add(resolved)

    installs.push({
      path: resolved,
      version: readVersion(resolved),
      source: classifySource(resolved, {
        origin: candidate.origin,
        home,
        npmBin,
      }),
    })
  }

  return installs
}

// ---------------------------------------------------------------------------
// Shim management
// ---------------------------------------------------------------------------
//
// The shim lives in a DEDICATED directory we own —
// `~/.local/share/maximal/shims/` — not next to real binaries. That
// directory is what removes the collision with the user's real
// `~/.local/bin/claude` (the official installer's location): the user
// puts our shims dir ahead of it on PATH, and our file is simply named
// `claude` so it dispatches when invoked.
//
// Security model (the shim sits on PATH as `claude`, so a tampered shim
// would run with the user's shell):
//   - The shims directory is created 0700 (owner-only, incl. write).
//     No other non-root user can plant or edit a file inside it. We
//     verify ownership + mode before trusting it and refuse otherwise
//     (the StrictModes pattern from ssh).
//   - The file is written atomically: temp file (O_EXCL, no symlink
//     follow) → chmod 0700 → rename. The on-PATH `claude` only ever
//     appears as a complete, owner-written file, never a half-written
//     or attacker-pre-planted one. This closes the write-then-run TOCTOU
//     window.
//   - The script itself fails closed: a chain of guards each fall
//     through to the REAL claude with NO env override. An orphaned or
//     doubtful shim can never break the CLI or leak the API key to a
//     process that merely grabbed the proxy port.

/** Directory we own for shim scripts: `~/.local/share/maximal/shims`. */
export function getShimDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".local", "share", "maximal", "shims")
}

/** Absolute path of the shim we manage: `<shimDir>/claude` (named for
 *  the command so it dispatches when invoked as `claude`). */
export function getShimPath(homeDir: string = os.homedir()): string {
  return path.join(getShimDir(homeDir), "claude")
}

/** Escape a string for safe interpolation inside a double-quoted POSIX
 *  shell literal. */
function shellDoubleQuote(value: string): string {
  return value.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`)
}

/**
 * The fail-closed guard chain, baked into every shim. Runs on each
 * `claude` invocation. Each guard, on any doubt, `exec`s the real claude
 * with no environment override — routing through the proxy happens ONLY
 * when Maximal itself is the process serving the proxy port.
 *
 *   1. Real claude still present?         no  → can't run; error out.
 *   2. Maximal binary still installed?    no  → run claude bare.
 *   3. Proxy port actually listening?     no  → run claude bare.
 *   4. The PID holding the port is        no  → run claude bare
 *      Maximal (not some other process          (never inject the key
 *      that grabbed the port)?                   toward a hijacked port).
 *
 * Only after all four hold do we inject ANTHROPIC_BASE_URL (and the API
 * key, when configured) and exec.
 */
function buildShimScript(
  targetBinaryPath: string,
  opts: { apiKey?: string; maximalBinPath: string },
): string {
  const host = "127.0.0.1"
  const port = "4141"
  const apiKeyExport =
    opts.apiKey !== undefined && opts.apiKey.length > 0 ?
      `  export ANTHROPIC_API_KEY="${shellDoubleQuote(opts.apiKey)}"\n`
    : ""

  return `#!/bin/sh
${SHIM_MARKER}
# Managed by Maximal — routes \`claude\` through the local proxy, but only
# when Maximal itself is the process serving the proxy port. Every guard
# fails closed: on any doubt we run the real claude unchanged, so an
# orphaned or tampered shim can never break the CLI or misroute the key.
# Do not edit by hand — toggle from Maximal Settings → Apps.
set -u

REAL_CLAUDE="${shellDoubleQuote(targetBinaryPath)}"
MAXIMAL_BIN="${shellDoubleQuote(opts.maximalBinPath)}"
PROXY_HOST="${host}"
PROXY_PORT="${port}"

# Run the real claude with no proxy env. Used by every guard below.
bare() { exec "$REAL_CLAUDE" "$@"; }

# Guard 1: the real claude we captured at install must still be there.
# If it's gone the user removed claude itself — nothing to fall back to.
if [ ! -x "$REAL_CLAUDE" ]; then
  echo "maximal: the claude binary this shim wrapped is gone ($REAL_CLAUDE)." >&2
  exit 127
fi

# Guard 2: Maximal must still be installed.
[ -n "$MAXIMAL_BIN" ] && [ -x "$MAXIMAL_BIN" ] || bare "$@"

# Guard 3 + 4: the proxy port must be held, and held by Maximal itself.
# lsof gives the listening PID; ps gives its executable. Missing lsof,
# closed port, or a non-Maximal listener all fall through to bare.
PID=$(lsof -nP "-iTCP@\${PROXY_HOST}:\${PROXY_PORT}" -sTCP:LISTEN -t 2>/dev/null | head -n1)
[ -n "$PID" ] || bare "$@"
PROC=$(ps -p "$PID" -o comm= 2>/dev/null)
[ -n "$PROC" ] || bare "$@"
if [ "$PROC" != "$MAXIMAL_BIN" ]; then
  case "$PROC" in
    */maximal | maximal) : ;;
    *) bare "$@" ;;
  esac
fi

# All guards passed: Maximal owns the port. Route through it.
export ANTHROPIC_BASE_URL="http://\${PROXY_HOST}:\${PROXY_PORT}"
${apiKeyExport}exec "$REAL_CLAUDE" "$@"
`
}

/**
 * Ensure the shims directory exists, is owned by us, and is not
 * group/world-writable — then guarantee it's 0700. We REFUSE a
 * pre-existing directory with loose permissions rather than silently
 * tightening it: a world-writable dir about to go on the user's PATH
 * may already contain an attacker-planted file. Only a directory we
 * create (or one already strict) is trusted. Mirrors ssh's StrictModes
 * check on `~/.ssh`.
 */
function ensureSecureShimDir(dir: string): void {
  let stat: fs.Stats | undefined
  try {
    stat = fs.statSync(dir)
  } catch {
    // Absent — fall through to fresh creation below.
  }

  if (stat !== undefined) {
    if (!stat.isDirectory()) {
      throw new Error(`refusing to use shim dir ${dir}: not a directory`)
    }
    const uid = process.getuid?.()
    if (uid !== undefined && stat.uid !== uid) {
      throw new Error(
        `refusing to use shim dir ${dir}: owned by uid ${stat.uid}, not ${uid}`,
      )
    }
    // No group- or other-write bits (0o022) may already be set — we do
    // not adopt a loose directory.
    if ((stat.mode & 0o022) !== 0) {
      throw new Error(
        `refusing to use shim dir ${dir}: it is group/world-writable (mode ${(
          stat.mode & 0o777
        ).toString(8)})`,
      )
    }
    // Owned by us and not loose — normalise to exactly 0700.
    fs.chmodSync(dir, 0o700)
    return
  }

  // Fresh creation: 0700 from the start, so the window where it could be
  // written by another user never exists.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
}

export interface InstallShimOptions {
  apiKey?: string
  homeDir?: string
  /** Absolute path of the Maximal binary the shim verifies is serving
   *  the proxy port. Defaults to the running executable. */
  maximalBinPath?: string
}

/**
 * Write the shim into the secure shims directory, pointing at
 * `targetBinaryPath`. Refuses to overwrite a pre-existing file that is
 * NOT our shim (no marker). The write is atomic (temp + O_EXCL +
 * rename), so the on-PATH `claude` never appears partially written.
 */
export function installClaudeShim(
  targetBinaryPath: string,
  options: InstallShimOptions = {},
): string {
  const home = options.homeDir ?? os.homedir()
  const shimDir = getShimDir(home)
  const shimPath = getShimPath(home)
  const maximalBinPath = options.maximalBinPath ?? process.execPath

  if (fs.existsSync(shimPath) && !fileContains(shimPath, SHIM_MARKER)) {
    throw new Error(
      `refusing to install shim: ${shimPath} already exists and is not a Maximal shim`,
    )
  }

  ensureSecureShimDir(shimDir)

  const script = buildShimScript(targetBinaryPath, {
    apiKey: options.apiKey,
    maximalBinPath,
  })

  // Atomic, no-symlink-follow write: O_EXCL on a per-pid temp in the
  // same dir, then rename into place. An attacker can't pre-plant the
  // temp (O_EXCL fails) and can't observe a half-written `claude`.
  const tmp = path.join(shimDir, `.claude.tmp-${process.pid}`)
  try {
    fs.rmSync(tmp, { force: true })
  } catch {
    /* best effort */
  }
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o700,
  )
  try {
    fs.writeFileSync(fd, script)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.chmodSync(tmp, 0o700)
  fs.renameSync(tmp, shimPath)
  return shimPath
}

/**
 * Delete the shim — but only if it carries our marker. Absent → no-op
 * (returns false). Present without our marker → refuse (throw).
 */
export function removeClaudeShim(homeDir: string = os.homedir()): boolean {
  const shimPath = getShimPath(homeDir)
  if (!fs.existsSync(shimPath)) return false
  if (!fileContains(shimPath, SHIM_MARKER)) {
    throw new Error(`refusing to remove ${shimPath}: it is not a Maximal shim`)
  }
  fs.rmSync(shimPath, { force: true })
  return true
}

/** True when the shim path exists and carries our marker. */
export function isShimInstalled(homeDir: string = os.homedir()): boolean {
  const shimPath = getShimPath(homeDir)
  return fs.existsSync(shimPath) && fileContains(shimPath, SHIM_MARKER)
}

/** Parse the `REAL_CLAUDE="<path>"` line to report which binary the
 *  installed shim points at. Null when no shim or unparseable. */
export function readShimTarget(homeDir: string = os.homedir()): string | null {
  const shimPath = getShimPath(homeDir)
  if (!isShimInstalled(homeDir)) return null
  let content: string
  try {
    content = fs.readFileSync(shimPath, "utf8")
  } catch {
    return null
  }
  const match = /^REAL_CLAUDE="((?:[^"\\]|\\.)*)"/mu.exec(content)
  if (!match) return null
  return match[1].replaceAll(String.raw`\"`, '"').replaceAll("\\\\", "\\")
}
