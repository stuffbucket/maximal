import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const CLAUDE_APP_PATH = "/Applications/Claude.app"

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
  const hasCandidate = candidates.some((p) => {
    try {
      fs.statSync(p)
      return true
    } catch {
      return false
    }
  })
  if (hasCandidate) return true
  if (platform === "win32") return windowsMsixClaudeInstalled(home)
  return false
}
