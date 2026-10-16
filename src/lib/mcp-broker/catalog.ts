/**
 * Known MCP servers Maximal can find on this machine and offer to add as
 * brokered endpoints, the way the Apps panel finds Claude Code.
 *
 * Detection resolves the server's own executable to an absolute path. A
 * GUI-launched sidecar inherits launchd's minimal PATH, so a bare command
 * name, a mise shim (which runs mise), or an npm launcher script (which
 * runs `node`) would not start from the broker.
 */

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { McpServerConfig } from "./types"

export interface CatalogDetectOptions {
  homeDir?: string
  pathDirs?: Array<string>
  /** `npm prefix -g`; null when npm isn't available. */
  npmPrefix?: string | null
  platform?: NodeJS.Platform
  arch?: string
  /** mise's data directory (`MISE_DATA_DIR`). */
  miseDataDir?: string
}

export interface CatalogInstall {
  /** Absolute path of the server executable. */
  command: string
  version: string | null
}

export interface McpCatalogEntry {
  id: string
  label: string
  /** How to install it, shown when it isn't found. */
  install: { command: string; url: string }
  locate(options?: CatalogDetectOptions): CatalogInstall | undefined
  /** The endpoint written to config.json when the user adds it. Off until
   *  the user turns it on and picks clients. */
  template(install: CatalogInstall): McpServerConfig
}

interface ResolvedOptions {
  home: string
  pathDirs: Array<string>
  npmPrefix: () => string | null
  platform: NodeJS.Platform
  arch: string
  miseDataDir: string
}

function defaultMiseDataDir(home: string, platform: NodeJS.Platform): string {
  if (process.env.MISE_DATA_DIR) return process.env.MISE_DATA_DIR
  if (platform === "win32") {
    const local =
      process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")
    return path.join(local, "mise")
  }
  return path.join(home, ".local", "share", "mise")
}

function resolveOptions(options: CatalogDetectOptions = {}): ResolvedOptions {
  const home = options.homeDir ?? os.homedir()
  const platform = options.platform ?? process.platform
  let prefix: string | null | undefined = options.npmPrefix
  return {
    home,
    platform,
    arch: options.arch ?? process.arch,
    pathDirs:
      options.pathDirs
      ?? (process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    npmPrefix: () => {
      if (prefix === undefined) prefix = defaultNpmPrefix()
      return prefix
    },
    miseDataDir: options.miseDataDir ?? defaultMiseDataDir(home, platform),
  }
}

// npm's global prefix doesn't change while Maximal runs, and spawning npm is
// the slowest probe; detection runs at boot and on every Settings list.
let npmPrefixCache: string | null | undefined

function defaultNpmPrefix(): string | null {
  if (npmPrefixCache !== undefined) return npmPrefixCache
  try {
    const out = execFileSync("npm", ["prefix", "-g"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    npmPrefixCache = out.length > 0 ? out : null
  } catch {
    npmPrefixCache = null
  }
  return npmPrefixCache
}

function isExecutableFile(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false
    if (platform !== "win32") fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function readPackageVersion(packageDir: string): string | null {
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(path.join(packageDir, "package.json")).toString(),
    )
    if (raw && typeof raw === "object" && "version" in raw) {
      return typeof raw.version === "string" ? raw.version : null
    }
    return null
  } catch {
    return null
  }
}

function listDirs(dir: string): Array<string> {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function versionParts(version: string): Array<number> {
  return version.split(/[.-]/u).map(Number)
}

/** Newest first; numeric parts compare as numbers. */
function compareVersionsDesc(a: string, b: string): number {
  const [pa, pb] = [versionParts(a), versionParts(b)]
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const [x, y] = [pa[i] ?? 0, pb[i] ?? 0]
    if (Number.isNaN(x) || Number.isNaN(y)) return b.localeCompare(a)
    if (x !== y) return y - x
  }
  return 0
}

// ── Work IQ ─────────────────────────────────────────────────────────────

const WORKIQ_PACKAGE = ["@microsoft", "workiq"] as const

const WORKIQ_PLATFORM_FAMILY: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "osx",
  win32: "win",
  linux: "linux",
}

/** Work IQ's npm package ships a native executable per platform under
 *  `bin/<folder>/`; its `workiq.js` launcher only picks one and runs it. */
function workiqPlatformFolder(
  platform: NodeJS.Platform,
  arch: string,
): string | undefined {
  const family = WORKIQ_PLATFORM_FAMILY[platform]
  if (!family || (arch !== "arm64" && arch !== "x64")) return undefined
  return `${family}-${arch}`
}

function workiqExecutable(
  packageDir: string,
  opts: ResolvedOptions,
): CatalogInstall | undefined {
  const folder = workiqPlatformFolder(opts.platform, opts.arch)
  if (!folder) return undefined
  const name = opts.platform === "win32" ? "workiq.exe" : "workiq"
  const command = path.join(packageDir, "bin", folder, name)
  if (!isExecutableFile(command, opts.platform)) return undefined
  return { command, version: readPackageVersion(packageDir) }
}

/** Package directories under a node install root (mise install or npm
 *  global prefix), in npm's Unix and Windows layouts. */
function packageDirsUnder(root: string): Array<string> {
  return [
    path.join(root, "lib", "node_modules", ...WORKIQ_PACKAGE),
    path.join(root, "node_modules", ...WORKIQ_PACKAGE),
  ]
}

/** Every mise-installed version (mise keeps old ones after an upgrade). */
function fromMise(opts: ResolvedOptions): Array<CatalogInstall> {
  const installs = path.join(
    opts.miseDataDir,
    "installs",
    "npm-microsoft-workiq",
  )
  return listDirs(installs).flatMap((version) => {
    for (const dir of packageDirsUnder(path.join(installs, version))) {
      const found = workiqExecutable(dir, opts)
      if (found) return [found]
    }
    return []
  })
}

function fromNpmGlobal(opts: ResolvedOptions): CatalogInstall | undefined {
  const prefix = opts.npmPrefix()
  if (!prefix) return undefined
  for (const dir of packageDirsUnder(prefix)) {
    const found = workiqExecutable(dir, opts)
    if (found) return found
  }
  return undefined
}

/** A `workiq` on PATH that links into the npm package (npm's global bin
 *  symlink), or is the native executable itself. */
function fromPath(opts: ResolvedOptions): CatalogInstall | undefined {
  const names =
    opts.platform === "win32" ? ["workiq.exe", "workiq.cmd"] : ["workiq"]
  for (const dir of opts.pathDirs) {
    for (const name of names) {
      let real: string
      try {
        real = fs.realpathSync(path.join(dir, name))
      } catch {
        continue
      }
      // …/@microsoft/workiq/bin/workiq.js, or …/bin/<folder>/workiq.
      for (const up of [2, 3]) {
        let packageDir = real
        for (let i = 0; i < up; i++) packageDir = path.dirname(packageDir)
        if (path.basename(packageDir) !== "workiq") continue
        const found = workiqExecutable(packageDir, opts)
        if (found) return found
      }
    }
  }
  return undefined
}

/** The highest version among every install found. One without a readable
 *  version only wins when nothing else was found; equal versions keep the
 *  order found. */
function newestInstall(
  installs: Array<CatalogInstall | undefined>,
): CatalogInstall | undefined {
  let best: CatalogInstall | undefined
  for (const install of installs) {
    if (!install) continue
    if (!best) {
      best = install
    } else if (
      install.version !== null
      && (best.version === null
        || compareVersionsDesc(install.version, best.version) < 0)
    ) {
      best = install
    }
  }
  return best
}

const workiq: McpCatalogEntry = {
  id: "workiq",
  label: "Work IQ",
  install: {
    command: "npm install -g @microsoft/workiq",
    url: "https://www.npmjs.com/package/@microsoft/workiq",
  },
  locate(options) {
    const opts = resolveOptions(options)
    return newestInstall([
      ...fromMise(opts),
      fromPath(opts),
      fromNpmGlobal(opts),
    ])
  },
  template(install) {
    return {
      id: "workiq",
      label: "Work IQ",
      enabled: false,
      catalog: "workiq",
      transport: { type: "stdio", command: install.command, args: ["mcp"] },
      // Work IQ took over 10s to initialize in the 2026-10-13 spike.
      timeouts: { startupMs: 30_000, initializeMs: 30_000 },
      // A 2025-era server whose sign-in can prompt: one upstream per session.
      classification: {
        protocol: "legacy",
        interaction: "interactive",
        ownership: "exclusive",
      },
      environment: { inherit: ["HOME"] },
    }
  },
}

export const MCP_CATALOG: ReadonlyArray<McpCatalogEntry> = [workiq]

export function findCatalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((entry) => entry.id === id)
}
