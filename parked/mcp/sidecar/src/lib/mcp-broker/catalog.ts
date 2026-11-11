/**
 * Known MCP servers Maximal can find on this machine and offer to add as
 * brokered endpoints, the way the Apps panel finds Claude Code.
 *
 * Detection resolves the server's own executable to an absolute path. A
 * GUI-launched sidecar inherits launchd's minimal PATH, so a bare command
 * name, a mise shim (which runs mise), or an npm launcher script (which
 * runs `node`) would not start from the broker.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  type NpmLoginConfig,
  cachedNpmLoginConfig,
} from "~/lib/system/npm-login-config"
import { cachedNpmGlobalPrefix } from "~/lib/system/run-file"

import type { McpServerConfig } from "./types"

export interface CatalogDetectOptions {
  homeDir?: string
  pathDirs?: Array<string>
  /** `npm prefix -g`; null when npm isn't available. Defaults to the
   *  cached value, so call `npmGlobalPrefix()` first (detection is sync and
   *  must never spawn npm itself). */
  npmPrefix?: string | null
  platform?: NodeJS.Platform
  arch?: string
  /** mise's data directory (`MISE_DATA_DIR`). */
  miseDataDir?: string
  /** Environment read for tool locations and npm settings (default: this
   *  process's). */
  env?: Readonly<Record<string, string | undefined>>
  /** Fixed Node install prefixes, such as Homebrew's (default per platform). */
  systemPrefixes?: Array<string>
  /** `mcpBroker.catalog.npmRegistry`: the install hint downloads from it. */
  npmRegistry?: string
  /** What npm reports from the user's login environment (registry, scope
   *  registry, prefix). Defaults to the cached lookup; call
   *  `warmNpmDetection()` first. */
  npmLogin?: NpmLoginConfig | null
}

export interface CatalogInstall {
  /** Absolute path of the server executable. */
  command: string
  version: string | null
}

/** How to install a server that wasn't found. */
export interface CatalogInstallHint {
  /** Shell command to run. */
  command: string
  /** The server's package page. */
  url: string
  /** Host of the registry the command downloads from; null when neither
   *  npm nor its config files confirm one. */
  registry: string | null
}

export interface McpCatalogEntry {
  id: string
  label: string
  /** How to install it, shown when it isn't found. */
  install(options?: CatalogDetectOptions): CatalogInstallHint
  locate(options?: CatalogDetectOptions): CatalogInstall | undefined
  /** The endpoint written to config.json when the user adds it. Off until
   *  the user turns it on and picks clients. */
  template(
    install: CatalogInstall,
    options?: CatalogDetectOptions,
  ): McpServerConfig
}

interface ResolvedOptions {
  home: string
  pathDirs: Array<string>
  npmPrefix: () => string | null
  npmLogin: NpmLoginConfig | null
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

/**
 * The machine's own architecture on Windows. `process.arch` is this
 * process's: an x64 Maximal on an Arm PC runs under emulation and reports
 * x64. Windows tells an emulated or WOW64 process the machine's in
 * PROCESSOR_ARCHITEW6432, and everyone else in PROCESSOR_ARCHITECTURE.
 */
export function windowsMachineArch(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const name = (
    env.PROCESSOR_ARCHITEW6432 ?? env.PROCESSOR_ARCHITECTURE
  )?.toUpperCase()
  if (name === "ARM64") return "arm64"
  if (name === "AMD64") return "x64"
  return undefined
}

function resolveOptions(options: CatalogDetectOptions = {}): ResolvedOptions {
  const home = options.homeDir ?? os.homedir()
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const npmLogin =
    options.npmLogin === undefined ?
      (cachedNpmLoginConfig() ?? null)
    : options.npmLogin
  return {
    home,
    platform,
    arch:
      options.arch
      ?? (platform === "win32" ? windowsMachineArch(env) : undefined)
      ?? process.arch,
    pathDirs:
      options.pathDirs
      ?? (process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    // npm's own answer for the login environment, else the plain prefix
    // lookup; both come from caches and never spawn.
    npmPrefix: () =>
      options.npmPrefix === undefined ?
        (npmLogin?.prefix ?? cachedNpmGlobalPrefix() ?? null)
      : options.npmPrefix,
    npmLogin,
    miseDataDir: options.miseDataDir ?? defaultMiseDataDir(home, platform),
  }
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
  // An Arm PC runs the x64 build too (emulated), if a package has no Arm one.
  const arches =
    opts.platform === "win32" && opts.arch === "arm64" ?
      ["arm64", "x64"]
    : [opts.arch]
  const name = opts.platform === "win32" ? "workiq.exe" : "workiq"
  for (const arch of arches) {
    const folder = workiqPlatformFolder(opts.platform, arch)
    if (!folder) continue
    const command = path.join(packageDir, "bin", folder, name)
    if (isExecutableFile(command, opts.platform)) {
      return { command, version: readPackageVersion(packageDir) }
    }
  }
  return undefined
}

/** Package directories under a node install root (mise install or npm
 *  global prefix), in npm's Unix and Windows layouts. */
function packageDirsUnder(
  root: string,
  name: ReadonlyArray<string> = WORKIQ_PACKAGE,
): Array<string> {
  return [
    path.join(root, "lib", "node_modules", ...name),
    path.join(root, "node_modules", ...name),
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
 *  symlink), or is the native executable itself. On Windows npm writes a
 *  `workiq.cmd` launcher instead of a link, with the package in
 *  `node_modules` beside it. */
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
      if (name === "workiq.cmd") {
        const found = workiqExecutable(
          path.join(dir, "node_modules", ...WORKIQ_PACKAGE),
          opts,
        )
        if (found) return found
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

/** True when mise manages tools on this machine (its data directory
 *  exists), so an install hint can use it instead of a global npm install. */
function usesMise(opts: ResolvedOptions): boolean {
  return fs.existsSync(path.join(opts.miseDataDir, "installs"))
}

// ── Where package managers keep global packages ─────────────────────────
//
// A GUI-launched Maximal has launchd's PATH, so it can neither find nor run
// `npm` or `pnpm`, and every Node installed by Homebrew, the Node.js
// installer, or a version manager is invisible through PATH. Their global
// package folders are probed directly instead. Nothing here starts a
// process; npm settings are read from the environment and npmrc files.

interface DetectContext extends ResolvedOptions {
  env: Readonly<Record<string, string | undefined>>
  systemPrefixes: Array<string>
  npmRegistry: string | undefined
}

function defaultSystemPrefixes(platform: NodeJS.Platform): Array<string> {
  switch (platform) {
    case "darwin": {
      return ["/opt/homebrew", "/usr/local"]
    }
    case "linux": {
      return ["/usr/local", "/home/linuxbrew/.linuxbrew"]
    }
    default: {
      return []
    }
  }
}

function resolveContext(options: CatalogDetectOptions = {}): DetectContext {
  const opts = resolveOptions(options)
  return {
    ...opts,
    env: options.env ?? process.env,
    systemPrefixes:
      options.systemPrefixes ?? defaultSystemPrefixes(opts.platform),
    npmRegistry: options.npmRegistry,
  }
}

/** Every entry in a directory, symlinks included. */
function listEntries(dir: string): Array<string> {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** `<dir>/<version>/<...sub>` for each version directory (aliases that are
 *  symlinks, like mise's `22` or `latest`, are skipped). */
function versionsUnder(dir: string, ...sub: Array<string>): Array<string> {
  return listDirs(dir).map((version) => path.join(dir, version, ...sub))
}

/** npm reads `npm_config_<key>` from the environment, in any case. */
function npmEnv(ctx: DetectContext, key: string): string | undefined {
  const wanted = `npm_config_${key}`
  for (const [name, value] of Object.entries(ctx.env)) {
    if (value && name.toLowerCase() === wanted) return value
  }
  return undefined
}

/** `key=value` settings from an npmrc, `${VAR}` expanded; empty when the
 *  file is missing. */
function readNpmrc(
  file: string | undefined,
  ctx: DetectContext,
): Map<string, string> {
  const settings = new Map<string, string>()
  if (!file) return settings
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return settings
  }
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    const eq = line.indexOf("=")
    if (eq <= 0 || /^[;#[]/u.test(line)) continue
    let value = line.slice(eq + 1).trim()
    if (/^(["']).*\1$/u.test(value)) value = value.slice(1, -1)
    settings.set(
      line.slice(0, eq).trim(),
      value.replaceAll(
        /\$\{([^}]+)\}/gu,
        (match, name: string) => ctx.env[name] ?? match,
      ),
    )
  }
  return settings
}

function userNpmrc(ctx: DetectContext): string {
  return npmEnv(ctx, "userconfig") ?? path.join(ctx.home, ".npmrc")
}

/** npm's `prefix` setting (environment, then user npmrc), if absolute. */
function npmPrefixSetting(ctx: DetectContext): string | undefined {
  const value =
    npmEnv(ctx, "prefix") ?? readNpmrc(userNpmrc(ctx), ctx).get("prefix")
  if (!value) return undefined
  const expanded = value.replace(/^~(?=$|[/\\])/u, ctx.home)
  return path.isAbsolute(expanded) ? expanded : undefined
}

function appData(ctx: DetectContext): string {
  return ctx.env.APPDATA ?? path.join(ctx.home, "AppData", "Roaming")
}

function localAppData(ctx: DetectContext): string {
  return ctx.env.LOCALAPPDATA ?? path.join(ctx.home, "AppData", "Local")
}

function xdgDataHome(ctx: DetectContext): string {
  return ctx.env.XDG_DATA_HOME ?? path.join(ctx.home, ".local", "share")
}

/** fnm's base directories: FNM_DIR, else every location fnm has used. */
function fnmDirs(ctx: DetectContext): Array<string> {
  if (ctx.env.FNM_DIR) return [ctx.env.FNM_DIR]
  if (ctx.platform === "win32") return [path.join(appData(ctx), "fnm")]
  return [
    path.join(xdgDataHome(ctx), "fnm"),
    path.join(ctx.home, ".fnm"),
    ...(ctx.platform === "darwin" ?
      [path.join(ctx.home, "Library", "Application Support", "fnm")]
    : []),
  ]
}

/** Node install prefixes whose global packages npm puts under
 *  `lib/node_modules` (Unix) or `node_modules` (Windows). */
function nodeInstallRoots(ctx: DetectContext): Array<string> {
  const { env, home } = ctx
  const prefix = npmPrefixSetting(ctx)
  const roots = [
    ...(prefix ? [prefix] : []),
    ...ctx.systemPrefixes,
    path.join(home, ".npm-global"),
    ...(ctx.platform === "win32" ? [path.join(appData(ctx), "npm")] : []),
    ...versionsUnder(
      path.join(env.NVM_DIR ?? path.join(home, ".nvm"), "versions", "node"),
    ),
    ...fnmDirs(ctx).flatMap((dir) =>
      versionsUnder(path.join(dir, "node-versions"), "installation"),
    ),
    ...versionsUnder(
      path.join(
        env.ASDF_DATA_DIR ?? path.join(home, ".asdf"),
        "installs",
        "nodejs",
      ),
    ),
    // mise-managed Node, whose own `npm install -g` lands here.
    ...versionsUnder(path.join(ctx.miseDataDir, "installs", "node")),
  ]
  return [...new Set(roots)]
}

/** Volta installs each global package under its own npm prefix. */
function voltaPackageRoot(
  ctx: DetectContext,
  name: ReadonlyArray<string>,
): string {
  const home =
    ctx.env.VOLTA_HOME
    ?? (ctx.platform === "win32" ?
      path.join(localAppData(ctx), "Volta")
    : path.join(ctx.home, ".volta"))
  return path.join(home, "tools", "image", "packages", ...name)
}

function hasPackageUnder(root: string, name: ReadonlyArray<string>): boolean {
  return packageDirsUnder(root, name).some((dir) =>
    fs.existsSync(path.join(dir, "package.json")),
  )
}

/** npm is on PATH or ships with any Node install found. */
function npmFound(ctx: DetectContext): boolean {
  const names = ctx.platform === "win32" ? ["npm.cmd", "npm"] : ["npm"]
  const onPath = ctx.pathDirs.some((dir) =>
    names.some((name) => isExecutableFile(path.join(dir, name), ctx.platform)),
  )
  return (
    onPath
    || nodeInstallRoots(ctx).some((root) => hasPackageUnder(root, ["npm"]))
  )
}

/** pnpm's home, as pnpm itself picks it. */
function pnpmHome(ctx: DetectContext): string {
  if (ctx.env.PNPM_HOME) return ctx.env.PNPM_HOME
  if (ctx.env.XDG_DATA_HOME) return path.join(ctx.env.XDG_DATA_HOME, "pnpm")
  switch (ctx.platform) {
    case "darwin": {
      return path.join(ctx.home, "Library", "pnpm")
    }
    case "win32": {
      return path.join(localAppData(ctx), "pnpm")
    }
    default: {
      return path.join(ctx.home, ".local", "share", "pnpm")
    }
  }
}

/** pnpm's global projects: `global/5` (pnpm ≤10), and every project under
 *  `global/v11/` (pnpm ≥11, reached through hash-named symlinks). Their
 *  packages are symlinks into pnpm's store, resolved here. */
function pnpmGlobalPackageDirs(
  ctx: DetectContext,
  name: ReadonlyArray<string>,
): Array<string> {
  const global = path.join(pnpmHome(ctx), "global")
  const projects = listEntries(global).flatMap((layout) => {
    const dir = path.join(global, layout)
    return [dir, ...listEntries(dir).map((entry) => path.join(dir, entry))]
  })
  const found = new Set<string>()
  for (const project of projects) {
    try {
      found.add(fs.realpathSync(path.join(project, "node_modules", ...name)))
    } catch {
      // Not installed in this project.
    }
  }
  return [...found]
}

// ── Which registry an install downloads from ────────────────────────────

/** The global npmrc: npm's `globalconfig`, else `etc/npmrc` of the first
 *  Node install that ships npm. */
function globalNpmrc(ctx: DetectContext): string | undefined {
  const configured = npmEnv(ctx, "globalconfig")
  if (configured) return configured
  const root = nodeInstallRoots(ctx).find((dir) =>
    hasPackageUnder(dir, ["npm"]),
  )
  return root ? path.join(root, "etc", "npmrc") : undefined
}

/** The registry npm, pnpm, and mise's npm backend fetch a package of
 *  `scope` from, or undefined when nothing confirms one. Maximal's own
 *  setting comes first (it changes the command, so it is authoritative);
 *  then what npm itself reports from the user's login environment (the
 *  scope's registry, then the plain one); then, as a fallback, npm's own
 *  order read from files and this process's environment: a
 *  `<scope>:registry` from any npmrc wins over every plain `registry`, which
 *  come from the environment, the user npmrc, then the global npmrc. */
function effectiveRegistry(
  ctx: DetectContext,
  scope: string,
): string | undefined {
  const user = readNpmrc(userNpmrc(ctx), ctx)
  const global = readNpmrc(globalNpmrc(ctx), ctx)
  const scoped = `${scope}:registry`
  const candidates = [
    ctx.npmRegistry,
    ctx.npmLogin?.scopeRegistry,
    ctx.npmLogin?.registry,
    user.get(scoped),
    global.get(scoped),
    npmEnv(ctx, "registry"),
    user.get("registry"),
    global.get("registry"),
  ]
  return candidates.find(Boolean) ?? undefined
}

/** What the user is shown: just the host. */
function registryHost(registry: string): string {
  try {
    return new URL(registry).host || registry
  } catch {
    return registry
  }
}

function registryOrNull(registry: string | undefined): string | null {
  return registry ? registryHost(registry) : null
}

/** Quoted for a POSIX shell unless it's plainly safe. */
function shellArg(value: string): string {
  return /^[\w%+,./:=@-]+$/u.test(value) ? value : (
      `'${value.replaceAll("'", String.raw`'\''`)}'`
    )
}

type PackageManager = "mise" | "pnpm" | "npm"

/** Whichever way this machine installs tools; detection finds each. mise
 *  when it manages tools here; pnpm when it has global installs and npm
 *  can't be found; npm otherwise. */
function preferredPackageManager(ctx: DetectContext): PackageManager {
  if (usesMise(ctx)) return "mise"
  if (fs.existsSync(path.join(pnpmHome(ctx), "global")) && !npmFound(ctx)) {
    return "pnpm"
  }
  return "npm"
}

/** `spec` installed globally, from `registry` when one is set. */
function globalInstallCommand(
  manager: PackageManager,
  spec: string,
  registry: string | undefined,
): string {
  const flag = registry ? ` --registry ${shellArg(registry)}` : ""
  switch (manager) {
    case "mise": {
      const env = registry ? `NPM_CONFIG_REGISTRY=${shellArg(registry)} ` : ""
      return `${env}mise use -g npm:${spec}`
    }
    case "pnpm": {
      return `pnpm add -g ${spec}${flag}`
    }
    case "npm": {
      return `npm install -g ${spec}${flag}`
    }
    default: {
      manager satisfies never
      return `npm install -g ${spec}${flag}`
    }
  }
}

// ── Work IQ in those places ─────────────────────────────────────────────

/** The version range the install hint and docs/linux-workiq.md install.
 *  Pinned to the major version because detection relies on the package's
 *  internal layout (`bin/<os>-<arch>/workiq`). */
export const WORKIQ_PACKAGE_SPEC = `${WORKIQ_PACKAGE.join("/")}@1`

/** npm global installs into any Node found outside PATH, and Volta's. */
function fromNodeInstalls(ctx: DetectContext): Array<CatalogInstall> {
  const roots = [
    ...nodeInstallRoots(ctx),
    voltaPackageRoot(ctx, WORKIQ_PACKAGE),
  ]
  return roots.flatMap((root) => {
    for (const dir of packageDirsUnder(root)) {
      const found = workiqExecutable(dir, ctx)
      if (found) return [found]
    }
    return []
  })
}

function fromPnpm(ctx: DetectContext): Array<CatalogInstall> {
  return pnpmGlobalPackageDirs(ctx, WORKIQ_PACKAGE).flatMap((dir) => {
    const found = workiqExecutable(dir, ctx)
    return found ? [found] : []
  })
}

const workiq: McpCatalogEntry = {
  id: "workiq",
  label: "Work IQ",
  install(options) {
    const ctx = resolveContext(options)
    return {
      command: globalInstallCommand(
        preferredPackageManager(ctx),
        WORKIQ_PACKAGE_SPEC,
        ctx.npmRegistry,
      ),
      url: "https://www.npmjs.com/package/@microsoft/workiq",
      registry: registryOrNull(effectiveRegistry(ctx, WORKIQ_PACKAGE[0])),
    }
  },
  locate(options) {
    const ctx = resolveContext(options)
    return newestInstall([
      ...fromMise(ctx),
      fromPath(ctx),
      fromNpmGlobal(ctx),
      ...fromNodeInstalls(ctx),
      ...fromPnpm(ctx),
    ])
  },
  template(install, options) {
    const platform = options?.platform ?? process.platform
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
      // Work IQ's Linux token cache uses libsecret on the user's session
      // bus. Without its address, headless broker children cannot read the
      // tokens saved by an interactive login. Inherit the address by name;
      // never persist a machine-specific value or pass the full environment.
      environment: {
        inherit:
          platform === "linux" ?
            ["HOME", "DBUS_SESSION_BUS_ADDRESS"]
          : ["HOME"],
      },
    }
  },
}

export const MCP_CATALOG: ReadonlyArray<McpCatalogEntry> = [workiq]

export function findCatalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((entry) => entry.id === id)
}
