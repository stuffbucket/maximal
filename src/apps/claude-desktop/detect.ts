import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const CLAUDE_APP_PATH = "/Applications/Claude.app"

export interface ClaudeDesktopInstallation {
  path: string
  version: null
  source: "unknown"
}

/**
 * Candidate Claude Desktop install locations to probe, per platform.
 */
export function claudeAppCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): Array<string> {
  if (platform === "darwin") return [CLAUDE_APP_PATH]
  if (platform === "win32") {
    const localAppData = windowsLocalAppData(home)
    return [
      path.join(localAppData, "AnthropicClaude"),
      path.join(localAppData, "Microsoft", "WindowsApps", "Claude.exe"),
      path.join(localAppData, "Packages", "Claude_pzs8sxrjxfjjc"),
    ]
  }
  return []
}

/** `%LOCALAPPDATA%`, or its default location under `home` when unset. */
export function windowsLocalAppData(home: string): string {
  return process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")
}

/**
 * MSIX package family names mutate (`Claude_<publisherhash>`,
 * `AnthropicPBC.Claude_<hash>`), so an exact path can't catch every install.
 */
export function windowsMsixClaudeInstalled(home: string): boolean {
  const packages = path.join(windowsLocalAppData(home), "Packages")
  try {
    return fs
      .readdirSync(packages)
      .some(
        (name) =>
          name.startsWith("Claude_") || name.startsWith("AnthropicPBC.Claude"),
      )
  } catch {
    return false
  }
}

export function detectClaudeAppInstallations(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): Array<ClaudeDesktopInstallation> {
  const paths = claudeAppCandidates(platform, home).filter((candidate) => {
    try {
      fs.statSync(candidate)
      return true
    } catch {
      return false
    }
  })
  if (platform === "win32") {
    const packages = path.join(windowsLocalAppData(home), "Packages")
    try {
      for (const name of fs.readdirSync(packages)) {
        if (
          (name.startsWith("Claude_") || name.startsWith("AnthropicPBC.Claude"))
          && !paths.includes(path.join(packages, name))
        ) {
          paths.push(path.join(packages, name))
        }
      }
    } catch {
      // No package directory.
    }
  }
  return paths.map((installPath) => ({
    path: installPath,
    version: null,
    source: "unknown",
  }))
}

/**
 * Is Claude Desktop installed? Real check on macOS and Windows; on any
 * other platform we can't tell, so return true (don't block).
 */
export function claudeAppInstalled(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): boolean {
  const candidates = claudeAppCandidates(platform, home)
  if (candidates.length === 0) return true
  return detectClaudeAppInstallations(platform, home).length > 0
}
