import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

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
  readVersion?: (binPath: string) => string | null
  platform?: NodeJS.Platform
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
    readVersion: (binPath: string) => string | null
    seen: Set<string>
    isWin: boolean
    basenames: Array<string>
  },
): ClaudeInstall | null {
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
    readVersion: (binPath: string) => string | null
    seen: Set<string>
    isWin: boolean
  },
): ClaudeInstall | null {
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
    version: ctx.readVersion(candidate.raw),
    source: classifySource(resolved, {
      origin: candidate.origin,
      home: ctx.home,
      npmBin: ctx.npmBin,
      isWin: ctx.isWin,
    }),
  }
}

export function detectClaudeInstalls(
  options: DetectOptions = {},
): Array<ClaudeInstall> {
  const home = options.homeDir ?? os.homedir()
  const pathDirs = options.pathDirs ?? defaultPathDirs()
  const readVersion = options.readVersion ?? readClaudeVersion
  const platform = options.platform ?? process.platform
  const isWin = platform === "win32"
  const basenames = claudeBasenames(platform)
  const seen = new Set<string>()

  const npmBinOf = (prefix: string): string =>
    isWin ? prefix : path.join(prefix, "bin")

  const explicitNpm = options.npmPrefix
  const phase1NpmBin =
    typeof explicitNpm === "string" ? npmBinOf(explicitNpm) : null
  for (const dir of pathDirs) {
    const inst = inspectDir(
      { dir, origin: "path" },
      { home, npmBin: phase1NpmBin, readVersion, seen, isWin, basenames },
    )
    if (inst) return [inst]
  }

  const npmPrefix = explicitNpm === undefined ? defaultNpmPrefix() : explicitNpm
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
  )
  if (npmBin) {
    probeDirs.push({ dir: npmBin, origin: "npm-global" })
  }

  const installs: Array<ClaudeInstall> = []
  for (const probe of probeDirs) {
    const inst = inspectDir(probe, {
      home,
      npmBin,
      readVersion,
      seen,
      isWin,
      basenames,
    })
    if (inst) installs.push(inst)
  }
  return installs
}
