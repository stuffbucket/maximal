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
 * still catches every shim we write. Use this for shim/binary checks; for
 * small text files where the needle may be anywhere (rc files), use
 * `fileContains`.
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

/** Whole-file substring check. Only for files known to be small (shell rc
 *  files), where the needle may appear anywhere. Never call this on a
 *  candidate `claude` path — it could be a 200 MB+ binary; use
 *  `fileStartsWithContains` there. */
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

  if (
    fs.existsSync(shimPath)
    && !fileStartsWithContains(shimPath, SHIM_MARKER)
  ) {
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
  if (!fileStartsWithContains(shimPath, SHIM_MARKER)) {
    throw new Error(`refusing to remove ${shimPath}: it is not a Maximal shim`)
  }
  fs.rmSync(shimPath, { force: true })
  return true
}

// ---------------------------------------------------------------------------
// PATH activation
// ---------------------------------------------------------------------------
//
// Writing the shim isn't enough: the shims dir has to be EARLIER on PATH
// than the real `claude` for plain `claude` to dispatch to us. The native
// installer prepends `~/.local/bin` to PATH, so the real claude is
// typically position 1 — we have to get ahead of even that. We do it the
// way every version manager (asdf, volta, pyenv) does, and the way our own
// macOS first-launch already does for `~/.local/bin`: a marker-guarded
// block appended to the user's zsh rc files that prepends the shims dir.
// The block is idempotent (keyed on the marker) and fully reversible.

/** Marker lines wrapping the PATH block we manage in the user's rc files.
 *  Anything between them is ours to add/remove; everything else is left
 *  untouched. */
const PATH_MARKER_START = "# >>> maximal claude shim >>>"
const PATH_MARKER_END = "# <<< maximal claude shim <<<"

/** zsh rc files we manage: `.zshrc` (interactive) and `.zprofile` (login).
 *  zsh has been macOS's default since Catalina; bash is intentionally
 *  skipped, matching the first-launch PATH block. */
function pathRcFiles(homeDir: string): Array<string> {
  return [path.join(homeDir, ".zshrc"), path.join(homeDir, ".zprofile")]
}

/** The exact block we write. The shims dir goes FIRST so it beats a
 *  position-1 `~/.local/bin/claude` from the native installer. */
function pathBlock(shimDir: string): string {
  return `${PATH_MARKER_START}\nexport PATH="${shimDir}:$PATH"\n${PATH_MARKER_END}\n`
}

/** Strip any existing maximal-claude-shim block (and the blank line a
 *  prior insert added before it) from rc-file content. Idempotent. */
function stripPathBlock(content: string): string {
  // Remove from an optional leading newline through the end marker.
  const re = new RegExp(
    `\\n?${escapeRegExp(PATH_MARKER_START)}[\\s\\S]*?${escapeRegExp(
      PATH_MARKER_END,
    )}\\n?`,
    "g",
  )
  return content.replace(re, "\n")
}

function escapeRegExp(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

/**
 * Add the shims dir to PATH in the user's zsh rc files (idempotent).
 * Takes effect in the NEXT terminal — the current process's PATH is not
 * mutated. Best-effort per file: an unwritable rc is skipped, not fatal.
 * Returns the rc files actually written.
 */
export function addShimDirToPath(
  homeDir: string = os.homedir(),
): Array<string> {
  const shimDir = getShimDir(homeDir)
  const written: Array<string> = []
  for (const rc of pathRcFiles(homeDir)) {
    try {
      const existing = fs.existsSync(rc) ? fs.readFileSync(rc, "utf8") : ""
      // Already present and pointing at the right dir → nothing to do.
      if (existing.includes(`export PATH="${shimDir}:$PATH"`)) continue
      // Replace any stale block first, then append a fresh one.
      const base = stripPathBlock(existing).replace(/\n+$/, "\n")
      const next =
        (base && !base.endsWith("\n") ? base + "\n" : base)
        + "\n"
        + pathBlock(shimDir)
      fs.writeFileSync(rc, next)
      written.push(rc)
    } catch {
      /* best effort — an unwritable rc shouldn't break the toggle */
    }
  }
  return written
}

/**
 * Remove the maximal-claude-shim PATH block from the user's zsh rc files
 * (idempotent). Returns the rc files actually modified.
 */
export function removeShimDirFromPath(
  homeDir: string = os.homedir(),
): Array<string> {
  const modified: Array<string> = []
  for (const rc of pathRcFiles(homeDir)) {
    try {
      if (!fs.existsSync(rc)) continue
      const existing = fs.readFileSync(rc, "utf8")
      if (!existing.includes(PATH_MARKER_START)) continue
      const next = stripPathBlock(existing)
      fs.writeFileSync(rc, next)
      modified.push(rc)
    } catch {
      /* best effort */
    }
  }
  return modified
}

/** True when at least one managed rc file currently carries our PATH
 *  block. Used by the UI to report whether the shim is actually active
 *  (vs merely written but not yet on PATH). */
export function isShimDirOnPath(homeDir: string = os.homedir()): boolean {
  return pathRcFiles(homeDir).some(
    (rc) => fs.existsSync(rc) && fileContains(rc, PATH_MARKER_START),
  )
}

/** True when the shim path exists and carries our marker. */
export function isShimInstalled(homeDir: string = os.homedir()): boolean {
  const shimPath = getShimPath(homeDir)
  return (
    fs.existsSync(shimPath) && fileStartsWithContains(shimPath, SHIM_MARKER)
  )
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
