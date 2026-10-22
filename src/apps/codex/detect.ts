import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type CodexInstallationKind = "cli" | "desktop"

export interface CodexInstallation {
  kind: CodexInstallationKind
  path: string
  version: string | null
}

export interface DetectCodexOptions {
  platform?: NodeJS.Platform
  pathEnv?: string
  homeDir?: string
  appDataDir?: string
  applicationDirs?: Array<string>
}

function resolveCliArtifact(
  candidate: string,
  platform: NodeJS.Platform,
): { path: string; realPath: string } | null {
  let stat: fs.Stats
  let realPath: string
  try {
    stat = fs.lstatSync(candidate)
    realPath = fs.realpathSync(candidate)
    if (!fs.statSync(realPath).isFile()) return null
  } catch {
    return null
  }
  if (platform !== "win32") {
    try {
      fs.accessSync(realPath, fs.constants.X_OK)
    } catch {
      return null
    }
  }
  return {
    path: stat.isSymbolicLink() ? realPath : candidate,
    realPath,
  }
}

function cliDirectories(
  options: DetectCodexOptions,
  platform: NodeJS.Platform,
  homeDir: string,
): Array<string> {
  const separator = platform === "win32" ? ";" : ":"
  const directories = (options.pathEnv ?? process.env.PATH ?? "")
    .split(separator)
    .filter((entry) => entry.length > 0)
  directories.push(
    path.join(homeDir, ".local", "bin"),
    path.join(homeDir, ".npm-global", "bin"),
  )
  if (options.pathEnv === undefined && options.homeDir === undefined) {
    directories.push("/opt/homebrew/bin", "/usr/local/bin")
  }
  const appDataDir = options.appDataDir ?? process.env.APPDATA
  if (appDataDir) directories.push(path.join(appDataDir, "npm"))
  return directories
}

function detectCliInstallations(
  directories: Array<string>,
  platform: NodeJS.Platform,
  seen: Set<string>,
): Array<CodexInstallation> {
  const names = platform === "win32" ? ["codex.exe", "codex.cmd"] : ["codex"]
  const installations: Array<CodexInstallation> = []
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.resolve(directory, name)
      const resolved = resolveCliArtifact(candidate, platform)
      if (!resolved || seen.has(resolved.realPath)) continue
      seen.add(resolved.realPath)
      installations.push({ kind: "cli", path: resolved.path, version: null })
    }
  }
  return installations
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.lstatSync(candidate).isDirectory()
  } catch {
    return false
  }
}

function detectDesktopInstallations(
  directories: Array<string>,
  seen: Set<string>,
): Array<CodexInstallation> {
  const installations: Array<CodexInstallation> = []
  for (const directory of directories) {
    for (const bundleName of ["Codex.app", "ChatGPT.app"]) {
      const bundle = path.resolve(directory, bundleName)
      const resource = path.join(bundle, "Contents", "Resources", "codex")
      if (
        seen.has(bundle)
        || !isDirectory(bundle)
        || !resolveCliArtifact(resource, "darwin")
      ) {
        continue
      }
      seen.add(bundle)
      installations.push({ kind: "desktop", path: bundle, version: null })
    }
  }
  return installations
}

export function detectCodexInstallations(
  options: DetectCodexOptions = {},
): Array<CodexInstallation> {
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? os.homedir()
  const seen = new Set<string>()
  const installations = detectCliInstallations(
    cliDirectories(options, platform, homeDir),
    platform,
    seen,
  )
  if (platform !== "darwin") return installations

  const applicationDirs = options.applicationDirs ?? [
    "/Applications",
    path.join(homeDir, "Applications"),
  ]
  return [
    ...installations,
    ...detectDesktopInstallations(applicationDirs, seen),
  ]
}
