import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { npmGlobalPrefix, runFile } from "~/lib/system/run-file"

export const SHIM_MARKER = "# __MAXIMAL_CLAUDE_SHIM__"

export function legacyShimPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".local", "share", "maximal", "shims", "claude")
}

export function removeLegacyShimIfPresent(
  homeDir: string = os.homedir(),
): string | null {
  const shimPath = legacyShimPath(homeDir)
  try {
    if (!fs.existsSync(shimPath)) return null
    if (!fileStartsWithContains(shimPath, SHIM_MARKER)) return null
    fs.unlinkSync(shimPath)
    return shimPath
  } catch {
    return null
  }
}

export type ClaudeInstallSource =
  | "homebrew"
  | "npm-global"
  | "local-bin"
  | "claude-local"
  | "winget"
  | "path"

export interface ClaudeInstall {
  path: string
  resolvedPath: string
  version: string | null
  source: ClaudeInstallSource
}

export interface DetectOptions {
  homeDir?: string
  pathDirs?: Array<string>
  npmPrefix?: string | null
  /** Windows: where WinGet keeps its command links (`%LOCALAPPDATA%`). */
  localAppData?: string
  /** Defaults to running `<bin> --version` (cached per binary). */
  readVersion?: (binPath: string) => Promise<string | null> | string | null
  platform?: NodeJS.Platform
}

/** A found binary whose version hasn't been read yet. */
type FoundInstall = Omit<ClaudeInstall, "version">

/** WinGet's command links for portable packages (Claude Code is one). A
 *  running Maximal keeps the PATH it started with, so a link WinGet just made
 *  isn't on PATH until a restart; the probe finds it directly. */
export function wingetLinksDir(localAppData: string): string {
  return path.join(localAppData, "Microsoft", "WinGet", "Links")
}

/** `%LOCALAPPDATA%` (or the injected override), where WinGet's links live. */
export function resolveLocalAppDataDir(options: {
  home: string
  override?: string
  homeOverridden: boolean
  environmentLocalAppData?: string
}): string {
  const {
    home,
    override,
    homeOverridden,
    environmentLocalAppData = process.env.LOCALAPPDATA,
  } = options
  if (override !== undefined) return override
  // An alternate home is an isolation boundary: never escape it through the
  // real process user's LOCALAPPDATA unless the caller explicitly supplies it.
  if (homeOverridden) return path.join(home, "AppData", "Local")
  return environmentLocalAppData ?? path.join(home, "AppData", "Local")
}

function sameDirectory(left: string, right: string, isWin: boolean): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value)
    return isWin ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

function wingetProbeDirs(
  isWin: boolean,
  localAppData: string,
): Array<{ dir: string; origin: ClaudeInstallSource }> {
  return isWin ? [{ dir: wingetLinksDir(localAppData), origin: "winget" }] : []
}

function pathDirSource(
  dir: string,
  wingetLinks: string,
  isWin: boolean,
): ClaudeInstallSource {
  return isWin && sameDirectory(dir, wingetLinks, isWin) ? "winget" : "path"
}

function claudeBasenames(platform: NodeJS.Platform): Array<string> {
  if (platform === "win32") {
    return ["claude.exe", "claude.cmd", "claude.ps1", "claude"]
  }
  return ["claude"]
}

function inspectDir(
  probe: { dir: string; origin: ClaudeInstallSource },
  ctx: {
    home: string
    npmBin: string | null
    seen: Set<string>
    isWin: boolean
    basenames: Array<string>
  },
): FoundInstall | null {
  for (const base of ctx.basenames) {
    const inst = inspectCandidate(
      { raw: path.join(probe.dir, base), origin: probe.origin },
      ctx,
    )
    if (inst) return inst
  }
  return null
}

function defaultPathDirs(): Array<string> {
  const raw = process.env.PATH ?? ""
  return raw.split(path.delimiter).filter((d) => d.length > 0)
}

const VERSION_TIMEOUT_MS = 5000

/** `--version` output by binary and modification time: Settings lists detect
 *  on every load, and an upgrade replaces the file, which refreshes it. */
const versionCache = new Map<string, string | null>()

export async function readClaudeVersion(
  binPath: string,
): Promise<string | null> {
  let key: string
  try {
    key = `${binPath}\0${fs.statSync(binPath).mtimeMs}`
  } catch {
    return null
  }
  const cached = versionCache.get(key)
  if (cached !== undefined) return cached
  const result = await runFile(binPath, ["--version"], {
    timeoutMs: VERSION_TIMEOUT_MS,
  })
  const version = result.code === 0 ? parseVersion(result.stdout) : null
  // A failed read isn't cached; the next list tries again.
  if (result.code === 0) versionCache.set(key, version)
  return version
}

function parseVersion(stdout: string): string | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  const semver = /\d+\.\d+\.\d+/u.exec(trimmed)
  return semver ? semver[0] : trimmed
}

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

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

interface Candidate {
  raw: string
  origin: ClaudeInstallSource
}

function classifySource(
  resolved: string,
  ctx: {
    origin: ClaudeInstallSource
    home: string
    npmBin: string | null
    isWin: boolean
  },
): ClaudeInstallSource {
  const { origin, isWin } = ctx
  const sep = path.sep
  const home = realpathOrSelf(ctx.home)
  const npmBin = ctx.npmBin === null ? null : realpathOrSelf(ctx.npmBin)
  const norm = (p: string): string => (isWin ? p.toLowerCase() : p)
  const res = norm(resolved)
  const startsWith = (prefix: string): boolean => res.startsWith(norm(prefix))
  if (startsWith(path.join(home, ".claude") + sep)) {
    return "claude-local"
  }
  if (startsWith(path.join(home, ".local", "bin") + sep)) {
    return "local-bin"
  }
  if (origin !== "path") {
    return origin
  }
  if (npmBin && startsWith(npmBin + sep)) {
    return "npm-global"
  }
  if (
    !isWin
    && (resolved.startsWith("/opt/homebrew/")
      || resolved.startsWith("/usr/local/"))
  ) {
    return "homebrew"
  }
  return "path"
}

function inspectCandidate(
  candidate: Candidate,
  ctx: {
    home: string
    npmBin: string | null
    seen: Set<string>
    isWin: boolean
  },
): FoundInstall | null {
  let stat: fs.Stats
  try {
    stat = fs.statSync(candidate.raw)
  } catch {
    return null
  }
  if (!stat.isFile()) return null

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
    path: candidate.raw,
    resolvedPath: resolved,
    source: classifySource(resolved, {
      origin: candidate.origin,
      home: ctx.home,
      npmBin: ctx.npmBin,
      isWin: ctx.isWin,
    }),
  }
}

export async function detectClaudeInstalls(
  options: DetectOptions = {},
): Promise<Array<ClaudeInstall>> {
  const home = options.homeDir ?? os.homedir()
  const pathDirs = options.pathDirs ?? defaultPathDirs()
  const readVersion = options.readVersion ?? readClaudeVersion
  const platform = options.platform ?? process.platform
  const isWin = platform === "win32"
  const basenames = claudeBasenames(platform)
  const localAppData = resolveLocalAppDataDir({
    home,
    override: options.localAppData,
    homeOverridden: options.homeDir !== undefined,
  })
  const seen = new Set<string>()

  const npmBinOf = (prefix: string): string =>
    isWin ? prefix : path.join(prefix, "bin")

  const explicitNpm = options.npmPrefix
  const phase1NpmBin =
    typeof explicitNpm === "string" ? npmBinOf(explicitNpm) : null
  const wingetLinks = wingetLinksDir(localAppData)
  for (const dir of pathDirs) {
    const origin = pathDirSource(dir, wingetLinks, isWin)
    const inst = inspectDir(
      { dir, origin },
      { home, npmBin: phase1NpmBin, seen, isWin, basenames },
    )
    if (inst) return withVersions([inst], readVersion)
  }

  const npmPrefix =
    explicitNpm === undefined ? await npmGlobalPrefix() : explicitNpm
  const npmBin = npmPrefix ? npmBinOf(npmPrefix) : null

  const probeDirs: Array<{ dir: string; origin: ClaudeInstallSource }> = []
  if (!isWin) {
    probeDirs.push(
      { dir: "/opt/homebrew/bin", origin: "homebrew" },
      { dir: "/usr/local/bin", origin: "homebrew" },
    )
  }
  probeDirs.push(
    { dir: path.join(home, ".local", "bin"), origin: "local-bin" },
    { dir: path.join(home, ".claude", "local"), origin: "claude-local" },
    { dir: path.join(home, ".claude", "bin"), origin: "claude-local" },
    { dir: path.join(home, ".claude"), origin: "claude-local" },
    ...wingetProbeDirs(isWin, localAppData),
  )
  if (npmBin) {
    probeDirs.push({ dir: npmBin, origin: "npm-global" })
  }

  const installs: Array<FoundInstall> = []
  for (const probe of probeDirs) {
    const inst = inspectDir(probe, { home, npmBin, seen, isWin, basenames })
    if (inst) installs.push(inst)
  }
  return withVersions(installs, readVersion)
}

/** Read every install's version at once rather than one after another. */
function withVersions(
  installs: Array<FoundInstall>,
  readVersion: NonNullable<DetectOptions["readVersion"]>,
): Promise<Array<ClaudeInstall>> {
  return Promise.all(
    installs.map(async (install) => ({
      ...install,
      version: await readVersion(install.path),
    })),
  )
}
